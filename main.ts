import ccxt from 'ccxt';
import { generateSignals, getSession, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import {
    executeBinanceTrade,
    getAvailableBalance,
    hasOpenPosition,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    triggerStopLoss,
    calcSize,
    cancelAlgoOrder, // 👈 ADD THIS IMPORT
} from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    MAX_TRADES_DAY:      400,
    MAX_TRADING_BALANCE: 25_000,
    // Banking:
    //   - Profits accumulate in sessionBanked
    //   - Transfer to spot only when accumulated net >= BANK_THRESHOLD ($5)
    //   - At that point, move 30% to spot and keep 70% compounding
    //   - This avoids pointless micro-transfers on $0.04 wins
    BANK_THRESHOLD:      5.00,      // minimum accumulated profit before any spot transfer
    BANK_FRACTION:       0.30,      // 30% moves to spot when threshold is crossed
    RECYCLE_BALANCE:     800,
    RECYCLE_KEEP:        400,
    LEVERAGE:            40,
} as const;

// ─── EXCHANGE (public data only) ──────────────────────────────────────────────

const exchange = new (ccxt as any).binanceusdm({
    timeout: 15_000, enableRateLimit: true, options: { defaultType: 'future' },
    ...(IS_TESTNET ? { urls: { api: {
        public:       BASE_URL,
        fapiPublic:   BASE_URL + '/fapi/v1/',
        fapiPublicV2: BASE_URL + '/fapi/v2/',
    }}} : {}),
});

// ─── STATS ────────────────────────────────────────────────────────────────────

interface DayStats {
    date: string; attempts: number; fills: number; tpHits: number;
    slHits: number; skipped: number; grossProfit: number; netProfit: number;
    slLoss: number; fillTimes: number[];
}

let stats: DayStats = freshStats();

function freshStats(): DayStats {
    return {
        date: new Date().toISOString().slice(0, 10),
        attempts: 0, fills: 0, tpHits: 0, slHits: 0, skipped: 0,
        grossProfit: 0, netProfit: 0, slLoss: 0, fillTimes: [],
    };
}

// ─── BANKING STATE ────────────────────────────────────────────────────────────

let virtualTradingBalance  = 0;   // balance used for sizing (compounds)
let accumulatedNetProfit   = 0;   // profit waiting to cross BANK_THRESHOLD
let totalBanked            = 0;   // total moved to spot all-time this session
const startTime            = Date.now();
const initialBalance       = { value: 0, set: false };

interface PendingTrade {
    entryPrice:  number;
    tpPrice:     number;
    slPrice:     number;
    side:        'long' | 'short';
    size:        number;
    grossProfit: number;
    netProfit:   number;
    fees:        number;
    openedAt:    number;
    tpMove?:     number;
    slMove?:     number;
    fillTimeMs?: number;
}
let pendingTrade: PendingTrade | null = null;

function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) { printDailySummary(); stats = freshStats(); stats.date = today; }
}

function printDailySummary(): void {
    const total   = virtualTradingBalance + totalBanked;
    const uptime  = ((Date.now() - startTime) / 3600_000).toFixed(1);
    const tpRate  = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    const avgFill = stats.fillTimes.length > 0
        ? (stats.fillTimes.reduce((a, b) => a + b, 0) / stats.fillTimes.length / 1000).toFixed(1) : '0';

    console.log(`\n${'█'.repeat(65)}`);
    console.log(`📊 DAILY SUMMARY — ${stats.date} (${uptime}h)`);
    console.log(`Trades: ${stats.fills}/${stats.attempts} | TP: ${stats.tpHits} (${tpRate}%) | SL: ${stats.slHits} | Skip: ${stats.skipped}`);
    console.log(`Gross: $${stats.grossProfit.toFixed(4)} | Net: $${stats.netProfit.toFixed(4)} | SL loss: $${stats.slLoss.toFixed(4)}`);
    console.log(`Avg fill: ${avgFill}s | Pending bank: $${accumulatedNetProfit.toFixed(4)}`);
    console.log(`💼 Balance: $${virtualTradingBalance.toFixed(2)} | 🏦 Banked: $${totalBanked.toFixed(2)} | Total: $${total.toFixed(2)}`);
    if (initialBalance.set) console.log(`📈 Return: ${((total - initialBalance.value) / initialBalance.value * 100).toFixed(2)}%`);
    console.log(`${'█'.repeat(65)}\n`);
}

// ─── BANKING ─────────────────────────────────────────────────────────────────
// Profits accumulate in accumulatedNetProfit.
// When accumulated >= $5.00, we move 30% to spot and keep 70% compounding.
// This means:
//   - Small wins ($0.05/trade) accumulate silently
//   - After ~$5 accumulated, one transfer: 30% to spot, 70% added to balance
//   - No micro-transfers, no noise in logs

function bankProfit(netProfit: number): void {
    if (netProfit <= 0) {
        // Loss — deduct from balance directly
        virtualTradingBalance = Math.max(CONFIG.MAX_TRADING_BALANCE > 0 ? 1.50 : 1.50,
            virtualTradingBalance + netProfit);
        console.log(`[Bank] Loss $${netProfit.toFixed(4)} | vBal=$${virtualTradingBalance.toFixed(2)}`);
        return;
    }

    if (virtualTradingBalance >= CONFIG.MAX_TRADING_BALANCE) {
        // At cap — bank everything
        accumulatedNetProfit += netProfit;
        totalBanked          += netProfit;
        stats.netProfit      += netProfit;
        console.log(`[Bank] 🏦 CAP — banked $${netProfit.toFixed(4)} | total banked $${totalBanked.toFixed(2)}`);
        return;
    }

    // Normal: accumulate until threshold
    accumulatedNetProfit += netProfit;
    stats.netProfit      += netProfit;
    stats.grossProfit    += netProfit;

    console.log(`[Bank] +$${netProfit.toFixed(4)} | accumulated=$${accumulatedNetProfit.toFixed(4)} / threshold=$${CONFIG.BANK_THRESHOLD.toFixed(2)}`);

    if (accumulatedNetProfit >= CONFIG.BANK_THRESHOLD) {
        // Threshold crossed — split: 30% to spot, 70% compounds
        const toSpot    = accumulatedNetProfit * CONFIG.BANK_FRACTION;
        const toBalance = accumulatedNetProfit * (1 - CONFIG.BANK_FRACTION);

        totalBanked            += toSpot;
        virtualTradingBalance   = Math.min(virtualTradingBalance + toBalance, CONFIG.MAX_TRADING_BALANCE);
        accumulatedNetProfit    = 0;  // reset accumulator

        console.log(`[Bank] 💸 THRESHOLD HIT — $${toSpot.toFixed(4)} → spot | $${toBalance.toFixed(4)} → balance`);
        console.log(`[Bank] 💼 vBal=$${virtualTradingBalance.toFixed(2)} | 🏦 Banked=$${totalBanked.toFixed(2)} | Total=$${(virtualTradingBalance + totalBanked).toFixed(2)}`);
        console.log(`[Bank] ⚠️  TRANSFER $${toSpot.toFixed(4)} from futures to spot wallet now.`);
    } else {
        // Just compound everything until threshold
        virtualTradingBalance = Math.min(virtualTradingBalance + netProfit, CONFIG.MAX_TRADING_BALANCE);
        console.log(`[Bank] Compounding $${netProfit.toFixed(4)} | vBal=$${virtualTradingBalance.toFixed(2)}`);
    }
}

async function updateRealPnl(): Promise<void> {
    try {
        const { createHmac } = await import('crypto');
        const secret = process.env.BINANCE_BOT_SECRET ?? process.env.BINANCE_API_SECRET ?? '';
        const apiKey = process.env.BINANCE_BOT_API    ?? process.env.BINANCE_API_KEY    ?? '';
        const ts     = Date.now();
        const query  = `symbol=${MARKET_SYMBOL}&limit=20&timestamp=${ts}&recvWindow=10000`;
        const sig    = createHmac('sha256', secret).update(query).digest('hex');
        const res    = await fetch(`${BASE_URL}/fapi/v1/userTrades?${query}&signature=${sig}`, {
            headers: { 'X-MBX-APIKEY': apiKey },
        });
        if (!res.ok) return;
        const trades = await res.json() as any[];
        if (!trades?.length) return;
        let pnl = 0, w = 0, l = 0;
        for (const t of trades) {
            const p = parseFloat(t.realizedPnl ?? '0');
            if (!isNaN(p) && p !== 0) { pnl += p; if (p > 0) w++; else l++; }
        }
        if (w + l > 0) console.log(`[PnL] Exchange: $${pnl.toFixed(4)} | W:${w} L:${l} WR:${((w/(w+l))*100).toFixed(0)}%`);
    } catch { /* non-critical */ }
}

// ─── POSITION HEALTH ──────────────────────────────────────────────────────────

async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const pos = await getOpenPositionDetails();

    if (!pos.exists) {
        if (pendingTrade) return 'tp';
        return 'none';
    }

    const trade = pendingTrade ?? getActiveTrade();
    if (!trade) { console.log(`[Health] Orphan position — no local record.`); return 'open'; }

    const adverseMove = pos.side === 'long'
        ? trade.entryPrice - pos.currentPrice
        : pos.currentPrice - trade.entryPrice;

    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);
    const emoji = adverseMove > slThreshold * 0.7 ? '🔴' : adverseMove > 0 ? '🟡' : '🟢';

    console.log(`[Health] ${emoji} ${pos.side?.toUpperCase()} @ $${trade.entryPrice.toFixed(2)} | now $${pos.currentPrice.toFixed(2)} | move=${adverseMove > 0 ? '-' : '+'}$${Math.abs(adverseMove).toFixed(2)} | SL@$${trade.slPrice.toFixed(2)}`);

    if (adverseMove >= slThreshold) {
        console.log(`[Health] 🛑 SL — $${adverseMove.toFixed(2)} ≥ $${slThreshold.toFixed(2)}`);
        const side = pos.side ?? (pendingTrade?.side ?? getActiveTrade()?.side ?? 'long');
        await triggerStopLoss(side, pos.size, `adverse $${adverseMove.toFixed(2)}`);

        const slLoss = pos.size * adverseMove;
        stats.slHits++;
        stats.slLoss    += slLoss;
        stats.netProfit -= slLoss;
        bankProfit(-slLoss);
        pendingTrade = null;
        await updateRealPnl();
        return 'sl';
    }

    return 'open';
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`klines ${res.status}`);
    return res.json() as Promise<any[]>;
}

function emaOf(values: number[], period: number): number {
    if (values.length < period) return values.at(-1) ?? 0;
    const k = 2 / (period + 1);
    let e    = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
    return e;
}

function rsiOf(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let g = 0, l = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i]! - closes[i - 1]!;
        if (d > 0) g += d; else l -= d;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function adxOf(highs: number[], lows: number[], closes: number[], period = 14): number {
    if (highs.length < period + 1) return 20;
    const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        trs.push(Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i-1]!), Math.abs(lows[i]! - closes[i-1]!)));
        const pd = Math.max(highs[i]! - highs[i-1]!, 0);
        const md = Math.max(lows[i-1]! - lows[i]!, 0);
        pDMs.push(pd > md ? pd : 0);
        mDMs.push(md > pd ? md : 0);
    }
    const sumTR = trs.slice(-period).reduce((a, b) => a + b, 0);
    if (sumTR === 0) return 20;
    const pDI = pDMs.slice(-period).reduce((a, b) => a + b, 0) / sumTR * 100;
    const mDI = mDMs.slice(-period).reduce((a, b) => a + b, 0) / sumTR * 100;
    return (pDI + mDI) > 0 ? Math.abs(pDI - mDI) / (pDI + mDI) * 100 : 20;
}

async function fetchMarketData(): Promise<MarketData[]> {
    try {
        const [ticker, k5m, k30m, k1h, k4h, kW, depth, funding] = await Promise.all([
            fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${MARKET_SYMBOL}`).then(r => r.json() as Promise<any>),
            fetchKlines(MARKET_SYMBOL, '5m',  120),
            fetchKlines(MARKET_SYMBOL, '30m', 60),
            fetchKlines(MARKET_SYMBOL, '1h',  60),
            fetchKlines(MARKET_SYMBOL, '4h',  30),
            fetchKlines(MARKET_SYMBOL, '1w',  4),
            fetch(`${BASE_URL}/fapi/v1/depth?symbol=${MARKET_SYMBOL}&limit=20`).then(r => r.json() as Promise<any>),
            fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${MARKET_SYMBOL}`).then(r => r.json() as Promise<any>).catch(() => null),
        ]);

        const price = Number(ticker.lastPrice ?? 0);
        if (!price) throw new Error('No price');

        const c5  = k5m.map((c: any[]) => Number(c[4]));
        const h5  = k5m.map((c: any[]) => Number(c[2]));
        const l5  = k5m.map((c: any[]) => Number(c[3]));
        const v5  = k5m.map((c: any[]) => Number(c[5]));
        const c30 = k30m.map((c: any[]) => Number(c[4]));
        const c1h = k1h.map((c: any[]) => Number(c[4]));
        const c4h = k4h.map((c: any[]) => Number(c[4]));
        const cW  = kW.map((c: any[]) => Number(c[4]));

        const ema8  = emaOf(c5, 8);
        const ema21 = emaOf(c5, 21);
        const ema50 = emaOf(c5, 50);
        const emaTrend = ema8 > ema21 && ema21 > ema50 ? 'bullish' : ema8 < ema21 && ema21 < ema50 ? 'bearish' : 'neutral';
        const rsi   = rsiOf(c5);
        const adx   = adxOf(h5, l5, c5);

        const mom5m  = c5.length  >= 2 ? ((c5.at(-1)!  - c5.at(-2)!)  / c5.at(-2)!  * 100) : 0;
        const mom30m = c30.length >= 2 ? ((c30.at(-1)! - c30.at(-2)!) / c30.at(-2)! * 100) : 0;
        const mom1h  = c1h.length >= 2 ? ((c1h.at(-1)! - c1h.at(-2)!) / c1h.at(-2)! * 100) : 0;

        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            ema8 > ema50 * 1.001 ? 'uptrend' : ema8 < ema50 * 0.999 ? 'downtrend' : 'ranging';

        const trendBias4h: 'bull' | 'bear' | 'neutral' =
            c4h.at(-1)! > c4h.at(-5)! * 1.002 ? 'bull' : c4h.at(-1)! < c4h.at(-5)! * 0.998 ? 'bear' : 'neutral';

        const weeklyBias: 'bullish' | 'bearish' | 'neutral' =
            cW.at(-1)! > cW.at(-2)! * 1.005 ? 'bullish' : cW.at(-1)! < cW.at(-2)! * 0.995 ? 'bearish' : 'neutral';

        const trs     = h5.slice(-20).map((h, i) => { const l = l5.slice(-20)[i]!; const pc = i > 0 ? c5.slice(-20)[i-1]! : l; return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); });
        const atr5m   = trs.reduce((a, b) => a + b, 0) / trs.length;
        const recentV = v5.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const avgV    = v5.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volumeRatio = avgV > 0 ? recentV / avgV : 1;

        // S/R swing detection
        const sw = k5m.slice(-30);
        const swH: number[] = [], swL: number[] = [];
        for (let i = 2; i < sw.length - 2; i++) {
            const h = Number(sw[i]![2]), l = Number(sw[i]![3]);
            if (h > Number(sw[i-1]![2]) && h > Number(sw[i+1]![2])) swH.push(h);
            if (l < Number(sw[i-1]![3]) && l < Number(sw[i+1]![3])) swL.push(l);
        }
        const nearestResistance = swH.filter(h => h > price).length ? Math.min(...swH.filter(h => h > price)) : price + atr5m;
        const nearestSupport    = swL.filter(l => l < price).length ? Math.max(...swL.filter(l => l < price)) : price - atr5m;

        const h24 = Number(ticker.highPrice ?? price + atr5m);
        const l24 = Number(ticker.lowPrice  ?? price - atr5m);
        const fundingRate = funding?.lastFundingRate != null ? Number(funding.lastFundingRate) : null;

        const bestBid    = Number(depth?.bids?.[0]?.[0] ?? price - 0.05);
        const bestAsk    = Number(depth?.asks?.[0]?.[0] ?? price + 0.05);
        const spreadUsd  = bestAsk - bestBid;

        const bids = (depth?.bids ?? []).slice(0, 10);
        const asks = (depth?.asks ?? []).slice(0, 10);
        const bidQ = bids.reduce((s: number, b: any[]) => s + Number(b[1]), 0);
        const askQ = asks.reduce((s: number, a: any[]) => s + Number(a[1]), 0);
        const obImbalance = (bidQ + askQ) > 0 ? (bidQ - askQ) / (bidQ + askQ) : 0;

        const vwapN = k5m.slice(-20).reduce((s: number, c: any[]) => s + ((Number(c[2]) + Number(c[3]) + Number(c[4])) / 3) * Number(c[5]), 0);
        const vwapD = v5.slice(-20).reduce((a, b) => a + b, 0);
        const vwap  = vwapD > 0 ? vwapN / vwapD : price;

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50, rsi,
            momentum5m: mom5m, momentum30m: mom30m, momentum1h: mom1h,
            priceStructure, trendBias4h, weeklyBias,
            atr5m, atrPct: (atr5m / price) * 100, volumeRatio,
            nearestResistance, nearestSupport,
            distanceToResistance: nearestResistance - price,
            distanceToSupport:    price - nearestSupport,
            high24h: h24, low24h: l24, adx, fundingRate,
            spreadUsd, obImbalance,
            priceVsVwap: ((price - vwap) / vwap * 100),
            recentSwingHigh: nearestResistance,
            recentSwingLow:  nearestSupport,
        };

        const rngPct = h24 > l24 ? ((price - l24) / (h24 - l24) * 100).toFixed(0) : '50';
        console.log(`[Data] $${price.toFixed(2)} EMA:${emaTrend} RSI:${rsi.toFixed(1)} ADX:${adx.toFixed(1)} ATR:$${atr5m.toFixed(2)} Spread:$${spreadUsd.toFixed(3)} OB:${(obImbalance*100).toFixed(0)}% Rng:${rngPct}%`);

        return [{ symbol: DISPLAY_SYMBOL, price, change_24h: Number(ticker.priceChangePercent ?? 0), indicators, orderBook: {
            bidWalls: bids.map((b: any[]) => ({ price: Number(b[0]), notionalUsd: Number(b[0]) * Number(b[1]) })).filter((b: any) => b.notionalUsd > 50_000),
            askWalls: asks.map((a: any[]) => ({ price: Number(a[0]), notionalUsd: Number(a[0]) * Number(a[1]) })).filter((a: any) => a.notionalUsd > 50_000),
        }}];
    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
    checkReset();
    const session = getSession();

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | ${session.name} [${session.quality}] | ${IS_TESTNET ? '🧪 TEST' : '🔴 LIVE'}`);
    console.log(`[Main] trades=${stats.fills}/${CONFIG.MAX_TRADES_DAY} tp=${stats.tpHits} sl=${stats.slHits} skip=${stats.skipped}`);
    console.log(`[Main] vBal=$${virtualTradingBalance.toFixed(2)} | pending=$${accumulatedNetProfit.toFixed(4)} | banked=$${totalBanked.toFixed(2)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.fills >= CONFIG.MAX_TRADES_DAY) {
        console.log(`[Main] Daily limit ${CONFIG.MAX_TRADES_DAY} reached.`);
        return;
    }

    try {
        const health = await checkPositionHealth();

        if (health === 'tp') {
            if (pendingTrade) {
                stats.fills++;
                stats.tpHits++;
                if (pendingTrade.fillTimeMs) stats.fillTimes.push(pendingTrade.fillTimeMs);
                bankProfit(pendingTrade.netProfit);
                // 👇 ADD THIS CLEANUP LOGIC 👇
                const liveTrade = getActiveTrade();
                if (liveTrade?.slAlgoId) {
                    await cancelAlgoOrder(liveTrade.slAlgoId);
                }
                // 👆 ------------------------ 👆
                clearActiveTrade();
                pendingTrade = null;
            }
            await updateRealPnl();
            return;
        }

        if (health === 'sl') { pendingTrade = null; await updateRealPnl(); return; }

        if (health === 'open') {
            if (!pendingTrade) {
                console.log(`[Main] Orphan position — closing...`);
                const pos = await getOpenPositionDetails();
                if (pos.exists && pos.side && pos.size > 0) {
                    await triggerStopLoss(pos.side, pos.size, 'orphan');
                }
                return;
            }
            console.log(`[Main] In trade — SL@$${pendingTrade.slPrice.toFixed(2)} TP@$${pendingTrade.tpPrice.toFixed(2)}`);
            return;
        }

        // ── No position — attempt new trade ──────────────────────────────

        const balance = await getAvailableBalance();

        if (virtualTradingBalance <= 0) {
            if (balance <= 0) { console.log(`[Main] Balance unavailable.`); return; }
            virtualTradingBalance = balance;
            initialBalance.value  = balance;
            initialBalance.set    = true;
            console.log(`[Bank] Init: $${virtualTradingBalance.toFixed(4)}`);
        }

        const effectiveBalance = balance > 0 ? balance : virtualTradingBalance;
        // No bot-side balance floor — Binance enforces its own minimum order size

        if (balance >= CONFIG.RECYCLE_BALANCE) {
            console.log(`[Main] 🎯 RECYCLE — $${balance.toFixed(2)} ≥ $${CONFIG.RECYCLE_BALANCE}. Consider withdrawing $${(balance - CONFIG.RECYCLE_KEEP).toFixed(2)}.`);
        }

        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No market data.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') { stats.skipped++; continue; }

            stats.attempts++;

            const result = await executeBinanceTrade(signal, virtualTradingBalance);

            if (result.outcome === 'orders_placed' && result.entryPrice) {
                pendingTrade = {
                    entryPrice:  result.entryPrice,
                    tpPrice:     result.tpPrice!,
                    slPrice:     result.slPrice!,
                    side:        signal.direction as 'long' | 'short',
                    size:        calcSize(virtualTradingBalance, result.entryPrice),
                    grossProfit: result.grossProfit!,
                    netProfit:   result.netProfit!,
                    fees:        result.fees!,
                    openedAt:    Date.now(),
                    tpMove:      result.tpMove,
                    slMove:      result.slMove,
                    fillTimeMs:  result.fillTimeMs,
                };
            } else if (result.outcome === 'skipped') {
                stats.attempts--;
                stats.skipped++;
            } else if (result.outcome === 'error') {
                console.error(`[Main] Error: ${result.message}`);
                stats.attempts--;
            }

            break; // one signal per cycle
        }

    } catch (e: any) {
        console.error(`[Main] Cycle error: ${e.message}`);
    }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────

function scheduleNext(): void {
    const session = getSession();
    const ms = Math.floor(Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin);
    console.log(`[Main] Next cycle in ${(ms / 1000).toFixed(0)}s [${session.name}]`);
    setTimeout(async () => {
        try { await runCycle(); } catch (e: any) { console.error(`[Main] Uncaught: ${e.message}`); }
        scheduleNext();
    }, ms);
}

process.on('SIGTERM', () => { printDailySummary(); process.exit(0); });
process.on('SIGINT',  () => { printDailySummary(); process.exit(0); });

// ─── STARTUP ──────────────────────────────────────────────────────────────────

const hasKeys = ENVIRONMENT === 'live'
    ? (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET)
    : (process.env.BINANCE_BOT_API && process.env.BINANCE_BOT_SECRET);

if (!hasKeys) {
    console.error(ENVIRONMENT === 'live'
        ? '❌ Missing: BINANCE_API_KEY, BINANCE_API_SECRET'
        : '❌ Missing: BINANCE_BOT_API, BINANCE_BOT_SECRET');
    process.exit(1);
}

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE GOLD BOT — BINANCE USDM FUTURES`);
console.log(`  Mode:     ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'}`);
console.log(`  Asset:    XAUUSDT perp | 40x leverage`);
console.log(`  Entry:    GTX $0.20 from market | 0% maker fee`);
console.log(`  TP:       $1.00 GTX resting | 0% maker fee`);
console.log(`  SL:       $3.00 monitored | market exit | 0.045% taker`);
console.log(`  R:R:      1:3 — breakeven 75% | observed WR ~87%`);
console.log(`  Size:     100% of balance every trade`);
console.log(`  Banking:  Accumulate until $5, then 30% to spot / 70% compound`);
console.log(`  Cap:      $${CONFIG.MAX_TRADING_BALANCE.toLocaleString()} balance | 400 trades/day`);
console.log(`  Start:    ${new Date().toISOString()}`);
console.log(`${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);