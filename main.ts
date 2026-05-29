import ccxt from 'ccxt';
import { generateSignals, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import { executeHyperliquidTrade, getAvailableBalance, hasOpenPosition } from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    CYCLE_MIN_MS:   120_000,   // 2 minutes minimum between cycles
    CYCLE_MAX_MS:   180_000,   // 3 minutes maximum
    MAX_TRADES_DAY: 200,
} as const;

// ─── EXCHANGE ────────────────────────────────────────────────────────────────

const exchange = new (ccxt as any).hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    privateKey:    process.env.HYPERLIQUID_API_SECRET     ?? '',
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    timeout:       15_000,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
});

// ─── DAILY STATS ─────────────────────────────────────────────────────────────

const stats = { date: '', trades: 0, wins: 0, losses: 0, cancelled: 0, pnl: 0 };

function checkReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) {
        const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
        console.log(`\n${'█'.repeat(65)}`);
        console.log(`  DAILY — ${stats.date} | Trades:${stats.trades} W:${stats.wins} L:${stats.losses} WR:${wr}%`);
        console.log(`  PnL: $${stats.pnl.toFixed(4)} USDC`);
        console.log(`${'█'.repeat(65)}\n`);
    }
    if (stats.date !== today) Object.assign(stats, { date: today, trades: 0, wins: 0, losses: 0, cancelled: 0, pnl: 0 });
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
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
}

function calcADX(candles: any[], period = 14): number {
    if (candles.length < period + 2) return 20;
    const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const hi = Number(c?.[2] ?? 0), lo = Number(c?.[3] ?? 0);
        const phi = Number(p?.[2] ?? 0), plo = Number(p?.[3] ?? 0), pCl = Number(p?.[4] ?? 0);
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
    const sTR = smooth(trs), sPDM = smooth(pDMs), sMDM = smooth(mDMs);
    const dxs = sTR.map((tr, i) => {
        if (!tr) return 0;
        const pDI = sPDM[i] / tr * 100, mDI = sMDM[i] / tr * 100;
        const denom = pDI + mDI;
        return denom ? Math.abs(pDI - mDI) / denom * 100 : 0;
    });
    const adxSlice = dxs.slice(-period);
    return adxSlice.reduce((a, b) => a + b, 0) / adxSlice.length;
}

// ─── MARKET DATA ─────────────────────────────────────────────────────────────

async function fetchMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching...`);
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
            const cur = c5m[i], prv = c5m[i - 1];
            if (!cur || !prv) continue;
            const hi = Number(cur[2] ?? price), lo = Number(cur[3] ?? price), pCl = Number(prv[4] ?? price);
            totalTR += Math.max(hi - lo, Math.abs(hi - pCl), Math.abs(lo - pCl));
            const v = Number(cur[5] ?? 0); volSum += v; vols.push(v);
        }
        const atr5m   = totalTR / Math.max(c5m.length - 1, 1);
        const avgVol  = volSum / Math.max(vols.length, 1);
        const lastVol = vols[vols.length - 1] ?? 0;
        const volumeRatio = avgVol > 0 ? lastVol / avgVol : 1;

        // EMA from 1h
        const ema8  = c1h.length >= 8  ? sma(c1h, 8)  : price;
        const ema21 = c1h.length >= 21 ? sma(c1h, 21) : price;
        const ema50 = c1h.length >= 50 ? sma(c1h, 50) : price;
        const emaTrend: 'bullish' | 'bearish' | 'neutral' =
            ema8 > ema21 && ema21 > ema50 ? 'bullish' :
            ema8 < ema21 && ema21 < ema50 ? 'bearish' : 'neutral';

        // RSI on 1h candles (14 period)
        const rsi = calcRSI(c1h, 14);

        // Momentum
        const closeNow  = Number(c5m[c5m.length - 1]?.[4]  ?? price);
        const close5m   = Number(c5m[Math.max(0, c5m.length - 2)]?.[4]  ?? price);
        const close30m  = Number(c30m[Math.max(0, c30m.length - 2)]?.[4] ?? price);
        const close1h   = Number(c1h[Math.max(0, c1h.length - 13)]?.[4]  ?? price);
        const mom5m  = ((closeNow - close5m)  / close5m)  * 100;
        const mom30m = ((closeNow - close30m) / close30m) * 100;
        const mom1h  = ((closeNow - close1h)  / close1h)  * 100;

        // 4h bias
        const c4hClose = Number(c4h[c4h.length - 1]?.[4]  ?? price);
        const c4hPrev  = Number(c4h[Math.max(0, c4h.length - 2)]?.[4] ?? price);
        const trendBias4h: 'bull' | 'bear' | 'neutral' =
            c4hClose > c4hPrev * 1.001 ? 'bull' :
            c4hClose < c4hPrev * 0.999 ? 'bear' : 'neutral';

        // Weekly bias
        const wkClose = Number(c1w[c1w.length - 1]?.[4] ?? price);
        const wkPrev  = Number(c1w[Math.max(0, c1w.length - 2)]?.[4] ?? price);
        const weeklyBias: 'bullish' | 'bearish' | 'neutral' =
            wkClose > wkPrev ? 'bullish' : wkClose < wkPrev ? 'bearish' : 'neutral';

        // Structure
        const h24 = ticker.high ?? price, l24 = ticker.low ?? price;
        const mid = (h24 + l24) / 2;
        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            price > mid * 1.001 ? 'uptrend' :
            price < mid * 0.999 ? 'downtrend' : 'ranging';

        // ADX
        const adx = calcADX(c5m, 14);

        // Order book walls
        const wall = (levels: any[]): Array<{ price: number; notionalUsd: number }> =>
            levels
                .map(l => ({ price: Number(l[0] ?? 0), notionalUsd: Number(l[0] ?? 0) * Number(l[1] ?? 0) }))
                .filter(w => w.notionalUsd > 5_000)
                .slice(0, 5);

        const bidWalls = wall(ob.bids ?? []);
        const askWalls = wall(ob.asks ?? []);
        const nearestSupport     = bidWalls[0]?.price ?? price - 200;
        const nearestResistance  = askWalls[0]?.price ?? price + 200;

        // Funding rate
        let fundingRate: number | null = null;
        try {
            const fr = await exchange.fetchFundingRate(MARKET_SYMBOL);
            fundingRate = fr?.fundingRate ?? null;
        } catch { /* optional */ }

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50,
            rsi,
            momentum5m:  mom5m,
            momentum30m: mom30m,
            momentum1h:  mom1h,
            priceStructure,
            trendBias4h,
            weeklyBias,
            atr5m,
            atrPct: (atr5m / price) * 100,
            volumeRatio,
            nearestResistance,
            nearestSupport,
            distanceToResistance: nearestResistance - price,
            distanceToSupport:    price - nearestSupport,
            high24h: h24,
            low24h:  l24,
            adx,
            fundingRate,
        };

        console.log(`[Data] BTC $${price.toFixed(2)} | EMA:${emaTrend} | RSI:${rsi.toFixed(1)} | ADX:${adx.toFixed(1)}`);
        console.log(`[Data] Mom 5m:${mom5m.toFixed(4)}% 30m:${mom30m.toFixed(4)}% 1h:${mom1h.toFixed(4)}%`);
        console.log(`[Data] Vol:${volumeRatio.toFixed(2)}x | ATR:$${atr5m.toFixed(2)} | 4h:${trendBias4h} | Weekly:${weeklyBias}`);
        console.log(`[Data] Sup:$${nearestSupport.toFixed(2)}(${(price-nearestSupport).toFixed(0)} away) Res:$${nearestResistance.toFixed(2)}(${(nearestResistance-price).toFixed(0)} away)`);

        return [{ symbol: DISPLAY_SYMBOL, price, change_24h: ticker.percentage ?? 0, indicators, orderBook: { bidWalls, askWalls } }];

    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`);
        return [];
    }
}

// ─── CYCLE ────────────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
    if (stats.trades >= CONFIG.MAX_TRADES_DAY) { console.log(`[Main] Daily limit. Resting.`); return; }

    try {
        // QUICK CHECK: Are we already in a trade? Skip Gemini completely to save quotas!
        if (await hasOpenPosition()) {
            console.log(`[Main] 🛑 Position is currently open. Sleeping to save API quota.`);
            return;
        }

        const assets = await fetchMarketData();
    checkReset();

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | Trades:${stats.trades}/${CONFIG.MAX_TRADES_DAY} | W:${stats.wins} L:${stats.losses} | PnL:$${stats.pnl.toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.trades >= CONFIG.MAX_TRADES_DAY) { console.log(`[Main] Daily limit. Resting.`); return; }

    try {
        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No data.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') {
                console.log(`[Main] ⏸️ Neutral — no trade.`);
                continue;
            }

            stats.trades++;
            const result = await executeHyperliquidTrade(signal);

            if (result.outcome === 'orders_placed') {
                // Trade placed — TP/SL live on Hyperliquid. Not a win yet.
                // Win/loss determined when position closes (next cycle detects via closedPnl).
            } else if (result.outcome === 'error') {
                stats.losses++;
            } else if (result.outcome === 'cancelled') {
                stats.cancelled++;
                stats.trades--;
            }
        }

        const bal = await getAvailableBalance();
        console.log(`[Main] Balance: $${bal.toFixed(4)} USDC`);

        // ── REAL PnL from last 10 closed trades ───────────────────────────
        try {
            const recentTrades = await (exchange as any).fetchMyTrades(MARKET_SYMBOL, undefined, 10);
            if (recentTrades?.length > 0) {
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
                    console.log(`[Main] 📊 Real PnL (last ${wins+losses} closed): $${realPnl.toFixed(4)} | W:${wins} L:${losses} WR:${wr}%`);
                    stats.wins = wins; stats.losses = losses; stats.pnl = realPnl;
                }
            }
        } catch { /* non-critical */ }

    } catch (e: any) {
        console.error(`[Main] Cycle error: ${e.message}`);
    }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────

function scheduleNext(): void {
    const ms = Math.floor(Math.random() * (CONFIG.CYCLE_MAX_MS - CONFIG.CYCLE_MIN_MS) + CONFIG.CYCLE_MIN_MS);
    console.log(`[Main] Next cycle in ${(ms / 1000 / 60).toFixed(1)} min`);
    setTimeout(async () => { await runCycle(); scheduleNext(); }, ms);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────

if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing env:\n  HYPERLIQUID_WALLET_ADDRESS=0x...\n  HYPERLIQUID_API_SECRET=0x...\n  GEMINI_API_KEY=...\n  GEMINI_API_KEY2=... (optional backup)`);
    process.exit(1);
}

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE — HYPERLIQUID BTC PERP BOT`);
console.log(`  Leverage: 40x | TP: $70 | SL: $70 (1:1)`);
console.log(`  Entry: PostOnly maker only — guaranteed 0.0144%`);
console.log(`  Signals: 24/7 — only pause on ATR>$200 + vol>3x`);
console.log(`  Gemini: multi-key failover → local math fallback`);
console.log(`  Cycle: 2-3 min | ~100-150 attempts/day`);
console.log(`  No while-loops — TP/SL live on Hyperliquid order book`);
console.log(`${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);
