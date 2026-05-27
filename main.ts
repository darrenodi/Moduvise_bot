import ccxt from 'ccxt';
import { generateSignals } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import { executeHyperliquidTrade } from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    SYMBOL: 'BTC/USDC:USDC',
    DISPLAY_SYMBOL: 'BTC/USDC:USDC',

    // 60-90 second cycles targeting 100-200 trades/day
    // 86400s / 75s avg = 1152 possible cycles
    // At 50% signal rate = ~576 opportunities
    // After position hold time = ~100-200 actual trades
    CYCLE_INTERVAL_MIN_MS: 60_000,   // 60 seconds minimum
    CYCLE_INTERVAL_MAX_MS: 90_000,   // 90 seconds maximum

    // Trade limits
    MAX_TRADES_PER_DAY: 200,

    // Session hours — BTC trades 24/7 but peak liquidity:
    // Tokyo open: 00:00-09:00 UTC
    // London open: 08:00-16:00 UTC
    // NY open: 13:00-21:00 UTC
    // Run 24/7 — BTC never sleeps
    TRADE_24_7: true,

    // ADX threshold for breakout detection
    ADX_BREAKOUT_THRESHOLD: 25,

    // Volume spike detection multiplier
    VOLUME_SPIKE_MULTIPLIER: 2.0,
};

// ─── EXCHANGE (READ-ONLY for market data) ────────────────────────────────────

const exchange = new ccxt.hyperliquid({
    apiKey: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    secret: process.env.HYPERLIQUID_API_SECRET || '',
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    timeout: 15000,
    enableRateLimit: true,
});

// ─── DAILY STATS ─────────────────────────────────────────────────────────────

const stats = {
    date: '',
    trades: 0,
    wins: 0,
    losses: 0,
    cancelled: 0,
    totalNetPnl: 0,
    totalFees: 0,
    startBalance: 0,
};

function resetDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) {
        printDailySummary();
    }
    if (stats.date !== today) {
        stats.date = today;
        stats.trades = 0;
        stats.wins = 0;
        stats.losses = 0;
        stats.cancelled = 0;
        stats.totalNetPnl = 0;
        stats.totalFees = 0;
    }
}

function printDailySummary() {
    console.log(`\n${'█'.repeat(65)}`);
    console.log(`  DAILY SUMMARY — ${stats.date}`);
    console.log(`  Trades:    ${stats.trades} (Wins: ${stats.wins} | Losses: ${stats.losses} | Cancelled: ${stats.cancelled})`);
    console.log(`  Win Rate:  ${stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : 0}%`);
    console.log(`  Net P&L:   $${stats.totalNetPnl.toFixed(4)}`);
    console.log(`  Total Fees: $${stats.totalFees.toFixed(4)}`);
    console.log(`${'█'.repeat(65)}\n`);
}

// ─── ADX CALCULATION ─────────────────────────────────────────────────────────

/**
 * Simplified ADX from candle OHLCV data
 * Uses 14-period Wilder smoothing
 */
function calculateADX(candles: (number | undefined)[][], period = 14): number {
    if (candles.length < period + 1) return 0;

    const trueRanges: number[] = [];
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const cur = candles[i];
        const prev = candles[i - 1];

        const high = typeof cur[2] === 'number' ? cur[2] : 0;
        const low = typeof cur[3] === 'number' ? cur[3] : 0;
        const prevHigh = typeof prev[2] === 'number' ? prev[2] : 0;
        const prevLow = typeof prev[3] === 'number' ? prev[3] : 0;
        const prevClose = typeof prev[4] === 'number' ? prev[4] : 0;

        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );

        const plusDM = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
        const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;

        trueRanges.push(tr);
        plusDMs.push(plusDM);
        minusDMs.push(minusDM);
    }

    // Smooth using Wilder method
    const smooth = (arr: number[]) => {
        let smoothed = arr.slice(0, period).reduce((a, b) => a + b, 0);
        const result = [smoothed];
        for (let i = period; i < arr.length; i++) {
            smoothed = smoothed - smoothed / period + arr[i];
            result.push(smoothed);
        }
        return result;
    };

    const smoothedTR = smooth(trueRanges);
    const smoothedPlusDM = smooth(plusDMs);
    const smoothedMinusDM = smooth(minusDMs);

    const dxValues: number[] = [];
    for (let i = 0; i < smoothedTR.length; i++) {
        if (smoothedTR[i] === 0) continue;
        const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
        const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
        dxValues.push(dx);
    }

    if (dxValues.length < period) return 0;
    return dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── MARKET DATA FETCH ────────────────────────────────────────────────────────

async function fetchBTCMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching BTC live data from Hyperliquid...`);

    try {
        const ticker = await exchange.fetchTicker(CONFIG.SYMBOL);
        const price = ticker.last || 0;

        if (!price || price === 0) {
            console.warn(`[Data] Invalid price: ${price}`);
            return [];
        }

        // Order book
        const orderBook = await exchange.fetchOrderBook(CONFIG.SYMBOL, 20);

        const processWalls = (levels: (number | undefined)[][]): Array<{ price: number; notionalUsd: number }> => {
            if (!levels) return [];
            return levels
                .map(l => {
                    const p = typeof l[0] === 'number' ? l[0] : 0;
                    const a = typeof l[1] === 'number' ? l[1] : 0;
                    return { price: p, notionalUsd: p * a };
                })
                .filter(w => w.notionalUsd > 5000)  // BTC walls > $5K notional
                .slice(0, 5);
        };

        const bidWalls = processWalls(orderBook.bids as (number | undefined)[][]);
        const askWalls = processWalls(orderBook.asks as (number | undefined)[][]);

        // Candles
        // 1m candles for ATR, momentum, ADX
        // 1h candles for EMA trend
        const candles1m = await exchange.fetchOHLCV(CONFIG.SYMBOL, '1m', undefined, 30);
        const candles5m = await exchange.fetchOHLCV(CONFIG.SYMBOL, '5m', undefined, 20);
        const candles1h = await exchange.fetchOHLCV(CONFIG.SYMBOL, '1h', undefined, 60);

        if (!candles1m || candles1m.length < 10) {
            console.warn(`[Data] Insufficient 1m candle data`);
            return [];
        }

        // ── ATR on 1m candles ─────────────────────────────────────────────
        let totalTR = 0;
        let volumeTotal = 0;
        const recentVolumes: number[] = [];

        for (let i = 1; i < candles1m.length; i++) {
            const cur = candles1m[i];
            const prev = candles1m[i - 1];
            if (!cur || !prev) continue;

            const high = typeof cur[2] === 'number' ? cur[2] : price;
            const low = typeof cur[3] === 'number' ? cur[3] : price;
            const prevClose = typeof prev[4] === 'number' ? prev[4] : price;
            const vol = typeof cur[5] === 'number' ? cur[5] : 0;

            totalTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            volumeTotal += vol;
            recentVolumes.push(vol);
        }

        const atr1m = totalTR / (candles1m.length - 1);
        const atrPct = (atr1m / price) * 100;
        const avgVolume = volumeTotal / recentVolumes.length;
        const lastVol = recentVolumes[recentVolumes.length - 1] || 0;
        const volumeSpike = lastVol > avgVolume * CONFIG.VOLUME_SPIKE_MULTIPLIER;

        // ── Momentum ──────────────────────────────────────────────────────
        const last1m = candles1m[candles1m.length - 1];
        const prev1m = candles1m[candles1m.length - 2];
        const prev5m = candles1m[Math.max(0, candles1m.length - 6)]; // ~5 min ago

        const closeNow = last1m && typeof last1m[4] === 'number' ? last1m[4] : price;
        const close1mAgo = prev1m && typeof prev1m[4] === 'number' ? prev1m[4] : price;
        const close5mAgo = prev5m && typeof prev5m[4] === 'number' ? prev5m[4] : price;

        const momentum1m = ((closeNow - close1mAgo) / close1mAgo) * 100;
        const momentum5m = ((closeNow - close5mAgo) / close5mAgo) * 100;

        // ── EMA (1h candles) ──────────────────────────────────────────────
        const getSMA = (candles: (number | undefined)[][], period: number): number => {
            const sliced = candles.slice(-period);
            const closes = sliced.map(c => (c && typeof c[4] === 'number' ? c[4] : price));
            return closes.reduce((a, b) => a + b, 0) / period;
        };

        const ema8 = candles1h.length >= 8 ? getSMA(candles1h, 8) : price;
        const ema21 = candles1h.length >= 21 ? getSMA(candles1h, 21) : price;
        const ema50 = candles1h.length >= 50 ? getSMA(candles1h, 50) : price;

        let emaTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (ema8 > ema21 && ema21 > ema50) emaTrend = 'bullish';
        if (ema8 < ema21 && ema21 < ema50) emaTrend = 'bearish';

        // ── Price structure ───────────────────────────────────────────────
        const high24h = ticker.high || price;
        const low24h = ticker.low || price;
        const mid = (high24h + low24h) / 2;
        const priceStructure =
            price > mid * 1.001 ? 'uptrend' :
            price < mid * 0.999 ? 'downtrend' :
            'ranging';

        // ── ADX ───────────────────────────────────────────────────────────
        const adx = candles5m.length >= 28
            ? calculateADX(candles5m as (number | undefined)[][], 14)
            : 20; // Default to neutral if not enough data

        // ── Support/Resistance from order book ────────────────────────────
        const nearestSupport = bidWalls[0]?.price || price - 50;
        const nearestResistance = askWalls[0]?.price || price + 50;
        const distanceToSupport = price - nearestSupport;
        const distanceToResistance = nearestResistance - price;

        const indicators: TechnicalIndicators = {
            emaTrend,
            ema8,
            ema21,
            ema50,
            momentum1m,
            momentum5m,
            priceStructure,
            atr1m,
            atrPct,
            nearestResistance,
            nearestSupport,
            distanceToResistance,
            distanceToSupport,
            high24h,
            low24h,
            adx,
            volumeSpike,
            regime: 'range_scalp', // Will be classified in signals.ts
        };

        console.log(`[Data] BTC: $${price.toFixed(2)} | EMA: ${emaTrend} | ATR(1m): $${atr1m.toFixed(2)} | ADX: ${adx.toFixed(1)}`);
        console.log(`[Data] Momentum: 1m=${momentum1m.toFixed(4)}% | 5m=${momentum5m.toFixed(4)}%`);
        console.log(`[Data] Support: $${nearestSupport.toFixed(2)} (${distanceToSupport.toFixed(2)} away) | Resistance: $${nearestResistance.toFixed(2)} (${distanceToResistance.toFixed(2)} away)`);
        console.log(`[Data] Volume spike: ${volumeSpike} | Structure: ${priceStructure}`);

        return [{
            symbol: CONFIG.DISPLAY_SYMBOL,
            price,
            change_24h: ticker.percentage || 0,
            indicators,
            orderBook: { bidWalls, askWalls },
        }];

    } catch (error: any) {
        console.error(`[Data] Fetch error:`, error.message || error);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runCycle() {
    resetDailyStats();

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] Cycle: ${new Date().toISOString()}`);
    console.log(`[Main] Trades today: ${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY} | W:${stats.wins} L:${stats.losses} | PnL: $${stats.totalNetPnl.toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    // Daily limit check
    if (stats.trades >= CONFIG.MAX_TRADES_PER_DAY) {
        console.log(`[Main] ✅ Daily limit reached. Resting until tomorrow.`);
        return;
    }

    try {
        // Fetch data
        const assets = await fetchBTCMarketData();
        if (assets.length === 0) {
            console.log(`[Main] No market data. Skipping.`);
            return;
        }

        // Generate signals
        const signals = await generateSignals(assets);

        // Execute
        for (const signal of signals) {
            if (signal.direction === 'neutral') {
                console.log(`[Main] ⏸️ Neutral — no trade this cycle.`);
                continue;
            }

            stats.trades++;
            console.log(`[Main] Executing trade ${stats.trades}/${CONFIG.MAX_TRADES_PER_DAY}...`);

            const result = await executeHyperliquidTrade(signal);

            // Update stats
            if (result.outcome === 'tp_hit') {
                stats.wins++;
                stats.totalNetPnl += result.netProfit || 0;
            } else if (result.outcome === 'sl_hit') {
                stats.losses++;
                const slLoss = 0.004938 * 300; // approx at $10 balance
                stats.totalNetPnl -= slLoss;
            } else if (result.outcome === 'cancelled') {
                stats.cancelled++;
                stats.trades--; // Don't count cancelled as trade
            }

            if (result.fees) stats.totalFees += result.fees;
        }

    } catch (error: any) {
        console.error(`[Main] Cycle error:`, error.message || error);
    }
}

// ─── RANDOMIZED INTERVAL ─────────────────────────────────────────────────────

/**
 * Randomize cycle interval between 60-90 seconds
 * Prevents predictable patterns that exchanges might flag
 */
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

// ─── STARTUP ─────────────────────────────────────────────────────────────────

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE BTC TRADING BOT — HYPERLIQUID`);
console.log(`  Balance: $21.83 | Leverage: 40x | TP: $50 BTC move`);
console.log(`  Fees: 0.015% maker entry + 0.015% maker exit = 0.030%`);
console.log(`  Net per win: ~$0.13 | Target: 100-200 trades/day`);
console.log(`  Cycle: 60-90 second randomized intervals`);
console.log(`  Exchange: Hyperliquid | Server: AWS Tokyo ap-northeast-1`);
console.log(`  Mode: 24/7 — BTC never sleeps`);
console.log(`${'█'.repeat(65)}\n`);

// Verify config
if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing environment variables. Check .env:`);
    console.error(`   HYPERLIQUID_WALLET_ADDRESS=0x...`);
    console.error(`   HYPERLIQUID_API_SECRET=0x...`);
    console.error(`   GEMINI_API_KEY=...`);
    process.exit(1);
}

// Run first cycle immediately then randomize
runCycle().then(() => scheduleNextCycle());
