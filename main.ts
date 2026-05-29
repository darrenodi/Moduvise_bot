import ccxt from 'ccxt';
import { generateSignals } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import { executeHyperliquidTrade } from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    SYMBOL:         'BTC/USDC:USDC',
    DISPLAY_SYMBOL: 'BTC/USDC:USDC',

    // 7–10 min cycles → ~100–170 trade attempts/day
    // (actual fills depend on maker entry price hitting)
    CYCLE_INTERVAL_MIN_MS:  7 * 60_000,
    CYCLE_INTERVAL_MAX_MS: 10 * 60_000,

    MAX_TRADES_PER_DAY: 200,
    VOLUME_SPIKE_MULTIPLIER: 2.0,
};

// ─── EXCHANGE ─────────────────────────────────────────────────────────────────

const exchange = new ccxt.hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    secret:        process.env.HYPERLIQUID_API_SECRET || '',
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    timeout: 15_000,
    enableRateLimit: true,
});

// ─── STATS ────────────────────────────────────────────────────────────────────

const stats = {
    date: '', trades: 0, wins: 0, losses: 0,
    timeouts: 0, cancelled: 0, skipped: 0,
    totalNetPnl: 0, totalFees: 0,
};

function resetDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) printDailySummary();
    if (stats.date !== today) {
        Object.assign(stats, { date: today, trades: 0, wins: 0, losses: 0, timeouts: 0, cancelled: 0, skipped: 0, totalNetPnl: 0, totalFees: 0 });
    }
}

function printDailySummary() {
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
    const bar = '█'.repeat(65);
    console.log(`\n${bar}`);
    console.log(`  DAILY SUMMARY — ${stats.date}`);
    console.log(`  Trades: ${stats.trades} | W:${stats.wins} L:${stats.losses} T/O:${stats.timeouts} Cancelled:${stats.cancelled} Skipped:${stats.skipped}`);
    console.log(`  Win Rate: ${wr}% | Net P&L: $${stats.totalNetPnl.toFixed(4)} | Fees: $${stats.totalFees.toFixed(4)}`);
    console.log(`${bar}\n`);
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────

function calcRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    const ag = gains / period, al = losses / period;
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
}

function calcADX(candles: any[][], period = 14): number {
    if (candles.length < period + 1) return 20;
    const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const h = +c[2]||0, l = +c[3]||0, ph = +p[2]||0, pl = +p[3]||0, pc = +p[4]||0;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        pDMs.push(h - ph > pl - l ? Math.max(h - ph, 0) : 0);
        mDMs.push(pl - l > h - ph ? Math.max(pl - l, 0) : 0);
    }
    const smooth = (a: number[]) => {
        let s = a.slice(0, period).reduce((x, y) => x + y, 0);
        const r = [s]; for (let i = period; i < a.length; i++) { s = s - s / period + a[i]; r.push(s); } return r;
    };
    const sTR = smooth(trs), sP = smooth(pDMs), sM = smooth(mDMs);
    const dxs: number[] = [];
    for (let i = 0; i < sTR.length; i++) {
        if (!sTR[i]) continue;
        const pDI = sP[i] / sTR[i] * 100, mDI = sM[i] / sTR[i] * 100;
        dxs.push(Math.abs(pDI - mDI) / (pDI + mDI) * 100);
    }
    if (dxs.length < period) return 20;
    return dxs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getSMA(candles: any[][], n: number, def: number): number {
    const sl = candles.slice(-n).map(x => (x && typeof x[4] === 'number' ? x[4] : def));
    return sl.reduce((a, b) => a + b, 0) / n;
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function fetchBTCMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching...`);
    try {
        const ticker = await exchange.fetchTicker(CONFIG.SYMBOL);
        const price  = ticker.last || 0;
        if (!price) { console.warn(`[Data] Invalid price`); return []; }

        const orderBook = await exchange.fetchOrderBook(CONFIG.SYMBOL, 20);
        const walls = (levels: any[]) =>
            (levels || [])
                .map((l: any) => ({ price: +l[0], notionalUsd: +l[0] * +l[1] }))
                .filter(w => w.notionalUsd > 5_000)
                .slice(0, 5);
        const bidWalls = walls(orderBook.bids);
        const askWalls = walls(orderBook.asks);

        // Parallel fetch: 5m for ATR/RSI/ADX, 30m for momentum, 1h for EMA+1h mom, 4h bias, 1w bias
        const [c5m, c30m, c1h, c4h, c1w] = await Promise.all([
            exchange.fetchOHLCV(CONFIG.SYMBOL, '5m',  undefined, 50),  // RSI + ATR + ADX
            exchange.fetchOHLCV(CONFIG.SYMBOL, '15m', undefined, 20),  // 30m momentum proxy (2×15m)
            exchange.fetchOHLCV(CONFIG.SYMBOL, '1h',  undefined, 60),  // EMA + 1h momentum
            exchange.fetchOHLCV(CONFIG.SYMBOL, '4h',  undefined, 20),  // 4h trend bias
            exchange.fetchOHLCV(CONFIG.SYMBOL, '1d',  undefined, 7),   // weekly bias
        ]);

        if (!c5m || c5m.length < 15) { console.warn(`[Data] Insufficient 5m candles`); return []; }

        // ── ATR (5m) ──────────────────────────────────────────────────
        let totalTR = 0, volTotal = 0;
        const vols: number[] = [];
        for (let i = 1; i < c5m.length; i++) {
            const c = c5m[i], p = c5m[i - 1];
            if (!c || !p) continue;
            const h = +c[2]||price, l = +c[3]||price, pc = +p[4]||price, v = +c[5]||0;
            totalTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            volTotal += v; vols.push(v);
        }
        const atr5m    = totalTR / (c5m.length - 1);
        const atrPct   = atr5m / price * 100;
        const avgVol   = volTotal / vols.length;
        const lastVol  = vols[vols.length - 1] || 0;
        const volumeRatio = lastVol / (avgVol || 1);

        // ── RSI (5m closes, period 14) ────────────────────────────────
        const closes5m = c5m.map(c => +c[4] || price);
        const rsi = calcRSI(closes5m, 14);
        const rsiZone: 'oversold' | 'neutral' | 'overbought' =
            rsi <= 30 ? 'oversold' : rsi >= 70 ? 'overbought' : 'neutral';

        // ── EMA (1h candles) ──────────────────────────────────────────
        const ema8  = c1h.length >= 8  ? getSMA(c1h, 8,  price) : price;
        const ema21 = c1h.length >= 21 ? getSMA(c1h, 21, price) : price;
        const ema50 = c1h.length >= 50 ? getSMA(c1h, 50, price) : price;
        let emaTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (ema8 > ema21 && ema21 > ema50) emaTrend = 'bullish';
        if (ema8 < ema21 && ema21 < ema50) emaTrend = 'bearish';

        // ── MOMENTUM ──────────────────────────────────────────────────
        // 5m momentum (short-term noise filter)
        const now5m    = +c5m[c5m.length - 1]?.[4] || price;
        const ago5m    = +c5m[Math.max(0, c5m.length - 2)]?.[4] || price;
        const momentum5m = (now5m - ago5m) / ago5m * 100;

        // 30m momentum: use 15m candles, look back 2 candles (~30m)
        const now30m   = +c30m[c30m.length - 1]?.[4] || price;
        const ago30m   = +c30m[Math.max(0, c30m.length - 3)]?.[4] || price;
        const momentum30m = (now30m - ago30m) / ago30m * 100;

        // 1h momentum
        const now1h    = +c1h[c1h.length - 1]?.[4] || price;
        const ago1h    = +c1h[Math.max(0, c1h.length - 2)]?.[4] || price;
        const momentum1h = (now1h - ago1h) / ago1h * 100;

        // ── ADX (5m) ──────────────────────────────────────────────────
        const adx = calcADX(c5m, 14);

        // ── 4H TREND BIAS ─────────────────────────────────────────────
        let trendBias4h: 'bull' | 'bear' | 'neutral' = 'neutral';
        if (c4h.length >= 5) {
            const o = +c4h[c4h.length - 5]?.[1] || price;
            const cl = +c4h[c4h.length - 1]?.[4] || price;
            const d = (cl - o) / o * 100;
            if (d > 0.25) trendBias4h = 'bull';
            if (d < -0.25) trendBias4h = 'bear';
        }

        // ── WEEKLY BIAS ───────────────────────────────────────────────
        let weeklyBias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (c1w.length >= 3) {
            const wOpen  = +c1w[0]?.[1] || price;
            const wClose = +c1w[c1w.length - 1]?.[4] || price;
            const wd = (wClose - wOpen) / wOpen * 100;
            if (wd > 1.0)  weeklyBias = 'bullish';
            if (wd < -1.0) weeklyBias = 'bearish';
        }

        // ── PRICE STRUCTURE (24h) ─────────────────────────────────────
        const high24h = ticker.high || price;
        const low24h  = ticker.low  || price;
        const mid24h  = (high24h + low24h) / 2;
        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            price > mid24h * 1.002 ? 'uptrend' :
            price < mid24h * 0.998 ? 'downtrend' : 'ranging';

        // ── S/R FROM ORDER BOOK ───────────────────────────────────────
        const nearestSupport      = bidWalls[0]?.price || price - 70;
        const nearestResistance   = askWalls[0]?.price || price + 70;
        const distanceToSupport    = price - nearestSupport;
        const distanceToResistance = nearestResistance - price;

        // ── FUNDING RATE (skip if unavailable) ────────────────────────
        let fundingRate: number | null = null;
        try {
            const fr = await exchange.fetchFundingRate(CONFIG.SYMBOL);
            fundingRate = fr?.fundingRate ?? null;
        } catch { /* not critical */ }

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50,
            rsi, rsiZone,
            momentum5m, momentum30m, momentum1h,
            priceStructure, weeklyBias, trendBias4h,
            atr5m, atrPct, volumeRatio,
            nearestResistance, nearestSupport,
            distanceToResistance, distanceToSupport,
            high24h, low24h, adx, fundingRate,
        };

        console.log(`[Data] BTC $${price.toFixed(2)} | EMA:${emaTrend} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)}`);
        console.log(`[Data] Mom 5m:${momentum5m.toFixed(4)}% 30m:${momentum30m.toFixed(4)}% 1h:${momentum1h.toFixed(4)}%`);
        console.log(`[Data] Vol:${volumeRatio.toFixed(2)}x | ATR:$${atr5m.toFixed(2)} | 4h:${trendBias4h} | Weekly:${weeklyBias}`);
        console.log(`[Data] Sup:$${nearestSupport.toFixed(2)}(${distanceToSupport.toFixed(0)} away) Res:$${nearestResistance.toFixed(2)}(${distanceToResistance.toFixed(0)} away)`);

        return [{
            symbol: CONFIG.DISPLAY_SYMBOL, price,
            change_24h: ticker.percentage || 0,
            indicators,
            orderBook: { bidWalls, askWalls },
        }];

    } catch (e: any) {
        console.error(`[Data] Fetch error: ${e.message}`);
        return [];
    }
}

// ─── CYCLE ────────────────────────────────────────────────────────────────────

async function runCycle() {
    resetDailyStats();
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | Trades:${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY} | W:${stats.wins} L:${stats.losses} | PnL:$${stats.totalNetPnl.toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.trades >= CONFIG.MAX_TRADES_PER_DAY) { console.log(`[Main] Daily limit reached.`); return; }

    try {
        const assets = await fetchBTCMarketData();
        if (!assets.length) { console.log(`[Main] No market data. Skipping.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral' || signal.confidence === 0) {
                stats.skipped++;
                console.log(`[Main] ⏸️ Skip — ${signal.reasoning}`);
                continue;
            }

            stats.trades++;
            console.log(`[Main] Trade ${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY} — ${signal.direction.toUpperCase()} conf=${signal.confidence.toFixed(2)}`);

            const result = await executeHyperliquidTrade(signal);

            if      (result.outcome === 'tp_hit')       { stats.wins++;    stats.totalNetPnl += result.netProfit || 0; }
            else if (result.outcome === 'sl_hit')        { stats.losses++;  stats.totalNetPnl += result.netProfit || 0; }
            else if (result.outcome === 'timeout_exit')  { stats.timeouts++; stats.losses++; }
            else if (result.outcome === 'cancelled')     { stats.cancelled++; stats.trades--; }

            if (result.fees) stats.totalFees += result.fees;

            console.log(`[Main] → ${result.outcome.toUpperCase()} | Session PnL: $${stats.totalNetPnl.toFixed(4)}`);
        }
    } catch (e: any) {
        console.error(`[Main] Cycle error: ${e.message}`);
    }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────

function scheduleNextCycle() {
    // Random interval between 7–10 min to avoid predictable patterns
    const ms = Math.floor(
        Math.random() * (CONFIG.CYCLE_INTERVAL_MAX_MS - CONFIG.CYCLE_INTERVAL_MIN_MS)
        + CONFIG.CYCLE_INTERVAL_MIN_MS
    );
    console.log(`[Main] Next cycle in ${(ms / 60000).toFixed(1)} min`);
    setTimeout(async () => { await runCycle(); scheduleNextCycle(); }, ms);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE — HYPERLIQUID BTC PERP BOT v3`);
console.log(`  Leverage: 40x | TP: $70 | SL: $70 (1:1 R:R)`);
console.log(`  Signals: RSI + EMA + 30m/1h momentum + weekly/4h bias + choppy gate`);
console.log(`  Entry: PostOnly maker | SL: market taker`);
console.log(`  Cycle: 7–10 min → ~100–170 attempts/day`);
console.log(`  Session gates: London 09–13 UTC, L/NY 13–17, NY 17–21, Asia skip`);
console.log(`${'█'.repeat(65)}\n`);

if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing env vars: HYPERLIQUID_WALLET_ADDRESS, HYPERLIQUID_API_SECRET, GEMINI_API_KEY`);
    process.exit(1);
}

runCycle().then(() => scheduleNextCycle());
