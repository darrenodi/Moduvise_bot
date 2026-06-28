import * as dotenv from 'dotenv';
import * as fs    from 'fs';
import { RSI, EMA, ADX, ATR } from 'technicalindicators';
import { generateSignals, getSession, detectRegime, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators, GeneratedSignal } from './signals.js';
import { startVelocityMonitor, getVelocityState } from './velocityMonitor.js';
import { checkKillSwitch, analyseFailedTrade } from './geminiAdvisor.js';
import { loadBankroll, applyResult, getCurrentMargin, saveBankroll } from './symbolBankroll.js';
import {
    executeBinanceTrade,
    getAvailableBalance,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    triggerEmergencyClose,
    cancelAllOrders,
    cancelAlgoOrder,
    getRealizedPnlSince,
    sendAlert,
    calcSize,
    placeReduceOnlyLimit,
} from './executeTrade.js';

dotenv.config();

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

// ─── PER-SYMBOL BANKROLL ─────────────────────────────────────────────────────
const _symbol    = process.env.MARKET_SYMBOL ?? 'XAUUSDT';
const startTime  = Date.now();
let   _bankroll  = loadBankroll(_symbol, Number(process.env.INITIAL_MARGIN ?? 1));

// Legacy variables — kept for log/summary compatibility, synced from bankroll
let tradingBalance = _bankroll.tradingStack;
let bankedBalance  = _bankroll.bankedProfit;
const BANK_SPLIT   = 0.50;  // mirrors symbolBankroll.ts constant
const initialBalance = { value: _bankroll.totalDeposited, set: true };

// ─── DAILY STATS ──────────────────────────────────────────────────────────────
interface DayStats {
    date:        string;
    fills:       number;
    tpHits:      number;
    slHits:      number;
    skipped:     number;
    grossProfit: number;
    netProfit:   number;
    slLoss:      number;
}

let stats: DayStats = freshStats();
function freshStats(): DayStats {
    return {
        date:        new Date().toISOString().slice(0, 10),
        fills:       0, tpHits:      0, slHits:   0,
        skipped:     0, grossProfit: 0, netProfit: 0, slLoss: 0,
    };
}

// ─── STATE PERSISTENCE ────────────────────────────────────────────────────────
const STATE_FILE = process.env.STATE_FILE ?? './bot-state.json';

function saveState(): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            tradingBalance, bankedBalance, stats,
            savedAt: new Date().toISOString(),
        }, null, 2));
    } catch (e: any) {
        console.error(`[State] Save failed: ${e.message}`);
    }
}

function loadState(): void {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        // State file only stores daily stats — bankroll is in bankroll-{SYMBOL}.json
        const today = new Date().toISOString().slice(0, 10);
        if (raw.stats?.date === today) stats = raw.stats;
        console.log(`[State] Daily stats restored | saved: ${raw.savedAt}`);
    } catch (e: any) {
        console.error(`[State] Load failed, starting fresh: ${e.message}`);
    }
}

// ─── DAY ROLLOVER ─────────────────────────────────────────────────────────────
function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) {
        printDailySummary();
        sendAlert(
            `📊 Day ${stats.date}: ${stats.fills} trades | ` +
            `${stats.tpHits}TP / ${stats.slHits}SL | ` +
            `net $${stats.netProfit.toFixed(4)} | ` +
            `trading $${tradingBalance.toFixed(4)} | banked $${bankedBalance.toFixed(4)}`
        );
        stats = freshStats();
        stats.date = today;
        saveState();
    }
}

function printDailySummary(): void {
    const tpRate = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    const uptime = ((Date.now() - startTime) / 3_600_000).toFixed(1);
    console.log(`\n${'█'.repeat(70)}`);
    console.log(`📊 DAILY SUMMARY — ${stats.date} (${uptime}h uptime)`);
    console.log(`Trades: ${stats.fills} | Win rate: ${tpRate}% | Skipped: ${stats.skipped}`);
    console.log(`Gross: +$${stats.grossProfit.toFixed(4)} | Net: $${stats.netProfit.toFixed(4)} | SL Loss: -$${stats.slLoss.toFixed(4)}`);
    console.log(`💼 Trading Stack:   $${tradingBalance.toFixed(4)}`);
    console.log(`🏦 Banked Profit:   $${bankedBalance.toFixed(4)}`);
    console.log(`📦 Total in Wallet: $${(tradingBalance + bankedBalance).toFixed(4)}`);
    if (initialBalance.set) {
        const total = tradingBalance + bankedBalance;
        const ret   = ((total - initialBalance.value) / initialBalance.value * 100).toFixed(2);
        console.log(`📈 Return on $${initialBalance.value.toFixed(2)}: ${ret}%`);
    }
    console.log(`${'█'.repeat(70)}\n`);
}

// ─── BANKING ENGINE ──────────────────────────────────────────────────────────
async function applyTradeResult(realizedPnl: number): Promise<void> {
    await applyResult(_bankroll, realizedPnl, sendAlert);
    // Sync legacy aliases
    tradingBalance = _bankroll.tradingStack;
    bankedBalance  = _bankroll.bankedProfit;
    if (realizedPnl > 0) {
        stats.grossProfit += realizedPnl;
        stats.netProfit   += realizedPnl;
    } else {
        stats.netProfit += realizedPnl;
        stats.slLoss    += Math.abs(realizedPnl);
    }
}

// ─── TRADE LOGGER ─────────────────────────────────────────────────────────────
// Every trade gets a full JSON record written to tradeLog.jsonl.
// Two-phase: entry snapshot written immediately, close patch written on exit.
// Format: JSON Lines — one record per line, easy to grep/tail/analyse.
//
// Captures: full order book (top 5 + walls), last 5 candles with direction
// and body size, largest bull/bear candle in last 20, all indicators at
// signal time. Post-mortem diagnosis written at close.
const TRADE_LOG_FILE = process.env.TRADE_LOG_FILE ?? './tradeLog.jsonl';
const _openLogEntries = new Map<string, any>();

function buildCandleSummary(klinesRes: any[]): any[] {
    return klinesRes.slice(-5).map((c: any) => {
        const o = Number(c[1]), h = Number(c[2]), l = Number(c[3]), cl = Number(c[4]);
        const range   = h - l;
        const body    = Math.abs(cl - o);
        const bodyPct = range > 0 ? body / range : 0;
        const dir     = bodyPct < 0.15 ? 'doji' : cl >= o ? 'bull' : 'bear';
        return { open: o, high: h, low: l, close: cl, volume: Number(c[5]), direction: dir, range: Number(range.toFixed(2)), bodyPct: Number(bodyPct.toFixed(2)) };
    });
}

function buildLargestMoves(klinesRes: any[]): { largestBull: any; largestBear: any } {
    const last20 = klinesRes.slice(-20);
    let maxBull = { range: 0, volume: 0, minsAgo: 0 };
    let maxBear = { range: 0, volume: 0, minsAgo: 0 };
    last20.forEach((c: any, i: number) => {
        const o = Number(c[1]), h = Number(c[2]), l = Number(c[3]), cl = Number(c[4]);
        const range   = h - l;
        const minsAgo = (last20.length - 1 - i) * 5;
        if (cl > o && range > maxBull.range) maxBull = { range: Number(range.toFixed(2)), volume: Number(Number(c[5]).toFixed(4)), minsAgo };
        if (cl < o && range > maxBear.range) maxBear = { range: Number(range.toFixed(2)), volume: Number(Number(c[5]).toFixed(4)), minsAgo };
    });
    return { largestBull: maxBull, largestBear: maxBear };
}

function logTradeEntry(
    id:          string,
    signal:      GeneratedSignal,
    marketData:  MarketData,
    entryPrice:  number,
    tpPrice:     number,
    slPrice:     number,
    klinesRes:   any[],
    rawBids:     string[][],
    rawAsks:     string[][],
): void {
    const session = getSession();
    const ind     = marketData.indicators;

    const topBids = rawBids.slice(0, 5).map(b => ({
        price: Number(b[0]), notionalUsd: Math.round(Number(b[0]) * Number(b[1])),
    }));
    const topAsks = rawAsks.slice(0, 5).map(a => ({
        price: Number(a[0]), notionalUsd: Math.round(Number(a[0]) * Number(a[1])),
    }));

    const { largestBull, largestBear } = buildLargestMoves(klinesRes);

    const entry = {
        id,
        phase:          'entry',
        symbol:         marketData.symbol,
        direction:      signal.direction,
        entrySignalAt:  new Date().toISOString(),
        entryPrice,
        tpPrice,
        slPrice,
        tpMove:         Number(Math.abs(tpPrice - entryPrice).toFixed(2)),
        // ── Market snapshot ──────────────────────────────────────────────────
        spotPrice:      marketData.price,
        bid:            marketData.bid,
        ask:            marketData.ask,
        spread:         Number(ind.spreadUsd.toFixed(3)),
        atr5m:          Number(ind.atr5m.toFixed(2)),
        rsi:            Number(ind.rsi.toFixed(1)),
        adx:            Number(ind.adx.toFixed(1)),
        obImbalance:    Number(ind.obImbalance.toFixed(3)),
        momentum5m:     Number(ind.momentum5m.toFixed(3)),
        momentum30m:    Number(ind.momentum30m.toFixed(3)),
        volumeRatio:    Number(ind.volumeRatio.toFixed(2)),
        priceVsVwap:    Number(ind.priceVsVwap.toFixed(3)),
        fundingRate:    ind.fundingRate ?? 0,
        regime:         marketData.regime,
        session:        session.name,
        sessionQuality: session.quality,
        signalReason:   signal.reasoning,
        // ── Order book ───────────────────────────────────────────────────────
        topBids,
        topAsks,
        bidWalls:       marketData.orderBook.bidWalls,
        askWalls:       marketData.orderBook.askWalls,
        // ── Candle context ───────────────────────────────────────────────────
        // last5Candles: newest last. direction = bull/bear/doji. bodyPct: 0=doji, 1=solid.
        // "Did someone dump gold before my entry?" → look at largestBear.minsAgo
        last5Candles:   buildCandleSummary(klinesRes),
        largestBullCandle20m: largestBull,
        largestBearCandle20m: largestBear,
    };

    _openLogEntries.set(id, entry);

    try {
        fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (e: any) {
        console.error(`[TradeLog] Write failed: ${e.message}`);
    }

    console.log(
        `[TradeLog] 📝 Entry | id=${id} | ${signal.direction.toUpperCase()} @ $${entryPrice.toFixed(2)} ` +
        `| ATR=$${ind.atr5m.toFixed(2)} OB=${(ind.obImbalance*100).toFixed(0)}% MOM=$${ind.momentum5m.toFixed(2)}`
    );
}

function logTradeClose(
    id:               string,
    outcome:          string,
    closePrice:       number,
    realizedPnl:      number,
    exitPhase:        string,
    tp2Triggered:     boolean,
    scratchTriggered: boolean,
    priceAtTp1Timeout?: number,
): void {
    const entry = _openLogEntries.get(id);
    if (!entry) {
        try {
            fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify({
                id, phase: 'closed', outcome, closePrice, realizedPnl,
                closedAt: new Date().toISOString(),
                note: 'entry record missing — bot was restarted mid-trade',
            }) + '\n');
        } catch { /* non-critical */ }
        return;
    }

    const durationMs  = Date.now() - new Date(entry.entrySignalAt).getTime();
    const adverseMove = entry.direction === 'long'
        ? Math.max(0, entry.entryPrice - closePrice)
        : Math.max(0, closePrice - entry.entryPrice);

    // Post-mortem: plain-English diagnosis for each trade
    let note = '';
    if (outcome === 'tp') {
        note = exitPhase === 'tp2'
            ? `TP2 rescue limit filled — market drifted back to near-entry after TP1 timeout.`
            : `TP1 filled cleanly in ${(durationMs/1000).toFixed(0)}s.`;
    } else if (scratchTriggered) {
        const momentumTrap =
            (entry.direction === 'long'  && entry.momentum5m < -0.30) ? 'Entry was against strong downward 5m momentum (flush down).' :
            (entry.direction === 'short' && entry.momentum5m >  0.30) ? 'Entry was against strong upward 5m momentum (spike up).' :
            'No clear momentum trap — market reversed after fill.';
        note = `Scratched after TP1+TP2 both timed out. Adverse move: $${adverseMove.toFixed(2)}. ${momentumTrap}`;
    } else if (outcome === 'sl') {
        note = `SL triggered. Adverse $${adverseMove.toFixed(2)}. ATR at entry: $${entry.atr5m.toFixed(2)}${entry.atr5m > 2.0 ? ' — HIGH ATR, market moving faster than scalp target.' : ' — normal ATR, may have been a local extreme fill.'}`;
    } else {
        note = `Closed. PnL: $${realizedPnl.toFixed(4)}.`;
    }

    const closed = {
        ...entry,
        phase:            'closed',
        outcome,
        closePrice,
        realizedPnl,
        durationMs,
        exitPhase,
        closedAt:         new Date().toISOString(),
        tp2Triggered,
        scratchTriggered,
        postMortem: {
            adverseMoveUsd:     Number(adverseMove.toFixed(3)),
            priceAtTp1Timeout:  priceAtTp1Timeout ?? null,
            wasAgainstMomentum: (entry.direction === 'long'  && entry.momentum5m < -0.30)
                             || (entry.direction === 'short' && entry.momentum5m >  0.30),
            atrAtEntry:         entry.atr5m,
            note,
        },
    };

    try {
        fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(closed) + '\n');
    } catch (e: any) {
        console.error(`[TradeLog] Close write failed: ${e.message}`);
    }

    _openLogEntries.delete(id);

    const emoji = outcome === 'tp' ? '✅' : outcome === 'sl' ? '🔴' : '⏱';
    console.log(`[TradeLog] ${emoji} Closed | ${outcome.toUpperCase()} | PnL: $${realizedPnl.toFixed(4)} | ${(durationMs/1000).toFixed(0)}s | ${note}`);
}

// ─── MARKET DATA INGESTION ────────────────────────────────────────────────────
// Returns raw klines alongside MarketData so the trade logger can access candles.
let _lastKlines: any[] = [];
let _lastRawBook: { bids: string[][]; asks: string[][] } = { bids: [], asks: [] };

async function buildLiveMarketData(symbol: string): Promise<MarketData[]> {
    interface BinanceTicker { lastPrice: string; highPrice: string; lowPrice: string; priceChangePercent: string; }
    interface BinanceDepth  { bids: string[][]; asks: string[][]; }
    type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

    const [tickerRes, bookRes, klinesRes] = await Promise.all([
        fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json() as Promise<BinanceTicker>),
        fetch(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`).then(r => r.json() as Promise<BinanceDepth>),
        fetch(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`).then(r => r.json() as Promise<BinanceKline[]>),
    ]);

    // Store for trade logger access
    _lastKlines   = klinesRes;
    _lastRawBook  = { bids: bookRes.bids, asks: bookRes.asks };

    const currentPrice = Number(tickerRes.lastPrice);
    const topBid       = Number(bookRes.bids[0][0]);
    const topAsk       = Number(bookRes.asks[0][0]);
    const spreadUsd    = topAsk - topBid;

    const bidNot    = bookRes.bids.slice(0, 10).reduce((s, v) => s + Number(v[0]) * Number(v[1]), 0);
    const askNot    = bookRes.asks.slice(0, 10).reduce((s, v) => s + Number(v[0]) * Number(v[1]), 0);
    const totNot    = bidNot + askNot;
    const obImbalance = totNot === 0 ? 0 : (bidNot - askNot) / totNot;

    const highs   = klinesRes.map((c: any) => Number(c[2]));
    const lows    = klinesRes.map((c: any) => Number(c[3]));
    const closes  = klinesRes.map((c: any) => Number(c[4]));
    const volumes = klinesRes.map((c: any) => Number(c[5]));

    const rsi        = RSI.calculate({ values: closes, period: 14 }).pop() ?? 50;
    const ema50      = EMA.calculate({ values: closes, period: 50 }).pop() ?? currentPrice;
    const adx        = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop()?.adx ?? 25;
    const atr5m      = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop() ?? 3.50;
    const momentum5m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;

    const avgVol   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1.0;

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

    const swingHigh  = Math.max(...highs.slice(-20));
    const swingLow   = Math.min(...lows.slice(-20));
    const emaTrend   = currentPrice > ema50 ? 'bullish' : 'bearish';

    const { regime, reason: regimeReason } = detectRegime(closes, atr5m);
    if (regime !== 'normal') console.log(`[Regime] ⚠️  ${regimeReason}`);

    const liveIndicators: TechnicalIndicators = {
        emaTrend,
        ema8:                 currentPrice,
        ema21:                currentPrice,
        ema50,
        rsi,
        momentum5m,
        momentum30m:          momentum5m * 6,
        momentum1h:           momentum5m * 12,
        priceStructure:       emaTrend === 'bullish' ? 'uptrend' : 'downtrend',
        trendBias4h:          emaTrend === 'bullish' ? 'bull' : 'bear',
        weeklyBias:           'neutral',
        atr5m,
        atrPct:               atr5m / currentPrice,
        volumeRatio:          volRatio,
        nearestResistance:    swingHigh,
        nearestSupport:       swingLow,
        distanceToResistance: Math.abs(swingHigh - currentPrice),
        distanceToSupport:    Math.abs(currentPrice - swingLow),
        high24h:              Number(tickerRes.highPrice),
        low24h:               Number(tickerRes.lowPrice),
        adx,
        fundingRate,
        spreadUsd,
        obImbalance,
        priceVsVwap,
        recentSwingHigh:      swingHigh,
        recentSwingLow:       swingLow,
    };

    // Order book walls: levels with notional >= $20K
    const WALL_THRESHOLD = 20_000;
    const bidWalls = bookRes.bids
        .map(l => ({ price: Number(l[0]), notionalUsd: Number(l[0]) * Number(l[1]) }))
        .filter(w => w.notionalUsd >= WALL_THRESHOLD);
    const askWalls = bookRes.asks
        .map(l => ({ price: Number(l[0]), notionalUsd: Number(l[0]) * Number(l[1]) }))
        .filter(w => w.notionalUsd >= WALL_THRESHOLD);

    if (bidWalls.length > 0 || askWalls.length > 0) {
        const bidTop = bidWalls[0] ? `top@$${bidWalls[0].price.toFixed(2)} $${(bidWalls[0].notionalUsd/1000).toFixed(0)}K` : 'none';
        const askTop = askWalls[0] ? `top@$${askWalls[0].price.toFixed(2)} $${(askWalls[0].notionalUsd/1000).toFixed(0)}K` : 'none';
        console.log(`[Book] Walls — bids: ${bidWalls.length} ${bidTop} | asks: ${askWalls.length} ${askTop}`);
    }

    return [{
        symbol:      DISPLAY_SYMBOL,
        price:       currentPrice,
        bid:         topBid,
        ask:         topAsk,
        change_24h:  Number(tickerRes.priceChangePercent),
        indicators:  liveIndicators,
        regime,
        regimeReason,
        orderBook:   { bidWalls, askWalls },
        klines:      klinesRes,
    }];
}

// ─── POSITION HEALTH CHECK ────────────────────────────────────────────────────
// Runs every 2s via watchdog. Implements two-stage exit:
//
//  Phase 1 (TP1): Full target resting limit. Wait 90s.
//  Phase 2 (TP2): TP1 timed out → cancel, place rescue limit at entry ± $0.10.
//                 Maker order, near-breakeven. Wait 30s.
//  Phase 3 (Scratch): TP2 timed out → market exit. Fee ~$0.008.
//  Hard backstop: 130s absolute maximum regardless.
//
// Total guaranteed max trade lifetime: 120s (+ 10s buffer = 130s backstop).
let _currentTradeId: string | null = null;
let _priceAtTp1Timeout: number | undefined;
let _lastLossAt = 0;

async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const pos   = await getOpenPositionDetails();
    const trade = getActiveTrade();

    // Position closed externally (TP or SL fired on exchange)
    if (!pos.exists) {
        if (trade) {
            const real = await getRealizedPnlSince(trade.openedAt - 2_000);
            if (real) {
                const outcome = real.pnl >= 0 ? 'tp' : 'sl';
                if (outcome === 'tp') stats.tpHits++; else stats.slHits++;
                stats.fills++;
                await applyTradeResult(real.pnl);
                await cancelAllOrders(trade.slAlgoId);
                if (_currentTradeId) {
                    logTradeClose(
                        _currentTradeId, outcome, pos.currentPrice, real.pnl,
                        trade.tp2Phase ? 'tp2' : 'tp1', trade.tp2Phase, false,
                        _priceAtTp1Timeout,
                    );
                    _currentTradeId     = null;
                    _priceAtTp1Timeout  = undefined;
                }
                clearActiveTrade();
                console.log(`[Health] ${outcome.toUpperCase()} confirmed | PnL: $${real.pnl.toFixed(4)} | fills: ${real.trades}`);
                const killed = await checkKillSwitch(real.pnl, sendAlert);
                if (killed) { process.exit(0); }
                if (outcome === 'sl' && _currentTradeId) {
                    try {
                        const lines = fs.readFileSync(process.env.TRADE_LOG_FILE ?? './tradeLog.jsonl', 'utf-8').split('\n').filter((l: string) => l.trim() && l.includes(_currentTradeId!));
                        const logEntry = lines.length ? JSON.parse(lines[lines.length - 1]) : {};
                        analyseFailedTrade(logEntry, sendAlert).catch((e: any) => console.error(`[Gemini] Post-mortem: ${e.message}`));
                    } catch { /* non-critical */ }
                }
                return outcome;
            }
            await cancelAllOrders(trade.slAlgoId);
            if (_currentTradeId) {
                logTradeClose(_currentTradeId, 'unknown', pos.currentPrice, 0, 'unknown', false, false);
                _currentTradeId = null;
            }
            clearActiveTrade();
            await sendAlert(`⚠️ Position closed but PnL unverifiable. Check Binance.`);
            return 'none';
        }
        return 'none';
    }

    if (!trade) return 'open'; // manual position outside bot

    const ageMs     = Date.now() - trade.openedAt;
    const isBuy     = trade.side === 'long';
    const closeSide = isBuy ? 'SELL' : 'BUY';

    // ── Phase 2: already in TP2 window ───────────────────────────────────────
    if (trade.tp2Phase) {
        const tp2Age = Date.now() - (trade.tp2StartedAt ?? Date.now());
        const TP2_MS = 30_000;
        if (tp2Age < TP2_MS) return 'open';

        // TP2 timed out — scratch at market
        const profit = isBuy
            ? pos.currentPrice - trade.entryPrice
            : trade.entryPrice - pos.currentPrice;
        console.log(`[Scratch] ⏱ TP2 timeout (${(tp2Age/1000).toFixed(0)}s) — market exit @ $${pos.currentPrice.toFixed(2)} (est P&L: $${(profit*trade.size).toFixed(4)})`);

        await cancelAllOrders(trade.slAlgoId);
        await triggerEmergencyClose(trade.side, trade.size, `TP2 timeout ${(tp2Age/1000).toFixed(0)}s`);

        const real = await getRealizedPnlSince(trade.openedAt - 2_000);
        const pnl  = real ? real.pnl : profit * trade.size;
        if (pnl >= 0) stats.tpHits++; else stats.slHits++;
        stats.fills++;
        await applyTradeResult(pnl);

        if (_currentTradeId) {
            logTradeClose(
                _currentTradeId,
                pnl >= 0 ? 'tp' : 'sl',
                pos.currentPrice, pnl,
                'scratch', true, true,
                _priceAtTp1Timeout,
            );
            _currentTradeId    = null;
            _priceAtTp1Timeout = undefined;
        }
        clearActiveTrade();
        await sendAlert(`⏱ Scratched (TP2 timeout) | ${trade.side.toUpperCase()} | PnL: $${pnl.toFixed(4)}`);
        return pnl >= 0 ? 'tp' : 'sl';
    }

    // ── Phase 1 → 2 transition: TP1 timed out ────────────────────────────────
    const TP1_MS = 90_000;
    if (ageMs >= TP1_MS) {
        _priceAtTp1Timeout = pos.currentPrice;

        // Cancel TP1
        if (trade.tpOrderId && trade.tpOrderId > 0) {
            try { await cancelAlgoOrder(trade.tpOrderId); } catch { /* may be gone */ }
        }
        try { await cancelAllOrders(); } catch { /* belt-and-suspenders */ }

        // Place TP2 rescue limit $0.10 from entry
        const TP2_OFFSET = 0.10;
        const tp2Price   = Math.round((isBuy
            ? trade.entryPrice + TP2_OFFSET
            : trade.entryPrice - TP2_OFFSET) * 100) / 100;

        let tp2OrderId = 0;
        try {
            tp2OrderId = await placeReduceOnlyLimit(closeSide, tp2Price, trade.size);
            console.log(`[TP2] 🔄 TP1 timeout (${(ageMs/1000).toFixed(0)}s) — rescue limit @ $${tp2Price.toFixed(2)} | entry $${trade.entryPrice.toFixed(2)} | id=${tp2OrderId}`);
            await sendAlert(`⏳ TP1 timeout | Rescue TP2 @ $${tp2Price.toFixed(2)} | ${trade.side.toUpperCase()}`);
        } catch (e: any) {
            // TP2 placement failed — scratch immediately
            console.error(`[TP2] Placement failed: ${e.message} — scratching immediately`);
            const profit = isBuy ? pos.currentPrice - trade.entryPrice : trade.entryPrice - pos.currentPrice;
            await triggerEmergencyClose(trade.side, trade.size, 'TP2 placement failed');
            const real = await getRealizedPnlSince(trade.openedAt - 2_000);
            const pnl  = real ? real.pnl : profit * trade.size;
            if (pnl >= 0) stats.tpHits++; else stats.slHits++;
            stats.fills++;
            await applyTradeResult(pnl);
            if (_currentTradeId) {
                logTradeClose(_currentTradeId, pnl >= 0 ? 'tp' : 'sl', pos.currentPrice, pnl, 'scratch', true, true, _priceAtTp1Timeout);
                _currentTradeId    = null;
                _priceAtTp1Timeout = undefined;
            }
            clearActiveTrade();
            return pnl >= 0 ? 'tp' : 'sl';
        }

        // Advance to TP2 phase
        (trade as any).tp2Phase     = true;
        (trade as any).tp2StartedAt = Date.now();
        (trade as any).tp2OrderId   = tp2OrderId;
        (trade as any).tp2Price     = tp2Price;
        return 'open';
    }

    // ── Hard backstop: 130s absolute maximum ─────────────────────────────────
    const SCRATCH_MS = 130_000;
    if (ageMs > SCRATCH_MS) {
        const profit = isBuy ? pos.currentPrice - trade.entryPrice : trade.entryPrice - pos.currentPrice;
        console.log(`[Scratch] ⏱ Hard backstop at ${(ageMs/1000).toFixed(0)}s — market exit @ $${pos.currentPrice.toFixed(2)}`);
        await cancelAllOrders(trade.slAlgoId);
        await triggerEmergencyClose(trade.side, trade.size, `Hard backstop: ${(ageMs/1000).toFixed(0)}s`);
        const real = await getRealizedPnlSince(trade.openedAt - 2_000);
        const pnl  = real ? real.pnl : profit * trade.size;
        if (pnl >= 0) stats.tpHits++; else stats.slHits++;
        stats.fills++;
        await applyTradeResult(pnl);
        if (_currentTradeId) {
            logTradeClose(_currentTradeId, pnl >= 0 ? 'tp' : 'sl', pos.currentPrice, pnl, 'scratch', false, true, _priceAtTp1Timeout);
            _currentTradeId    = null;
            _priceAtTp1Timeout = undefined;
        }
        clearActiveTrade();
        return pnl >= 0 ? 'tp' : 'sl';
    }

    // Watchdog fail-safe: if price has blown past SL before exchange orders fired
    const adverseMove  = trade.side === 'long'
        ? trade.entryPrice - pos.currentPrice
        : pos.currentPrice - trade.entryPrice;
    const slThreshold  = Math.abs(trade.slPrice - trade.entryPrice);

    if (adverseMove >= slThreshold * 1.1) {
        await sendAlert(`🛑 Fail-safe: $${adverseMove.toFixed(2)} adverse on ${trade.side.toUpperCase()}`);
        await triggerEmergencyClose(trade.side, trade.size, `Fail-safe: $${adverseMove.toFixed(2)} adverse`);
        const real = await getRealizedPnlSince(trade.openedAt - 2_000);
        const loss = real ? real.pnl : -(trade.size * adverseMove);
        stats.slHits++;
        stats.fills++;
        await applyTradeResult(loss);
        if (_currentTradeId) {
            logTradeClose(_currentTradeId, 'sl', pos.currentPrice, loss, 'failsafe', false, false);
            _currentTradeId = null;
        }
        clearActiveTrade();
        return 'sl';
    }

    return 'open';
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
    checkReset();
    // No trade cap — bot trades continuously regardless of loss count.

    try {
        const health = await checkPositionHealth();
        if (health === 'tp' || health === 'sl') { saveState(); return; }
        if (health === 'open') return;

        // Verify exchange has balance (don't overwrite bankroll)
        if (tradingBalance <= 0) {
            const realBalance = await getAvailableBalance();
            if (realBalance <= 0) {
                console.log('[Init] No available balance on exchange. Waiting...');
                return;
            }
            console.log(`[Init] Exchange balance confirmed: $${realBalance.toFixed(4)}`);
        }

        // Reload bankroll state (may have been updated by watchdog)
        _bankroll = loadBankroll(_symbol, Number(process.env.INITIAL_MARGIN ?? 1));
        tradingBalance = _bankroll.tradingStack;
        bankedBalance  = _bankroll.bankedProfit;

        // Pause check — bankroll exhausted
        if (_bankroll.paused) {
            console.log(`[${_symbol}] ⛔ Bankroll paused — ${_bankroll.pausedReason}`);
            return;
        }

        // Loss cooldown
        const LOSS_COOLDOWN_MS = Number(process.env.LOSS_COOLDOWN_MS ?? 120_000);
        const cooldownLeft = (_lastLossAt + LOSS_COOLDOWN_MS) - Date.now();
        if (cooldownLeft > 0) {
            console.log(`[Cooldown] ⏸ ${Math.ceil(cooldownLeft/1000)}s after last loss`);
            return;
        }

        const assets  = await buildLiveMarketData(MARKET_SYMBOL);
        const velocity = getVelocityState();
        const signals  = await generateSignals(assets, velocity);
        const signal  = signals[0];
        const asset   = assets[0];

        console.log(`[Heartbeat] ${signal.reasoning} | Stack: $${tradingBalance.toFixed(4)} | Banked: $${bankedBalance.toFixed(4)}`);

        if (signal.direction === 'neutral') {
            stats.skipped++;
            return;
        }

        // Dynamic margin from bankroll tier
        const margin = getCurrentMargin(_bankroll);
        process.env.MARGIN_PER_TRADE = String(margin);
        const result = await executeBinanceTrade(signal, 0);

        if (result.outcome === 'orders_placed' && result.entryPrice) {
            // Generate a unique trade ID and log full entry context
            _currentTradeId    = new Date().toISOString().replace(/[:.]/g, '-');
            _priceAtTp1Timeout = undefined;
            logTradeEntry(
                _currentTradeId,
                signal,
                asset,
                result.entryPrice,
                result.tpPrice ?? 0,
                result.slPrice ?? 0,
                _lastKlines,
                _lastRawBook.bids,
                _lastRawBook.asks,
            );
            console.log(
                `[Trade] 🚀 ${signal.direction.toUpperCase()} @ $${result.entryPrice.toFixed(2)} | ` +
                `TP: $${result.tpPrice?.toFixed(2)} | SL: $${result.slPrice?.toFixed(2)} | ` +
                `Est. profit: $${result.grossProfit?.toFixed(4)}`
            );
        } else {
            stats.skipped++;
            console.log(`[Skipped] ${result.message}`);
        }

    } catch (e: any) {
        console.error(`[Cycle] Error: ${e.message}`);
        await sendAlert(`⚠️ runCycle() error: ${e.message}`);
    }
}

// ─── FAST WATCHDOG ────────────────────────────────────────────────────────────
// Runs every 2s while a trade is open — much faster than the main cycle (8-30s).
// This is what drives the two-stage exit timing precisely.
let _watchdogBusy = false;
setInterval(async () => {
    if (!getActiveTrade() || _watchdogBusy) return;
    _watchdogBusy = true;
    try {
        const h = await checkPositionHealth();
        if (h === 'tp' || h === 'sl') saveState();
    } catch { /* silent */ } finally {
        _watchdogBusy = false;
    }
}, 2_000);

// ─── DAEMON LOOP ──────────────────────────────────────────────────────────────
function scheduleNext(): void {
    const session = getSession();
    const ms = Math.floor(Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin);
    setTimeout(async () => { await runCycle(); scheduleNext(); }, ms);
}

// ─── PROCESS CRASH SAFETY ─────────────────────────────────────────────────────
process.on('unhandledRejection', async (reason: any) => {
    console.error(`[FATAL] Unhandled rejection: ${reason}`);
    saveState();
    await sendAlert(`🚨 Unhandled rejection — bot may be unstable: ${reason}`);
});

process.on('uncaughtException', async (err: Error) => {
    console.error(`[FATAL] Uncaught exception: ${err.message}`);
    saveState();
    await sendAlert(`🚨 Bot CRASHING: ${err.message}. Restart it.`);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    console.log('[Shutdown] SIGTERM received. Saving state...');
    saveState();
    await sendAlert('🔄 Bot SIGTERM — shutting down cleanly.');
    process.exit(0);
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
loadState();
const leverage = Number(process.env.BOT_LEVERAGE ?? 100);
const _sym     = process.env.MARKET_SYMBOL ?? 'XAUUSDT';
const _margin  = process.env.MARGIN_PER_TRADE ?? '50';
console.log(`\n${'═'.repeat(70)}`);
console.log(`  ${_sym} SCALPER`);
console.log(`  ENV      : ${ENVIRONMENT}`);
console.log(`  LEVERAGE : ${leverage}x`);
console.log(`  MARGIN   : $${_margin}/trade`);
console.log(`  TP1      : ATR×0.10 (min $0.05, max $1.00)`);
console.log(`  TP2      : rescue limit after 90s`);
console.log(`  SCRATCH  : market exit after 120s`);
console.log(`  ATR GATE : $6.00 max — sits out trap markets`);
console.log(`  BANK     : ${(BANK_SPLIT*100).toFixed(0)}% banked / ${((1-BANK_SPLIT)*100).toFixed(0)}% compounded`);
console.log(`  ACCOUNT  : ${process.env.ENVIRONMENT === "live" ? "LIVE 🟢" : "DEMO 🟡"} | MARGIN $${_margin}/trade | LEVERAGE ${leverage}x`);
console.log(`  KILL     : $1000 cumulative loss -> Gemini auto-shutdown`);
console.log(`  LOG      : ${TRADE_LOG_FILE}`);
console.log(`${'═'.repeat(70)}\n`);

sendAlert(
    `✅ Bot started | ENV=${ENVIRONMENT} | ${leverage}x | ` +
    `stack=$${tradingBalance.toFixed(4)} | banked=$${bankedBalance.toFixed(4)}`
);

startVelocityMonitor();
runCycle().then(scheduleNext);
