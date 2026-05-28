import ccxt from 'ccxt';
import { generateSignals } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import { executeHyperliquidTrade } from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
    SYMBOL:         'BTC/USDC:USDC',
    DISPLAY_SYMBOL: 'BTC/USDC:USDC',
    CYCLE_INTERVAL_MIN_MS: 60_000,
    CYCLE_INTERVAL_MAX_MS: 90_000,
    MAX_TRADES_PER_DAY: 200,
    VOLUME_SPIKE_MULTIPLIER: 2.0,
};

const exchange = new ccxt.hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    secret:        process.env.HYPERLIQUID_API_SECRET || '',
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    timeout: 15_000,
    enableRateLimit: true,
});

const stats = { date: '', trades: 0, wins: 0, losses: 0, timeouts: 0, cancelled: 0, totalNetPnl: 0, totalFees: 0 };

function resetDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) printDailySummary();
    if (stats.date !== today) {
        Object.assign(stats, { date: today, trades: 0, wins: 0, losses: 0, timeouts: 0, cancelled: 0, totalNetPnl: 0, totalFees: 0 });
    }
}

function printDailySummary() {
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
    console.log(`\n${'█'.repeat(65)}`);
    console.log(`  DAILY SUMMARY — ${stats.date}`);
    console.log(`  Trades: ${stats.trades} | W:${stats.wins} L:${stats.losses} T/O:${stats.timeouts} Cancelled:${stats.cancelled}`);
    console.log(`  Win Rate: ${wr}%`);
    console.log(`  Net P&L: $${stats.totalNetPnl.toFixed(4)}`);
    console.log(`  Fees: $${stats.totalFees.toFixed(4)}`);
    console.log(`${'█'.repeat(65)}\n`);
}

function calculateADX(candles: (number | undefined)[][], period = 14): number {
    if (candles.length < period + 1) return 0;
    const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const h = c[2] as number || 0, l = c[3] as number || 0;
        const ph = p[2] as number || 0, pl = p[3] as number || 0, pc = p[4] as number || 0;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        pDMs.push(h - ph > pl - l ? Math.max(h - ph, 0) : 0);
        mDMs.push(pl - l > h - ph ? Math.max(pl - l, 0) : 0);
    }
    const smooth = (arr: number[]) => {
        let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
        const r = [s];
        for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; r.push(s); }
        return r;
    };
    const sTR = smooth(trs), sP = smooth(pDMs), sM = smooth(mDMs);
    const dxs: number[] = [];
    for (let i = 0; i < sTR.length; i++) {
        if (!sTR[i]) continue;
        const pDI = sP[i] / sTR[i] * 100, mDI = sM[i] / sTR[i] * 100;
        dxs.push(Math.abs(pDI - mDI) / (pDI + mDI) * 100);
    }
    if (dxs.length < period) return 0;
    return dxs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getSMA(candles: (number | undefined)[][], n: number, defaultPrice: number): number {
    const sl = candles.slice(-n).map(x => (x && typeof x[4] === 'number' ? x[4] : defaultPrice));
    return sl.reduce((a, b) => a + b, 0) / n;
}

async function fetchBTCMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching...`);
    try {
        const ticker    = await exchange.fetchTicker(CONFIG.SYMBOL);
        const price     = ticker.last || 0;
        if (!price) { console.warn(`[Data] Invalid price`); return []; }

        const orderBook = await exchange.fetchOrderBook(CONFIG.SYMBOL, 20);
        const processWalls = (levels: any[]): Array<{ price: number; notionalUsd: number }> =>
            (levels || [])
                .map((l: any) => ({ price: +l[0], notionalUsd: +l[0] * +l[1] }))
                .filter(w => w.notionalUsd > 5000)
                .slice(0, 5);

        const bidWalls = processWalls(orderBook.bids);
        const askWalls = processWalls(orderBook.asks);

        // Fetch multiple timeframes for richer context
        const [c1m, c5m, c1h, c4h] = await Promise.all([
            exchange.fetchOHLCV(CONFIG.SYMBOL, '1m',  undefined, 30),
            exchange.fetchOHLCV(CONFIG.SYMBOL, '5m',  undefined, 20),
            exchange.fetchOHLCV(CONFIG.SYMBOL, '1h',  undefined, 60),
            exchange.fetchOHLCV(CONFIG.SYMBOL, '4h',  undefined, 20), // NEW: 4h trend bias
        ]);

        if (!c1m || c1m.length < 10) { console.warn(`[Data] Insufficient candles`); return []; }

        // ATR + volume from 1m
        let totalTR = 0, volTotal = 0;
        const recentVols: number[] = [];
        for (let i = 1; i < c1m.length; i++) {
            const c = c1m[i], p = c1m[i - 1];
            if (!c || !p) continue;
            const h = c[2] as number || price, l = c[3] as number || price, pc = p[4] as number || price, v = c[5] as number || 0;
            totalTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            volTotal += v; recentVols.push(v);
        }
        const atr1m = totalTR / (c1m.length - 1);
        const atrPct = atr1m / price * 100;
        const avgVol = volTotal / recentVols.length;
        const volumeSpike = (recentVols[recentVols.length - 1] || 0) > avgVol * CONFIG.VOLUME_SPIKE_MULTIPLIER;

        // Momentum at 1m, 5m, 15m (from 1m candles)
        const now     = c1m[c1m.length - 1]?.[4] as number || price;
        const ago1m   = c1m[c1m.length - 2]?.[4] as number || price;
        const ago5m   = c1m[Math.max(0, c1m.length - 6)]?.[4] as number || price;
        const ago15m  = c1m[Math.max(0, c1m.length - 16)]?.[4] as number || price;
        const momentum1m  = (now - ago1m)  / ago1m  * 100;
        const momentum5m  = (now - ago5m)  / ago5m  * 100;
        const momentum15m = (now - ago15m) / ago15m * 100;

        // EMA from 1h candles
        const ema8  = c1h.length >= 8  ? getSMA(c1h as any, 8,  price) : price;
        const ema21 = c1h.length >= 21 ? getSMA(c1h as any, 21, price) : price;
        const ema50 = c1h.length >= 50 ? getSMA(c1h as any, 50, price) : price;
        let emaTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (ema8 > ema21 && ema21 > ema50) emaTrend = 'bullish';
        if (ema8 < ema21 && ema21 < ema50) emaTrend = 'bearish';

        // 4h trend bias — is the macro trend up or down over the last 80 hours?
        let trendBias: 'bull' | 'bear' | 'neutral' = 'neutral';
        if (c4h.length >= 10) {
            const open4h  = c4h[c4h.length - 10]?.[1] as number || price;
            const close4h = c4h[c4h.length - 1]?.[4]  as number || price;
            const delta4h = (close4h - open4h) / open4h * 100;
            if (delta4h > 0.3)  trendBias = 'bull';
            if (delta4h < -0.3) trendBias = 'bear';
            console.log(`[Data] 4h bias: ${trendBias} (Δ${delta4h.toFixed(3)}%)`);
        }

        const high24h = ticker.high || price;
        const low24h  = ticker.low  || price;
        const mid     = (high24h + low24h) / 2;
        const priceStructure = price > mid * 1.001 ? 'uptrend' : price < mid * 0.999 ? 'downtrend' : 'ranging';

        const adx = c5m.length >= 28 ? calculateADX(c5m as any, 14) : 20;

        const nearestSupport      = bidWalls[0]?.price || price - 70;
        const nearestResistance   = askWalls[0]?.price || price + 70;
        const distanceToSupport    = price - nearestSupport;
        const distanceToResistance = nearestResistance - price;

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50,
            momentum1m, momentum5m, momentum15m,
            priceStructure, atr1m, atrPct,
            nearestResistance, nearestSupport,
            distanceToResistance, distanceToSupport,
            high24h, low24h, adx, volumeSpike,
            trendBias, regime: 'range_scalp',
        };

        console.log(`[Data] BTC $${price.toFixed(2)} | EMA ${emaTrend} | ATR $${atr1m.toFixed(2)} | ADX ${adx.toFixed(1)} | 4h: ${trendBias}`);
        console.log(`[Data] Mom 1m=${momentum1m.toFixed(4)}% 5m=${momentum5m.toFixed(4)}% 15m=${momentum15m.toFixed(4)}% | VolSpike: ${volumeSpike}`);
        console.log(`[Data] Support $${nearestSupport.toFixed(2)} (${distanceToSupport.toFixed(0)} away) | Resist $${nearestResistance.toFixed(2)} (${distanceToResistance.toFixed(0)} away)`);

        return [{ symbol: CONFIG.DISPLAY_SYMBOL, price, change_24h: ticker.percentage || 0, indicators, orderBook: { bidWalls, askWalls } }];

    } catch (e: any) {
        console.error(`[Data] Fetch error: ${e.message}`);
        return [];
    }
}

async function runCycle() {
    resetDailyStats();
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | Trades: ${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY} | W:${stats.wins} L:${stats.losses} | PnL: $${stats.totalNetPnl.toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.trades >= CONFIG.MAX_TRADES_PER_DAY) { console.log(`[Main] Daily limit reached.`); return; }

    try {
        const assets = await fetchBTCMarketData();
        if (!assets.length) { console.log(`[Main] No data. Skipping.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') { console.log(`[Main] ⏸️ Neutral — skip`); continue; }

            stats.trades++;
            const result = await executeHyperliquidTrade(signal);

            if (result.outcome === 'tp_hit')    { stats.wins++;    stats.totalNetPnl += result.netProfit || 0; }
            else if (result.outcome === 'sl_hit'){ stats.losses++;  stats.totalNetPnl += result.netProfit || 0; } // netProfit is negative on loss
            else if (result.outcome === 'timeout_exit') { stats.timeouts++; stats.losses++; }
            else if (result.outcome === 'cancelled')    { stats.cancelled++; stats.trades--; }

            if (result.fees) stats.totalFees += result.fees;
        }
    } catch (e: any) {
        console.error(`[Main] Cycle error: ${e.message}`);
    }
}

function scheduleNextCycle() {
    const ms = Math.floor(Math.random() * (CONFIG.CYCLE_INTERVAL_MAX_MS - CONFIG.CYCLE_INTERVAL_MIN_MS) + CONFIG.CYCLE_INTERVAL_MIN_MS);
    console.log(`[Main] Next cycle in ${(ms / 1000).toFixed(0)}s`);
    setTimeout(async () => { await runCycle(); scheduleNextCycle(); }, ms);
}

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE — HYPERLIQUID BTC PERP BOT`);
console.log(`  Leverage: 40x | TP: $70 | SL: $70 (1:1 R:R)`);
console.log(`  Entry: maker (PostOnly/Alo) | SL exit: market (taker)`);
console.log(`  Sessions: London 09-13 UTC, L/NY 13-17 UTC, NY 17-21 UTC`);
console.log(`  Timeout: 15 min | 4h trend bias active`);
console.log(`${'█'.repeat(65)}\n`);

if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing env vars: HYPERLIQUID_WALLET_ADDRESS, HYPERLIQUID_API_SECRET, GEMINI_API_KEY`);
    process.exit(1);
}

runCycle().then(() => scheduleNextCycle());
