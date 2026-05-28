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

    // 60–90s randomized cycles
    CYCLE_INTERVAL_MIN_MS: 60_000,
    CYCLE_INTERVAL_MAX_MS: 90_000,

    MAX_TRADES_PER_DAY: 200,

    TRADE_24_7: true,

    ADX_BREAKOUT_THRESHOLD: 25,
    VOLUME_SPIKE_MULTIPLIER: 2.0,
};

// ─── EXCHANGE ─────────────────────────────────────────────────────────────────

const exchange = new ccxt.hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    secret:        process.env.HYPERLIQUID_API_SECRET || '',
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    timeout:       15_000,
    enableRateLimit: true,
});

// ─── DAILY STATS ──────────────────────────────────────────────────────────────

const stats = {
    date:         '',
    trades:       0,
    wins:         0,
    losses:       0,
    timeouts:     0,
    cancelled:    0,
    totalNetPnl:  0,
    totalFees:    0,
    startBalance: 0,
};

function resetDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) printDailySummary();
    if (stats.date !== today) {
        stats.date        = today;
        stats.trades      = 0;
        stats.wins        = 0;
        stats.losses      = 0;
        stats.timeouts    = 0;
        stats.cancelled   = 0;
        stats.totalNetPnl = 0;
        stats.totalFees   = 0;
    }
}

function printDailySummary() {
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
    console.log(`\n${'█'.repeat(65)}`);
    console.log(`  DAILY SUMMARY — ${stats.date}`);
    console.log(`  Trades:  ${stats.trades}  W:${stats.wins} L:${stats.losses} T/O:${stats.timeouts} Cancelled:${stats.cancelled}`);
    console.log(`  Win Rate: ${wr}%`);
    console.log(`  Net P&L:  $${stats.totalNetPnl.toFixed(4)}`);
    console.log(`  Fees:     $${stats.totalFees.toFixed(4)}`);
    console.log(`${'█'.repeat(65)}\n`);
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

function calculateADX(candles: (number | undefined)[][], period = 14): number {
    if (candles.length < period + 1) return 0;

    const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const cur  = candles[i];
        const prev = candles[i - 1];
        const h  = typeof cur[2]  === 'number' ? cur[2]  : 0;
        const l  = typeof cur[3]  === 'number' ? cur[3]  : 0;
        const ph = typeof prev[2] === 'number' ? prev[2] : 0;
        const pl = typeof prev[3] === 'number' ? prev[3] : 0;
        const pc = typeof prev[4] === 'number' ? prev[4] : 0;

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
        if (sTR[i] === 0) continue;
        const pDI = (sP[i] / sTR[i]) * 100;
        const mDI = (sM[i] / sTR[i]) * 100;
        dxs.push(Math.abs(pDI - mDI) / (pDI + mDI) * 100);
    }
    if (dxs.length < period) return 0;
    return dxs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function fetchBTCMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching BTC live data from Hyperliquid...`);

    try {
        const ticker = await exchange.fetchTicker(CONFIG.SYMBOL);
        const price  = ticker.last || 0;

        if (!price) { console.warn(`[Data] Invalid price`); return []; }

        const orderBook = await exchange.fetchOrderBook(CONFIG.SYMBOL, 20);

        const processWalls = (levels: (number | undefined)[][]): Array<{ price: number; notionalUsd: number }> => {
            if (!levels) return [];
            return levels
                .map(l => ({ price: typeof l[0] === 'number' ? l[0] : 0, notionalUsd: (typeof l[0] === 'number' ? l[0] : 0) * (typeof l[1] === 'number' ? l[1] : 0) }))
                .filter(w => w.notionalUsd > 5000)
                .slice(0, 5);
        };

        const bidWalls = processWalls(orderBook.bids as (number | undefined)[][]);
        const askWalls = processWalls(orderBook.asks as (number | undefined)[][]);

        const candles1m = await exchange.fetchOHLCV(CONFIG.SYMBOL, '1m', undefined, 30);
        const candles5m = await exchange.fetchOHLCV(CONFIG.SYMBOL, '5m', undefined, 20);
        const candles1h = await exchange.fetchOHLCV(CONFIG.SYMBOL, '1h', undefined, 60);

        if (!candles1m || candles1m.length < 10) { console.warn(`[Data] Insufficient 1m candles`); return []; }

        let totalTR = 0, volTotal = 0;
        const recentVols: number[] = [];

        for (let i = 1; i < candles1m.length; i++) {
            const c = candles1m[i], p = candles1m[i - 1];
            if (!c || !p) continue;
            const h  = typeof c[2] === 'number' ? c[2] : price;
            const l  = typeof c[3] === 'number' ? c[3] : price;
            const pc = typeof p[4] === 'number' ? p[4] : price;
            const v  = typeof c[5] === 'number' ? c[5] : 0;
            totalTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            volTotal += v;
            recentVols.push(v);
        }

        const atr1m       = totalTR / (candles1m.length - 1);
        const atrPct      = (atr1m / price) * 100;
        const avgVol      = volTotal / recentVols.length;
        const lastVol     = recentVols[recentVols.length - 1] || 0;
        const volumeSpike = lastVol > avgVol * CONFIG.VOLUME_SPIKE_MULTIPLIER;

        const last1m  = candles1m[candles1m.length - 1];
        const prev1m  = candles1m[candles1m.length - 2];
        const prev5m  = candles1m[Math.max(0, candles1m.length - 6)];
        const closeNow   = last1m && typeof last1m[4] === 'number' ? last1m[4] : price;
        const close1mAgo = prev1m && typeof prev1m[4] === 'number' ? prev1m[4] : price;
        const close5mAgo = prev5m && typeof prev5m[4] === 'number' ? prev5m[4] : price;
        const momentum1m = ((closeNow - close1mAgo) / close1mAgo) * 100;
        const momentum5m = ((closeNow - close5mAgo) / close5mAgo) * 100;

        const getSMA = (c: (number | undefined)[][], n: number): number => {
            const sl = c.slice(-n).map(x => (x && typeof x[4] === 'number' ? x[4] : price));
            return sl.reduce((a, b) => a + b, 0) / n;
        };

        const ema8  = candles1h.length >= 8  ? getSMA(candles1h, 8)  : price;
        const ema21 = candles1h.length >= 21 ? getSMA(candles1h, 21) : price;
        const ema50 = candles1h.length >= 50 ? getSMA(candles1h, 50) : price;

        let emaTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (ema8 > ema21 && ema21 > ema50) emaTrend = 'bullish';
        if (ema8 < ema21 && ema21 < ema50) emaTrend = 'bearish';

        const high24h = ticker.high || price;
        const low24h  = ticker.low  || price;
        const mid     = (high24h + low24h) / 2;
        const priceStructure =
            price > mid * 1.001 ? 'uptrend' :
            price < mid * 0.999 ? 'downtrend' :
            'ranging';

        const adx = candles5m.length >= 28
            ? calculateADX(candles5m as (number | undefined)[][], 14)
            : 20;

        const nearestSupport      = bidWalls[0]?.price || price - 50;
        const nearestResistance   = askWalls[0]?.price || price + 50;
        const distanceToSupport    = price - nearestSupport;
        const distanceToResistance = nearestResistance - price;

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50,
            momentum1m, momentum5m, priceStructure,
            atr1m, atrPct,
            nearestResistance, nearestSupport,
            distanceToResistance, distanceToSupport,
            high24h, low24h, adx, volumeSpike,
            regime: 'range_scalp',
        };

        console.log(`[Data] BTC $${price.toFixed(2)} | EMA ${emaTrend} | ATR $${atr1m.toFixed(2)} | ADX ${adx.toFixed(1)}`);
        console.log(`[Data] Mom 1m=${momentum1m.toFixed(4)}% 5m=${momentum5m.toFixed(4)}% | Vol spike: ${volumeSpike}`);
        console.log(`[Data] Support $${nearestSupport.toFixed(2)} (${distanceToSupport.toFixed(2)} away) | Resist $${nearestResistance.toFixed(2)} (${distanceToResistance.toFixed(2)} away)`);

        return [{ symbol: CONFIG.DISPLAY_SYMBOL, price, change_24h: ticker.percentage || 0, indicators, orderBook: { bidWalls, askWalls } }];

    } catch (error: any) {
        console.error(`[Data] Fetch error:`, error.message || error);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runCycle() {
    resetDailyStats();

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | Trades: ${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY} | W:${stats.wins} L:${stats.losses} T/O:${stats.timeouts} | PnL: $${stats.totalNetPnl.toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.trades >= CONFIG.MAX_TRADES_PER_DAY) {
        console.log(`[Main] ✅ Daily limit reached. Resting until tomorrow.`);
        return;
    }

    try {
        const assets = await fetchBTCMarketData();
        if (assets.length === 0) { console.log(`[Main] No market data. Skipping.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') {
                console.log(`[Main] ⏸️ Neutral — no trade this cycle.`);
                continue;
            }

            stats.trades++;
            console.log(`[Main] Executing trade ${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY}...`);

            const result = await executeHyperliquidTrade(signal);

            if (result.outcome === 'tp_hit') {
                stats.wins++;
                stats.totalNetPnl += result.netProfit || 0;
            } else if (result.outcome === 'sl_hit') {
                stats.losses++;
                // Use actual contract loss: contractSize × SL_PRICE_MOVE
                stats.totalNetPnl -= result.fees ? result.fees : 0; // fees still charged on SL
            } else if (result.outcome === 'timeout_exit') {
                stats.timeouts++;
                // P&L unknown until next cycle; count as a loss for safety
                stats.losses++;
            } else if (result.outcome === 'cancelled') {
                stats.cancelled++;
                stats.trades--; // don't count cancelled as a real trade
            }

            if (result.fees) stats.totalFees += result.fees;
        }

    } catch (error: any) {
        console.error(`[Main] Cycle error:`, error.message || error);
    }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────

function scheduleNextCycle() {
    const interval = Math.floor(
        Math.random() * (CONFIG.CYCLE_INTERVAL_MAX_MS - CONFIG.CYCLE_INTERVAL_MIN_MS) +
        CONFIG.CYCLE_INTERVAL_MIN_MS
    );
    console.log(`[Main] Next cycle in ${(interval / 1000).toFixed(0)}s`);
    setTimeout(async () => {
        await runCycle();
        scheduleNextCycle();
    }, interval);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE BTC TRADING BOT — HYPERLIQUID`);
console.log(`  Balance: $13.89 | Leverage: 40x | TP: $50–$80 BTC move`);
console.log(`  Fees: 0.015% maker entry + 0.015% maker exit = 0.030%`);
console.log(`  Entry: PostOnly limit (offset $3 inside book = always maker)`);
console.log(`  Hold timeout: 10 minutes (auto force-close)`);
console.log(`  API: gemini-2.0-flash-lite primary (500 RPD) + local fallback`);
console.log(`  Exchange: Hyperliquid | Mode: 24/7`);
console.log(`${'█'.repeat(65)}\n`);

if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing env vars. Required in .env:`);
    console.error(`   HYPERLIQUID_WALLET_ADDRESS=0x...`);
    console.error(`   HYPERLIQUID_API_SECRET=0x...`);
    console.error(`   GEMINI_API_KEY=...`);
    process.exit(1);
}

runCycle().then(() => scheduleNextCycle());
