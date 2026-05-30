import ccxt from 'ccxt';
import { generateSignals, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import {
    executeHyperliquidTrade,
    getAvailableBalance,
    hasOpenPosition,
    getOpenPositionDetails,
    emergencyClose,
} from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    // Cycle: 90s–150s randomised → ~60–80 cycles/day
    // With maker fill window of 60s, real fills ~10-20/day in slow ranging Gold.
    CYCLE_MIN_MS:   90_000,
    CYCLE_MAX_MS:  150_000,
    MAX_TRADES_DAY: 200,

    // Emergency exit threshold — no regular SL, this catches black swans
    EMERGENCY_ADVERSE_USD: 40.00,

    // Recycle threshold — pocket profits above this, restart at half
    RECYCLE_BALANCE: 800,
    RECYCLE_KEEP:    400,
} as const;

// ─── EXCHANGE ────────────────────────────────────────────────────────────────

const exchange = new (ccxt as any).hyperliquid({
    apiKey:          process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    privateKey:      process.env.HYPERLIQUID_API_SECRET     ?? '',
    walletAddress:   process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    timeout:         15_000,
    enableRateLimit: true,
    options:         { defaultType: 'swap' },
});

// ─── DAILY STATS ─────────────────────────────────────────────────────────────

const stats = {
    date: '', trades: 0, filled: 0, cancelled: 0,
    emergencyExits: 0, realPnl: 0,
};

function checkReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) printDailySummary();
    if (stats.date !== today) {
        Object.assign(stats, { date: today, trades: 0, filled: 0, cancelled: 0, emergencyExits: 0, realPnl: 0 });
    }
}

function printDailySummary() {
    console.log(`\n${'█'.repeat(65)}`);
    console.log(`  DAILY — ${stats.date} | Attempts:${stats.trades} Fills:${stats.filled} Cancelled:${stats.cancelled}`);
    console.log(`  Emergency exits: ${stats.emergencyExits} | Real PnL: $${stats.realPnl.toFixed(4)}`);
    console.log(`${'█'.repeat(65)}\n`);
}

// ─── POSITION HEALTH CHECK ────────────────────────────────────────────────────
// Runs at the START of every cycle.
// If an open position has moved $40+ against entry → emergency market close.
// No regular SL — Gold oscillates. $40 is the black-swan protection only.

async function checkPositionHealth(): Promise<boolean> {
    const pos = await getOpenPositionDetails();
    if (!pos.exists || !pos.entryPrice || !pos.side) return false;

    try {
        const ticker = await exchange.fetchTicker(MARKET_SYMBOL);
        const currentPrice = ticker.last ?? pos.entryPrice;

        const adverseMove = pos.side === 'long'
            ? pos.entryPrice - currentPrice    // long: price fell
            : currentPrice - pos.entryPrice;   // short: price rose

        if (adverseMove > 0) {
            const emoji = adverseMove > 20 ? '🔴' : adverseMove > 10 ? '🟡' : '🟢';
            console.log(`[Health] ${emoji} Position ${pos.side.toUpperCase()} @ $${pos.entryPrice.toFixed(2)} | current $${currentPrice.toFixed(2)} | adverse $${adverseMove.toFixed(2)}`);
        }

        if (adverseMove >= CONFIG.EMERGENCY_ADVERSE_USD) {
            console.log(`[Health] 🚨 EMERGENCY EXIT TRIGGERED — $${adverseMove.toFixed(2)} adverse exceeds $${CONFIG.EMERGENCY_ADVERSE_USD} threshold`);
            await emergencyClose(pos.side, pos.size);
            stats.emergencyExits++;
            return true; // indicates emergency exit occurred this cycle
        }
    } catch (e: any) {
        console.error(`[Health] Check error: ${e.message}`);
    }

    return false; // position healthy, continue
}

// ─── REAL PnL TRACKER ─────────────────────────────────────────────────────────

async function updateRealPnl(): Promise<void> {
    try {
        const recentTrades = await (exchange as any).fetchMyTrades(MARKET_SYMBOL, undefined, 20);
        if (!recentTrades?.length) return;

        let realPnl = 0, wins = 0, losses = 0;
        for (const t of recentTrades) {
            const pnl = parseFloat(t.info?.closedPnl ?? t.info?.realizedPnl ?? '0');
            if (!isNaN(pnl) && pnl !== 0) {
                realPnl += pnl;
                if (pnl > 0) wins++; else losses++;
            }
        }

        if (wins + losses > 0) {
            const wr = ((wins / (wins + losses)) * 100).toFixed(0);
            console.log(`[Main] 📊 Last ${wins+losses} closed: $${realPnl.toFixed(4)} | W:${wins} L:${losses} WR:${wr}%`);
            stats.realPnl = realPnl;
            stats.filled  = wins + losses;
        }
    } catch { /* non-critical */ }
}

// ─── MATH HELPERS ────────────────────────────────────────────────────────────

function sma(candles: any[], period: number): number {
    const sl = candles.slice(-period);
    return sl.reduce((a: number, c: any) => a + Number(c?.[4] ?? 0), 0) / sl.length;
}

function calcRSI(candles: any[], period = 14): number {
    if (candles.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const diff = Number(candles[i]?.[4] ?? 0) - Number(candles[i - 1]?.[4] ?? 0);
        if (diff > 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    return 100 - 100 / (1 + (gains / period) / (losses / period));
}

function calcADX(candles: any[], period = 14): number {
    if (candles.length < period + 2) return 20;
    const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const hi = +c?.[2]||0, lo = +c?.[3]||0, phi = +p?.[2]||0, plo = +p?.[3]||0, pCl = +p?.[4]||0;
        trs.push(Math.max(hi - lo, Math.abs(hi - pCl), Math.abs(lo - pCl)));
        pDMs.push(hi - phi > plo - lo ? Math.max(hi - phi, 0) : 0);
        mDMs.push(plo - lo > hi - phi ? Math.max(plo - lo, 0) : 0);
    }
    const smooth = (arr: number[]) => {
        let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
        const out = [s];
        for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
        return out;
    };
    const sTR = smooth(trs), sP = smooth(pDMs), sM = smooth(mDMs);
    const dxs = sTR.map((tr, i) => {
        if (!tr) return 0;
        const pDI = sP[i] / tr * 100, mDI = sM[i] / tr * 100;
        return (pDI + mDI) ? Math.abs(pDI - mDI) / (pDI + mDI) * 100 : 0;
    });
    return dxs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── MARKET DATA ─────────────────────────────────────────────────────────────

async function fetchMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching GOLD market data...`);
    try {
        const [ticker, ob, c5m, c30m, c1h, c4h, c1w] = await Promise.all([
            exchange.fetchTicker(MARKET_SYMBOL),
            exchange.fetchOrderBook(MARKET_SYMBOL, 20),
            exchange.fetchOHLCV(MARKET_SYMBOL, '5m',  undefined, 30),
            exchange.fetchOHLCV(MARKET_SYMBOL, '30m', undefined, 10),
            exchange.fetchOHLCV(MARKET_SYMBOL, '1h',  undefined, 60),
            exchange.fetchOHLCV(MARKET_SYMBOL, '4h',  undefined, 10),
            exchange.fetchOHLCV(MARKET_SYMBOL, '1w',  undefined, 3),
        ]);

        const price = ticker.last ?? 0;
        if (!price) { console.warn(`[Data] No price`); return []; }

        // ATR on 5m
        let totalTR = 0, volSum = 0;
        const vols: number[] = [];
        for (let i = 1; i < c5m.length; i++) {
            const c = c5m[i], p = c5m[i - 1];
            if (!c || !p) continue;
            const hi = +c[2]||price, lo = +c[3]||price, pCl = +p[4]||price;
            totalTR += Math.max(hi - lo, Math.abs(hi - pCl), Math.abs(lo - pCl));
            const v = +c[5]||0; volSum += v; vols.push(v);
        }
        const atr5m      = totalTR / Math.max(c5m.length - 1, 1);
        const avgVol     = volSum / Math.max(vols.length, 1);
        const lastVol    = vols[vols.length - 1] ?? 0;
        const volumeRatio = avgVol > 0 ? lastVol / avgVol : 1;

        // EMA from 1h
        const ema8  = c1h.length >= 8  ? sma(c1h, 8)  : price;
        const ema21 = c1h.length >= 21 ? sma(c1h, 21) : price;
        const ema50 = c1h.length >= 50 ? sma(c1h, 50) : price;
        const emaTrend: 'bullish' | 'bearish' | 'neutral' =
            ema8 > ema21 && ema21 > ema50 ? 'bullish' :
            ema8 < ema21 && ema21 < ema50 ? 'bearish' : 'neutral';

        const rsi = calcRSI(c1h, 14);

        // Momentum
        const now   = +c5m[c5m.length - 1]?.[4] || price;
        const p5m   = +c5m[Math.max(0, c5m.length - 2)]?.[4] || price;
        const p30m  = +c30m[Math.max(0, c30m.length - 2)]?.[4] || price;
        const p1h   = +c1h[Math.max(0, c1h.length - 13)]?.[4] || price;
        const mom5m  = (now - p5m)  / p5m  * 100;
        const mom30m = (now - p30m) / p30m * 100;
        const mom1h  = (now - p1h)  / p1h  * 100;

        // 4h bias
        const c4hClose = +c4h[c4h.length - 1]?.[4] || price;
        const c4hPrev  = +c4h[Math.max(0, c4h.length - 2)]?.[4] || price;
        const trendBias4h: 'bull' | 'bear' | 'neutral' =
            c4hClose > c4hPrev * 1.001 ? 'bull' :
            c4hClose < c4hPrev * 0.999 ? 'bear' : 'neutral';

        // Weekly
        const wClose = +c1w[c1w.length - 1]?.[4] || price;
        const wPrev  = +c1w[Math.max(0, c1w.length - 2)]?.[4] || price;
        const weeklyBias: 'bullish' | 'bearish' | 'neutral' =
            wClose > wPrev ? 'bullish' : wClose < wPrev ? 'bearish' : 'neutral';

        // Structure
        const h24 = ticker.high ?? price, l24 = ticker.low ?? price;
        const mid = (h24 + l24) / 2;
        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            price > mid * 1.001 ? 'uptrend' :
            price < mid * 0.999 ? 'downtrend' : 'ranging';

        const adx = calcADX(c5m, 14);

        // Order book walls (lower threshold for Gold — thinner market than BTC)
        const wall = (levels: any[]) =>
            levels
                .map(l => ({ price: +l[0]||0, notionalUsd: +l[0]||0 * +l[1]||0 }))
                .filter(w => w.notionalUsd > 500)
                .slice(0, 5);

        const bidWalls = wall(ob.bids ?? []);
        const askWalls = wall(ob.asks ?? []);
        const nearestSupport    = bidWalls[0]?.price ?? price - 10;
        const nearestResistance = askWalls[0]?.price ?? price + 10;
        const bestBid = +ob.bids?.[0]?.[0] || price;
        const bestAsk = +ob.asks?.[0]?.[0] || price;
        const spreadUsd = Math.max(0, bestAsk - bestBid);

        let fundingRate: number | null = null;
        try {
            const fr = await exchange.fetchFundingRate(MARKET_SYMBOL);
            fundingRate = fr?.fundingRate ?? null;
        } catch { /* optional */ }

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50, rsi,
            momentum5m: mom5m, momentum30m: mom30m, momentum1h: mom1h,
            priceStructure, trendBias4h, weeklyBias,
            atr5m, atrPct: (atr5m / price) * 100, volumeRatio,
            nearestResistance, nearestSupport,
            distanceToResistance: nearestResistance - price,
            distanceToSupport:    price - nearestSupport,
            high24h: h24, low24h: l24, adx, fundingRate,
            spreadUsd,
        };

        // 24h range — key for detecting ranging market
        const range24h = h24 - l24;
        console.log(`[Data] GOLD $${price.toFixed(2)} | EMA:${emaTrend} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)}`);
        console.log(`[Data] Mom 5m:${mom5m.toFixed(4)}% 30m:${mom30m.toFixed(4)}% 1h:${mom1h.toFixed(4)}%`);
        console.log(`[Data] ATR:$${atr5m.toFixed(2)} | Vol:${volumeRatio.toFixed(2)}x | 24h range:$${range24h.toFixed(2)} | 4h:${trendBias4h} | Wk:${weeklyBias}`);

        return [{ symbol: DISPLAY_SYMBOL, price, change_24h: ticker.percentage ?? 0, indicators, orderBook: { bidWalls, askWalls } }];

    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
    checkReset();

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | Fills:${stats.filled} Cancelled:${stats.cancelled} Exits:${stats.emergencyExits} | PnL:$${stats.realPnl.toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.trades >= CONFIG.MAX_TRADES_DAY) {
        console.log(`[Main] Daily limit reached. Resting.`);
        return;
    }

    try {
        // ── STEP 1: Check position health (emergency exit if $40 adverse) ──
        const emergencyFired = await checkPositionHealth();
        if (emergencyFired) {
            await updateRealPnl();
            return; // skip signal generation this cycle
        }

        // ── STEP 2: If position open, skip signal (let TP work) ────────────
        if (await hasOpenPosition()) {
            console.log(`[Main] 📊 Position open — letting TP run. Next cycle.`);
            return;
        }

        // ── STEP 3: Balance check + recycle alert ─────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Main] Balance: $${balance.toFixed(4)} USDC`);

        if (balance >= CONFIG.RECYCLE_BALANCE) {
            console.log(`[Main] 🎯 RECYCLE THRESHOLD HIT — $${balance.toFixed(2)} ≥ $${CONFIG.RECYCLE_BALANCE}`);
            console.log(`[Main] 💰 Withdraw $${(balance - CONFIG.RECYCLE_KEEP).toFixed(2)}, keep $${CONFIG.RECYCLE_KEEP} working`);
            console.log(`[Main] ⏸️ Pausing trades until manual withdrawal confirmed.`);
            return;
        }

        // ── STEP 4: Fetch data + generate signal ───────────────────────────
        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No data.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') {
                console.log(`[Main] ⏸️ Neutral — skip.`);
                continue;
            }

            stats.trades++;
            const result = await executeHyperliquidTrade(signal);

            if (result.outcome === 'orders_placed') {
                stats.filled++;
            } else if (result.outcome === 'cancelled') {
                stats.cancelled++;
                stats.trades--;   // don't count cancelled as a trade attempt
            }
        }

        // ── STEP 5: Real PnL from exchange ────────────────────────────────
        await updateRealPnl();

    } catch (e: any) {
        console.error(`[Main] Cycle error: ${e.message}`);
    }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────

function scheduleNext(): void {
    const ms = Math.floor(
        Math.random() * (CONFIG.CYCLE_MAX_MS - CONFIG.CYCLE_MIN_MS) + CONFIG.CYCLE_MIN_MS
    );
    console.log(`[Main] Next cycle in ${(ms / 1000).toFixed(0)}s`);
    setTimeout(async () => { await runCycle(); scheduleNext(); }, ms);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────

if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing env:\n  HYPERLIQUID_WALLET_ADDRESS=0x...\n  HYPERLIQUID_API_SECRET=0x...\n  GEMINI_API_KEY=...\n  GEMINI_API_KEY2=... (optional)`);
    process.exit(1);
}

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE — GOLD PERP BOT (HYPERLIQUID)`);
console.log(`  Asset: GOLD/USDC:USDC | Leverage: 25x`);
console.log(`  TP: $5.00 | SL: NONE (range trading)`);
console.log(`  Emergency exit: $40 adverse move`);
console.log(`  Entry: PostOnly maker (0.0144%)`);
console.log(`  TP exit: PostOnly maker (0.0144%)`);
console.log(`  Recycle: pocket profits above $${CONFIG.RECYCLE_BALANCE}, keep $${CONFIG.RECYCLE_KEEP}`);
console.log(`  Cycle: 90–150s | Position health checked every cycle`);
console.log(`${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);