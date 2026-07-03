import * as dotenv from 'dotenv';
import * as fs    from 'fs';
import { RSI, EMA, ADX, ATR } from 'technicalindicators';
import { generateSignals, getSession, detectRegime, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators, GeneratedSignal } from './signals.js';
import { startVelocityMonitor, getVelocityState } from './velocityMonitor.js';
import {
    loadBankroll, saveBankroll, applyTradeResult as bankrollApply,
    getCurrentMargin, bankrollSummary,
} from './symbolBankroll.js';
import type { SymbolBankroll } from './symbolBankroll.js';
import { checkKillSwitch, analyseFailedTrade } from './geminiAdvisor.js';
import {
    executeBinanceTrade,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    isEntryInProgress,
    triggerEmergencyClose,
    cancelAllOrders,
    getRealizedPnlSince,
    sendAlert,
    getAvailableBalance,
    hasOpenOrders,
    transferBankedToSpot,
    ASSET_TIMING,
} from './executeTrade.js';

dotenv.config();

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

// Per-asset timing (from executeTrade getConfig, NOT env): loss cooldown + the
// time-stop — if the TP hasn't filled within maxHoldMs, the scalp thesis failed.
const { lossCooldownMs: LOSS_COOLDOWN_MS, maxHoldMs: MAX_HOLD_MS } = ASSET_TIMING;

// Below this available balance, stop trying to trade (don't force doomed orders).
const MIN_STACK = Number(process.env.MIN_STACK ?? 0.60);
// Binance min order notional (matches executeTrade STRATEGY.MIN_NOTIONAL).
const STRATEGY_MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL ?? 5);

// ─── PER-SYMBOL STATE ─────────────────────────────────────────────────────────
const _symbol   = process.env.MARKET_SYMBOL ?? 'XAUUSDT';
const startTime = Date.now();
let _bankroll: SymbolBankroll | null = null;
function getStack():  number { return _bankroll?.stack  ?? 0; }
function getBanked(): number { return _bankroll?.banked ?? 0; }

// ─── DAILY STATS ──────────────────────────────────────────────────────────────
interface DayStats {
    date: string; fills: number; tpHits: number; slHits: number;
    skipped: number; grossProfit: number; netProfit: number; slLoss: number;
}
let stats: DayStats = freshStats();
function freshStats(): DayStats {
    return { date: new Date().toISOString().slice(0, 10), fills: 0, tpHits: 0,
             slHits: 0, skipped: 0, grossProfit: 0, netProfit: 0, slLoss: 0 };
}

// ─── STATE PERSISTENCE ────────────────────────────────────────────────────────
function saveState(): void {
    try {
        if (_bankroll) saveBankroll(_bankroll);
        const sf = `./stats-${_symbol}.json`;
        fs.writeFileSync(sf, JSON.stringify({ stats, savedAt: new Date().toISOString() }, null, 2));
    } catch (e: any) { console.error(`[State] Save failed: ${e.message}`); }
}

function loadState(): void {
    _bankroll = loadBankroll(_symbol);
    if (!_bankroll) {
        console.error(`[${_symbol}] ❌ No bankroll — start with multiSymbol.ts`);
        process.exit(1);
    }
    if (_bankroll.paused) {
        console.log(`[${_symbol}] ⛔ Paused: ${_bankroll.pausedReason}`);
        process.exit(0);
    }
    console.log(`[${_symbol}] Bankroll: stack=$${_bankroll.stack.toFixed(4)} banked=$${_bankroll.banked.toFixed(4)}`);
    try {
        const sf = `./stats-${_symbol}.json`;
        if (fs.existsSync(sf)) {
            const raw = JSON.parse(fs.readFileSync(sf, 'utf-8'));
            if (raw.stats?.date === new Date().toISOString().slice(0, 10)) stats = raw.stats;
        }
    } catch { /* start fresh */ }
}

// ─── DAY ROLLOVER ─────────────────────────────────────────────────────────────
function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) {
        printDailySummary();
        sendAlert(`📊 ${_symbol} ${stats.date}: ${stats.fills} trades | ${stats.tpHits}TP/${stats.slHits}SL | net $${stats.netProfit.toFixed(4)} | ${_bankroll ? bankrollSummary(_bankroll) : ''}`);
        stats = freshStats();
        saveState();
    }
}

function printDailySummary(): void {
    const wr     = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    const uptime = ((Date.now() - startTime) / 3_600_000).toFixed(1);
    console.log(`\n${'█'.repeat(70)}`);
    console.log(`📊 ${_symbol} DAILY — ${stats.date} (${uptime}h)`);
    console.log(`Trades: ${stats.fills} | WR: ${wr}% | Skip: ${stats.skipped}`);
    console.log(`Net: $${stats.netProfit.toFixed(4)} | SL Loss: -$${stats.slLoss.toFixed(4)}`);
    if (_bankroll) console.log(bankrollSummary(_bankroll));
    console.log(`${'█'.repeat(70)}\n`);
}

// ─── BANKING ENGINE ───────────────────────────────────────────────────────────
// Sweep banked profit to Spot only once it's worth moving (no tiny transfers).
const BANK_TRANSFER_MIN = Number(process.env.BANK_TRANSFER_MIN ?? 5);

async function applyTradeResult(realizedPnl: number): Promise<void> {
    if (!_bankroll) return;
    const { updated, shouldPause } = bankrollApply(_bankroll, realizedPnl);
    _bankroll = updated;
    if (realizedPnl > 0) { stats.grossProfit += realizedPnl; stats.netProfit += realizedPnl; }
    else { stats.netProfit += realizedPnl; stats.slLoss += Math.abs(realizedPnl); }

    // Once the un-swept banked pile crosses the threshold, physically move it to
    // Spot (out of the futures wallet entirely). Below threshold it just sits in
    // the wallet, already protected by isolated margin.
    const inWallet = _bankroll.banked - (_bankroll.transferred ?? 0);
    if (inWallet >= BANK_TRANSFER_MIN) {
        const ok = await transferBankedToSpot(inWallet);
        if (ok) {
            _bankroll.transferred = (_bankroll.transferred ?? 0) + inWallet;
            saveBankroll(_bankroll);
            await sendAlert(`🏦 ${_symbol} swept $${inWallet.toFixed(2)} banked → Spot (safe). Total banked: $${_bankroll.banked.toFixed(2)}`);
        }
    }

    if (shouldPause) {
        await sendAlert(`⛔ ${_symbol} PAUSED — stack $${_bankroll.stack.toFixed(4)} < $0.60 | Banked (safe): $${_bankroll.banked.toFixed(4)}`);
    }
}

// ─── TRADE LOGGER ─────────────────────────────────────────────────────────────
const TRADE_LOG_FILE  = process.env.TRADE_LOG_FILE ?? `./tradeLog-${_symbol}.jsonl`;
const _openLogEntries = new Map<string, any>();

function buildCandleSummary(k: any[]): any[] {
    return k.slice(-5).map((c: any) => {
        const [o, h, l, cl] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])];
        const range = h - l; const body = Math.abs(cl - o);
        const bp = range > 0 ? body / range : 0;
        return { open: o, high: h, low: l, close: cl, volume: Number(c[5]),
                 direction: bp < 0.15 ? 'doji' : cl >= o ? 'bull' : 'bear',
                 range: +range.toFixed(4), bodyPct: +bp.toFixed(2) };
    });
}

function buildLargestMoves(k: any[]): any {
    const last20 = k.slice(-20);
    let bull = { range: 0, volume: 0, minsAgo: 0 };
    let bear = { range: 0, volume: 0, minsAgo: 0 };
    last20.forEach((c: any, i: number) => {
        const o = Number(c[1]), h = Number(c[2]), l = Number(c[3]), cl = Number(c[4]);
        const range = h - l; const minsAgo = (last20.length - 1 - i) * 5;
        if (cl > o && range > bull.range) bull = { range: +range.toFixed(4), volume: +Number(c[5]).toFixed(4), minsAgo };
        if (cl < o && range > bear.range) bear = { range: +range.toFixed(4), volume: +Number(c[5]).toFixed(4), minsAgo };
    });
    return { largestBull: bull, largestBear: bear };
}

function logTradeEntry(
    id: string, signal: GeneratedSignal, md: MarketData,
    entryPrice: number, tpPrice: number, slPrice: number,
    klines: any[], rawBids: string[][], rawAsks: string[][],
): void {
    const ind     = md.indicators;
    const session = getSession();
    const topBids = rawBids.slice(0, 5).map(b => ({ price: +b[0], notionalUsd: Math.round(+b[0] * +b[1]) }));
    const topAsks = rawAsks.slice(0, 5).map(a => ({ price: +a[0], notionalUsd: Math.round(+a[0] * +a[1]) }));
    const { largestBull, largestBear } = buildLargestMoves(klines);
    const entry = {
        id, phase: 'entry', symbol: md.symbol, direction: signal.direction,
        entrySignalAt: new Date().toISOString(), entryPrice, tpPrice, slPrice,
        tpMove: +Math.abs(tpPrice - entryPrice).toFixed(4),
        slMove: +Math.abs(slPrice - entryPrice).toFixed(4),
        spotPrice: md.price, bid: md.bid, ask: md.ask,
        spread: +ind.spreadUsd.toFixed(3), atr5m: +ind.atr5m.toFixed(4),
        rsi: +ind.rsi.toFixed(1), adx: +ind.adx.toFixed(1),
        obImbalance: +ind.obImbalance.toFixed(3),
        momentum5m: +ind.momentum5m.toFixed(4), momentum30m: +ind.momentum30m.toFixed(4),
        volumeRatio: +ind.volumeRatio.toFixed(2), priceVsVwap: +ind.priceVsVwap.toFixed(3),
        fundingRate: ind.fundingRate ?? 0, regime: md.regime,
        session: session.name, sessionQuality: session.quality,
        signalReason: signal.reasoning,
        topBids, topAsks, bidWalls: md.orderBook.bidWalls, askWalls: md.orderBook.askWalls,
        last5Candles: buildCandleSummary(klines), largestBull, largestBear,
    };
    _openLogEntries.set(id, entry);
    try { fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(entry) + '\n'); } catch { /* non-critical */ }
    console.log(`[TradeLog] 📝 ${signal.direction.toUpperCase()} @ $${entryPrice} | TP=$${tpPrice} SL=$${slPrice} | OB=${(ind.obImbalance*100).toFixed(0)}%`);
}

function logTradeClose(
    id: string, outcome: string, closePrice: number, pnl: number,
    exitPhase: string, tp2: boolean, scratch: boolean, p1Timeout?: number,
): void {
    const entry = _openLogEntries.get(id);
    if (!entry) {
        try { fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify({ id, phase: 'closed', outcome, closePrice, pnl, closedAt: new Date().toISOString() }) + '\n'); } catch {}
        return;
    }
    const durationMs  = Date.now() - new Date(entry.entrySignalAt).getTime();
    const adverseMove = entry.direction === 'long'
        ? Math.max(0, entry.entryPrice - closePrice)
        : Math.max(0, closePrice - entry.entryPrice);
    let note = outcome === 'tp'
        ? (exitPhase === 'tp2' ? 'TP2 rescue filled.' : `TP1 filled in ${(durationMs/1000).toFixed(0)}s.`)
        : scratch ? `Scratched. Adverse $${adverseMove.toFixed(4)}.`
        : `SL triggered. Adverse $${adverseMove.toFixed(4)}.`;
    const closed = { ...entry, phase: 'closed', outcome, closePrice, pnl,
        durationMs, exitPhase, closedAt: new Date().toISOString(),
        tp2Triggered: tp2, scratchTriggered: scratch,
        postMortem: { adverseMove: +adverseMove.toFixed(4), priceAtTp1Timeout: p1Timeout ?? null, note } };
    try { fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(closed) + '\n'); } catch {}
    _openLogEntries.delete(id);
    const emoji = outcome === 'tp' ? '✅' : outcome === 'sl' ? '🔴' : '⏱';
    console.log(`[TradeLog] ${emoji} ${outcome.toUpperCase()} | PnL: $${pnl.toFixed(4)} | ${(durationMs/1000).toFixed(0)}s | ${note}`);
}

// ─── MARKET DATA INGESTION ────────────────────────────────────────────────────
let _lastKlines:  any[] = [];
let _lastRawBook: { bids: string[][]; asks: string[][] } = { bids: [], asks: [] };
const _oiHistory: Array<{ ts: number; oi: number }> = [];   // rolling open-interest samples (~6min)

async function buildLiveMarketData(symbol: string): Promise<MarketData[]> {
    interface BinanceTicker { lastPrice: string; highPrice: string; lowPrice: string; priceChangePercent: string; }
    interface BinanceDepth  { bids: string[][]; asks: string[][]; }
    type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

    const [tickerRes, bookRes, klinesRes] = await Promise.all([
        fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json() as Promise<BinanceTicker>),
        fetch(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`).then(r => r.json() as Promise<BinanceDepth>),
        fetch(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`).then(r => r.json() as Promise<BinanceKline[]>),
    ]);

    _lastKlines  = klinesRes;
    _lastRawBook = { bids: bookRes.bids, asks: bookRes.asks };

    const currentPrice = Number(tickerRes.lastPrice);
    const topBid       = Number(bookRes.bids[0][0]);
    const topAsk       = Number(bookRes.asks[0][0]);
    const spreadUsd    = topAsk - topBid;

    const bidNot = bookRes.bids.slice(0, 10).reduce((s: number, v: string[]) => s + Number(v[0]) * Number(v[1]), 0);
    const askNot = bookRes.asks.slice(0, 10).reduce((s: number, v: string[]) => s + Number(v[0]) * Number(v[1]), 0);
    const totNot = bidNot + askNot;
    const obImbalance = totNot === 0 ? 0 : (bidNot - askNot) / totNot;

    // Top-of-book (best 3 levels) imbalance — the next-tick predictor for tiny TPs.
    const bidTop3 = bookRes.bids.slice(0, 3).reduce((s: number, v: string[]) => s + Number(v[0]) * Number(v[1]), 0);
    const askTop3 = bookRes.asks.slice(0, 3).reduce((s: number, v: string[]) => s + Number(v[0]) * Number(v[1]), 0);
    const topObImbalance = (bidTop3 + askTop3) === 0 ? 0 : (bidTop3 - askTop3) / (bidTop3 + askTop3);

    const highs   = klinesRes.map((c: any) => Number(c[2]));
    const lows    = klinesRes.map((c: any) => Number(c[3]));
    const closes  = klinesRes.map((c: any) => Number(c[4]));
    const volumes = klinesRes.map((c: any) => Number(c[5]));

    const rsi        = RSI.calculate({ values: closes, period: 14 }).pop() ?? 50;
    const ema50      = EMA.calculate({ values: closes, period: 50 }).pop() ?? currentPrice;
    const adx        = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop()?.adx ?? 25;
    const atr5m      = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop() ?? 1.0;
    const momentum5m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
    const avgVol     = volumes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
    const volRatio   = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1.0;

    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < klinesRes.length; i++) {
        cumPV  += ((highs[i] + lows[i] + closes[i]) / 3) * volumes[i];
        cumVol += volumes[i];
    }
    const vwap        = cumVol > 0 ? cumPV / cumVol : currentPrice;
    const priceVsVwap = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

    let fundingRate = 0;
    try {
        const prem = await fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.json()) as any;
        fundingRate = Number(prem?.lastFundingRate ?? 0);
    } catch { /* non-critical */ }

    // Open interest — rolling ~5min history to detect new money piling in.
    let oiChangePct = 0;
    try {
        const oiRes = await fetch(`${BASE_URL}/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.json()) as any;
        const oi = Number(oiRes?.openInterest ?? 0);
        if (oi > 0) {
            const now = Date.now();
            _oiHistory.push({ ts: now, oi });
            while (_oiHistory.length > 0 && _oiHistory[0].ts < now - 6 * 60_000) _oiHistory.shift();
            const oldest = _oiHistory[0];
            if (oldest && oldest.oi > 0 && now - oldest.ts >= 60_000) {
                oiChangePct = ((oi - oldest.oi) / oldest.oi) * 100;
            }
        }
    } catch { /* non-critical */ }

    const swingHigh = Math.max(...highs.slice(-20));
    const swingLow  = Math.min(...lows.slice(-20));
    const emaTrend  = currentPrice > ema50 ? 'bullish' : 'bearish';

    const { regime, reason: regimeReason } = detectRegime(closes, atr5m);
    if (regime !== 'normal') console.log(`[Regime] ⚠️  ${regimeReason}`);

    const liveIndicators: TechnicalIndicators = {
        emaTrend, ema8: currentPrice, ema21: currentPrice, ema50, rsi,
        momentum5m, momentum30m: momentum5m * 6, momentum1h: momentum5m * 12,
        priceStructure: emaTrend === 'bullish' ? 'uptrend' : 'downtrend',
        trendBias4h: emaTrend === 'bullish' ? 'bull' : 'bear', weeklyBias: 'neutral',
        atr5m, atrPct: atr5m / currentPrice, volumeRatio: volRatio,
        nearestResistance: swingHigh, nearestSupport: swingLow,
        distanceToResistance: Math.abs(swingHigh - currentPrice),
        distanceToSupport:    Math.abs(currentPrice - swingLow),
        high24h: Number(tickerRes.highPrice), low24h: Number(tickerRes.lowPrice),
        adx, fundingRate, spreadUsd, obImbalance, topObImbalance, oiChangePct, priceVsVwap,
        recentSwingHigh: swingHigh, recentSwingLow: swingLow,
    };

    const WALL_THRESHOLD = 20_000;
    const bidWalls = bookRes.bids
        .map((l: string[]) => ({ price: Number(l[0]), notionalUsd: Number(l[0]) * Number(l[1]) }))
        .filter((w: any) => w.notionalUsd >= WALL_THRESHOLD);
    const askWalls = bookRes.asks
        .map((l: string[]) => ({ price: Number(l[0]), notionalUsd: Number(l[0]) * Number(l[1]) }))
        .filter((w: any) => w.notionalUsd >= WALL_THRESHOLD);

    if (bidWalls.length > 0 || askWalls.length > 0) {
        const bt = bidWalls[0] ? `top@$${bidWalls[0].price.toFixed(2)} $${(bidWalls[0].notionalUsd/1000).toFixed(0)}K` : 'none';
        const at = askWalls[0] ? `top@$${askWalls[0].price.toFixed(2)} $${(askWalls[0].notionalUsd/1000).toFixed(0)}K` : 'none';
        console.log(`[Book] Walls — bids: ${bidWalls.length} ${bt} | asks: ${askWalls.length} ${at}`);
    }

    return [{
        symbol: DISPLAY_SYMBOL, price: currentPrice, bid: topBid, ask: topAsk,
        change_24h: Number(tickerRes.priceChangePercent),
        indicators: liveIndicators, regime, regimeReason,
        orderBook: { bidWalls, askWalls }, klines: klinesRes,
    }];
}

// ─── POSITION HEALTH CHECK ────────────────────────────────────────────────────
// Maker-only exits: a position rides on its resting maker TP + maker SL stop-limit
// until one fills, or liquidation if the SL gaps. No taker timeout/scratch/fail-safe.
let _currentTradeId: string | null = null;
let _lastLossAt = 0;
let _closeInProgress = false;   // guards against runCycle + watchdog double-processing a close

async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    let   pos   = await getOpenPositionDetails();
    const trade = getActiveTrade();

    // ── Orphan safety net ─────────────────────────────────────────────────────
    // A position with no active trade object (e.g. after a restart). If it still
    // has a resting maker TP, it's fine — let it ride to TP. Only a TRULY naked
    // position (no orders at all) gets recovered with a maker close. Skip while an
    // entry is mid-flight (guarded by _entryInProgress).
    if (pos.exists && !trade && !isEntryInProgress()) {
        if (await hasOpenOrders()) {
            return 'open';   // has a resting TP — let it ride
        }
        console.error(`[Health] 🛑 NAKED ${pos.side} position ${pos.size} (no TP) — maker recover`);
        await sendAlert(`🛑 ${_symbol} naked position (no TP) — maker close ${pos.side} ${pos.size}`);
        await triggerEmergencyClose(pos.side as 'long' | 'short', pos.size, 'naked position recovery');
        return 'none';
    }

    // ── Phantom-close guard ───────────────────────────────────────────────────
    // A single empty positionRisk read can be a transient API blip. If we acted on
    // it we'd cancel our own live TP/SL and orphan the position. Re-confirm flat.
    if (!pos.exists && trade) {
        await new Promise(r => setTimeout(r, 1_200));
        pos = await getOpenPositionDetails();
        if (pos.exists) return 'open';   // false alarm — still in the trade
        // While we slept, another handler may have fully processed this close and
        // cleared the trade. Our local `trade` would be a stale reference — using it
        // would apply the PnL a second time (the 585/591 double-count).
        if (getActiveTrade() !== trade) return 'none';
    }

    if (!pos.exists) {
        if (trade) {
            // Guard: only ONE handler (runCycle or the 2s watchdog) may process this
            // close — otherwise the PnL gets applied twice (the double-count bug).
            if (_closeInProgress) return 'none';
            _closeInProgress = true;
            try {
                const real = await getRealizedPnlSince(trade.openedAt - 2_000);
                if (real) {
                    const outcome = real.pnl >= 0 ? 'tp' : 'sl';
                    if (outcome === 'tp') stats.tpHits++; else { stats.slHits++; _lastLossAt = Date.now(); }
                    stats.fills++;
                    await applyTradeResult(real.pnl);
                    await cancelAllOrders(trade.slOrderId);
                    if (_currentTradeId) {
                        logTradeClose(_currentTradeId, outcome, pos.currentPrice, real.pnl, 'tp1', false, false);
                        // Gemini post-mortem on SL hits
                        if (outcome === 'sl') {
                            try {
                                const lines = fs.readFileSync(TRADE_LOG_FILE, 'utf-8')
                                    .split('\n').filter(l => l.trim() && l.includes(_currentTradeId!));
                                const logEntry = lines.length ? JSON.parse(lines[lines.length - 1]) : {};
                                analyseFailedTrade(logEntry, sendAlert).catch(() => {});
                            } catch { /* non-critical */ }
                        }
                        _currentTradeId = null;
                    }
                    clearActiveTrade();
                    console.log(`[Health] ${outcome.toUpperCase()} | PnL: $${real.pnl.toFixed(4)}`);
                    const killed = await checkKillSwitch(real.pnl, sendAlert);
                    if (killed) process.exit(0);
                    return outcome;
                }
                await cancelAllOrders(trade.slOrderId);
                if (_currentTradeId) {
                    logTradeClose(_currentTradeId, 'unknown', pos.currentPrice, 0, 'unknown', false, false);
                    _currentTradeId = null;
                }
                clearActiveTrade();
                await sendAlert(`⚠️ ${_symbol} position closed, PnL unverifiable. Check Binance.`);
                return 'none';
            } finally {
                _closeInProgress = false;
            }
        }
        return 'none';
    }

    if (!trade) return 'open';

    // ── Time-stop ─────────────────────────────────────────────────────────────
    // The scalp thesis is "TP fills in seconds-to-minutes". If it hasn't filled
    // after maxHoldMs, the thesis failed — scratch NOW at a small loss instead of
    // sitting 72 minutes underwater waiting for a reversal that may never come
    // (or the -50%-margin stop). Maker close first, market fallback.
    const ageMs = Date.now() - trade.openedAt;
    if (ageMs >= MAX_HOLD_MS) {
        if (_closeInProgress) return 'open';
        _closeInProgress = true;
        try {
            console.log(`[TimeStop] ⏱ ${(ageMs / 60_000).toFixed(1)}min without TP — scratching`);
            await cancelAllOrders(trade.slOrderId);
            await triggerEmergencyClose(trade.side, trade.size, `time-stop ${(ageMs / 60_000).toFixed(0)}min`);
            const real = await getRealizedPnlSince(trade.openedAt - 2_000);
            const pnl  = real ? real.pnl : 0;
            const outcome = pnl >= 0 ? 'tp' : 'sl';
            if (outcome === 'tp') stats.tpHits++; else { stats.slHits++; _lastLossAt = Date.now(); }
            stats.fills++;
            await applyTradeResult(pnl);
            if (_currentTradeId) {
                logTradeClose(_currentTradeId, outcome, pos.currentPrice, pnl, 'timestop', false, true);
                _currentTradeId = null;
            }
            clearActiveTrade();
            await sendAlert(`⏱ ${_symbol} time-stop @ ${(ageMs / 60_000).toFixed(0)}min | ${trade.side.toUpperCase()} | PnL: $${pnl.toFixed(4)}`);
            return outcome;
        } finally {
            _closeInProgress = false;
        }
    }

    // Otherwise the position rests on its maker TP + stop-market SL.
    return 'open';
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
    checkReset();
    try {
        const health = await checkPositionHealth();
        if (health === 'tp' || health === 'sl') { saveState(); return; }
        if (health === 'open') return;

        // Reload bankroll each cycle
        _bankroll = loadBankroll(_symbol);
        if (!_bankroll || _bankroll.paused) return;

        // Loss cooldown (per-asset)
        if (Date.now() - _lastLossAt < LOSS_COOLDOWN_MS) {
            console.log(`[${_symbol}] ⏸ Cooldown: ${Math.ceil((LOSS_COOLDOWN_MS-(Date.now()-_lastLossAt))/1000)}s`);
            return;
        }

        const assets   = await buildLiveMarketData(MARKET_SYMBOL);
        const velocity = getVelocityState();
        const signals  = await generateSignals(assets, velocity);
        const signal   = signals[0];
        const asset    = assets[0];

        console.log(`[Heartbeat] ${signal.reasoning} | Stack: $${getStack().toFixed(4)} | Banked: $${getBanked().toFixed(4)}`);

        if (signal.direction === 'neutral') { stats.skipped++; return; }

        // Size the trade to REAL available balance. Deploy the stack, but never more
        // than ~98% of free balance (buffer), and skip only if we can't meet the
        // exchange's $5 min-notional. (Using literally 100% would deadlock since
        // available is always a hair below the stack.)
        const avail    = await getAvailableBalance();
        const leverage = Number(process.env.BOT_LEVERAGE ?? 100);
        const minMargin = STRATEGY_MIN_NOTIONAL / leverage;   // $5 / leverage
        if (avail < minMargin) {
            stats.skipped++;
            if (_bankroll.stack < MIN_STACK) {
                _bankroll.paused = true;
                _bankroll.pausedReason = `Balance too low: $${avail.toFixed(4)}`;
                saveBankroll(_bankroll);
                await sendAlert(`💤 ${_symbol} balance too low ($${avail.toFixed(4)}) — paused.`);
            } else {
                console.log(`[${_symbol}] 💤 Balance $${avail.toFixed(4)} < min margin $${minMargin.toFixed(4)} — skipping.`);
            }
            return;
        }
        const margin = Math.min(getCurrentMargin(_bankroll), avail * 0.95);
        process.env.MARGIN_PER_TRADE = margin.toFixed(2);

        const result = await executeBinanceTrade(signal, 0);

        if (result.outcome === 'orders_placed' && result.entryPrice) {
            _currentTradeId = new Date().toISOString().replace(/[:.]/g, '-');
            logTradeEntry(_currentTradeId, signal, asset, result.entryPrice,
                result.tpPrice ?? 0, result.slPrice ?? 0,
                _lastKlines, _lastRawBook.bids, _lastRawBook.asks);
            console.log(`[Trade] 🚀 ${signal.direction.toUpperCase()} @ $${result.entryPrice} | TP: $${result.tpPrice} | SL: $${result.slPrice} | est: $${result.grossProfit?.toFixed(4)}`);
        } else {
            stats.skipped++;
            if (result.message?.startsWith('MARGIN_INSUFFICIENT')) {
                // Transient at the razor's edge (a just-closed trade not yet settled).
                // Skip and retry next cycle — do NOT pause. The balance gate handles
                // the genuine "too low to trade" case.
                console.log(`[${_symbol}] ⏭ Margin insufficient this instant — skipping, will retry.`);
                return;
            }
            const skip = result.message ?? '';
            if (skip && skip !== 'Position already open.' && !skip.includes('not filled') && !skip.includes('taker')) {
                console.log(`[Skipped] ${skip}`);
            }
        }
    } catch (e: any) {
        console.error(`[Cycle] Error: ${e.message}`);
        await sendAlert(`⚠️ ${_symbol} runCycle error: ${e.message}`);
    }
}

// ─── WATCHDOG ─────────────────────────────────────────────────────────────────
let _watchdogBusy = false;
setInterval(async () => {
    if (!getActiveTrade() || _watchdogBusy) return;
    _watchdogBusy = true;
    try {
        const h = await checkPositionHealth();
        if (h === 'tp' || h === 'sl') saveState();
    } catch { /* silent */ } finally { _watchdogBusy = false; }
}, 2_000);

// ─── DAEMON LOOP ──────────────────────────────────────────────────────────────
function scheduleNext(): void {
    const s  = getSession();
    const ms = Math.floor(Math.random() * (s.cycleMsMax - s.cycleMsMin) + s.cycleMsMin);
    setTimeout(async () => { await runCycle(); scheduleNext(); }, ms);
}

// ─── CRASH SAFETY ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', async (r: any) => {
    console.error(`[FATAL] Unhandled: ${r}`);
    saveState();
    await sendAlert(`🚨 ${_symbol} unhandled rejection: ${r}`);
});
process.on('uncaughtException', async (err: Error) => {
    console.error(`[FATAL] Uncaught: ${err.message}`);
    saveState();
    await sendAlert(`🚨 ${_symbol} CRASHING: ${err.message}`);
    process.exit(1);
});
process.on('SIGTERM', async () => {
    saveState();
    await sendAlert(`🔄 ${_symbol} SIGTERM — stopping.`);
    process.exit(0);
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
loadState();
const _lev = Number(process.env.BOT_LEVERAGE ?? 100);
const _mar = process.env.MARGIN_PER_TRADE ?? '1';
console.log(`\n${'═'.repeat(70)}`);
console.log(`  ${_symbol} SCALPER | ${ENVIRONMENT.toUpperCase()} 🟢`);
console.log(`  LEVERAGE : ${_lev}x | MARGIN: $${_mar}/trade`);
const _slMult = process.env.SL_MAX_WIN_MULTIPLE ?? '2';
console.log(`  TP       : $${process.env.TP_FIXED_USD ?? '10.00'} price move (post-only maker, 0 fee)`);
console.log(`  SL       : DERIVED live so (loss + taker fee) == ${_slMult}x TP exactly — as wide as that cap allows`);
console.log(`  BREAKEVEN: ${_slMult}/(1+${_slMult}) = ${(100*Number(_slMult)/(1+Number(_slMult))).toFixed(1)}% WR (leverage-invariant; one loss costs exactly ${_slMult} wins incl. fee)`);
console.log(`  GATES    : flow 5s+60s | funding | OI surge | news/weekend blackout | ATR≥${process.env.ATR_TP_MIN_RATIO ?? '0.5'}×TP`);
console.log(`  EXIT     : maker TP or stop-market SL resolve the bracket | time-stop @ ${(MAX_HOLD_MS / 60_000).toFixed(0)}min (hygiene only)`);
console.log(`  ATR GATE : ${process.env.ATR_CEIL_PCT ?? '0.6'}% max | ${process.env.ATR_FLOOR_PCT ?? '0.02'}% min`);
console.log(`  STACK    : $${getStack().toFixed(4)} | BANKED: $${getBanked().toFixed(4)}`);
console.log(`  LOG      : ${TRADE_LOG_FILE}`);
console.log(`${'═'.repeat(70)}\n`);

sendAlert(`✅ ${_symbol} | ${ENVIRONMENT} | ${_lev}x | stack=$${getStack().toFixed(4)} | banked=$${getBanked().toFixed(4)}`);

startVelocityMonitor();
runCycle().then(scheduleNext);
