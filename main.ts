import ccxt from 'ccxt';
import { generateSignals, getSession, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
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
// The world's best scalper runs 24/7, banks 50% of every profit,
// and never manually intervenes unless the market is truly broken.

const CONFIG = {
    MAX_TRADES_DAY:  300,    // hard ceiling — ~1 attempt every 5 min over 24h

    // Emergency exit — $40 adverse move (>$20 warning, $40 action)
    EMERGENCY_ADVERSE_USD:  40.00,
    WARNING_ADVERSE_USD:    20.00,

    // Profit recycling — when real on-chain balance hits this, log alert
    RECYCLE_BALANCE: 800,
    RECYCLE_KEEP:    400,

    // Banking — 50% of net profit grows the virtual sizing balance,
    // 50% is "banked" (tracked in memory, represents withdrawable profit).
    BANK_FRACTION: 0.50,
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

interface DayStats {
    date:           string;
    attempts:       number;
    fills:          number;
    cancelled:      number;
    emergencyExits: number;
    realPnl:        number;
    sessionBanked:  number;
    grossProfit:    number;
    netProfit:      number;
    avgFillMs:      number;
    avgTpMs:        number;
    fillTimes:      number[];
    tpTimes:        number[];
}

let stats: DayStats = {
    date: '', attempts: 0, fills: 0, cancelled: 0, emergencyExits: 0,
    realPnl: 0, sessionBanked: 0, grossProfit: 0, netProfit: 0,
    avgFillMs: 0, avgTpMs: 0, fillTimes: [], tpTimes: [],
};

// ─── BANKING STATE ────────────────────────────────────────────────────────────
// virtualTradingBalance: used for sizing — grows by 50% of net profit.
// sessionBanked: cumulative 50% profit banked this session.
// Real on-chain USDC grows by 100% — bot just sizes off 50%.

let virtualTradingBalance = 0;
let sessionBanked         = 0;
let totalTrades           = 0;
let totalFills            = 0;
const startTime           = Date.now();
const initialBalance      = { value: 0, set: false };

function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) printDailySummary();
    if (stats.date !== today) {
        stats = {
            date: today, attempts: 0, fills: 0, cancelled: 0, emergencyExits: 0,
            realPnl: 0, sessionBanked: 0, grossProfit: 0, netProfit: 0,
            avgFillMs: 0, avgTpMs: 0, fillTimes: [], tpTimes: [],
        };
    }
}

function printDailySummary(): void {
    const totalValue  = virtualTradingBalance + sessionBanked;
    const uptime      = ((Date.now() - startTime) / 3600000).toFixed(1);
    const fillRate    = stats.attempts > 0 ? ((stats.fills / stats.attempts) * 100).toFixed(0) : '0';
    stats.avgFillMs   = stats.fillTimes.length > 0 ? stats.fillTimes.reduce((a,b)=>a+b,0) / stats.fillTimes.length : 0;
    stats.avgTpMs     = stats.tpTimes.length  > 0 ? stats.tpTimes.reduce((a,b)=>a+b,0)  / stats.tpTimes.length  : 0;

    console.log(`\n${'█'.repeat(65)}`);
    console.log(`  DAILY SUMMARY — ${stats.date}  (uptime: ${uptime}h)`);
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  Attempts: ${stats.attempts} | Fills: ${stats.fills} | Cancelled: ${stats.cancelled} | Fill rate: ${fillRate}%`);
    console.log(`  Emergency exits: ${stats.emergencyExits}`);
    console.log(`  Avg fill wait: ${(stats.avgFillMs/1000).toFixed(1)}s | Avg TP time: ${(stats.avgTpMs/1000).toFixed(0)}s`);
    console.log(`  Gross P&L: $${stats.grossProfit.toFixed(4)} | Net P&L: $${stats.netProfit.toFixed(4)}`);
    console.log(`  Banked today: $${stats.sessionBanked.toFixed(4)}`);
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  💼 Virtual trading balance: $${virtualTradingBalance.toFixed(4)}`);
    console.log(`  🏦 Session banked (all):    $${sessionBanked.toFixed(4)}`);
    console.log(`  📊 Total value:             $${totalValue.toFixed(4)}`);
    if (initialBalance.set && initialBalance.value > 0) {
        const returnPct = ((totalValue - initialBalance.value) / initialBalance.value * 100).toFixed(2);
        console.log(`  📈 Return since start:      ${returnPct}%`);
    }
    console.log(`${'█'.repeat(65)}\n`);
}

// ─── POSITION HEALTH CHECK ────────────────────────────────────────────────────
// Runs at the start of every cycle.
// Warn at $20 adverse, emergency close at $40.
// No regular SL — Gold oscillates. This is only black-swan protection.

async function checkPositionHealth(): Promise<boolean> {
    const pos = await getOpenPositionDetails();
    if (!pos.exists || !pos.entryPrice || !pos.side) return false;

    try {
        const ticker       = await exchange.fetchTicker(MARKET_SYMBOL);
        const currentPrice = ticker.last ?? pos.entryPrice;

        const adverseMove = pos.side === 'long'
            ? pos.entryPrice - currentPrice
            : currentPrice  - pos.entryPrice;

        if (adverseMove > 0) {
            const emoji = adverseMove >= CONFIG.WARNING_ADVERSE_USD ? '🔴' :
                          adverseMove >= 10 ? '🟡' : '🟢';
            console.log(`[Health] ${emoji} ${pos.side.toUpperCase()} @ $${pos.entryPrice.toFixed(2)} | now $${currentPrice.toFixed(2)} | adverse $${adverseMove.toFixed(2)}`);
        } else {
            const favour = Math.abs(adverseMove);
            console.log(`[Health] ✅ ${pos.side.toUpperCase()} @ $${pos.entryPrice.toFixed(2)} | now $${currentPrice.toFixed(2)} | +$${favour.toFixed(2)} in favour`);
        }

        if (adverseMove >= CONFIG.EMERGENCY_ADVERSE_USD) {
            console.log(`[Health] 🚨 EMERGENCY EXIT — $${adverseMove.toFixed(2)} adverse exceeds $${CONFIG.EMERGENCY_ADVERSE_USD} threshold!`);
            await emergencyClose(pos.side, pos.size);
            stats.emergencyExits++;
            return true;
        }
    } catch (e: any) {
        console.error(`[Health] Check error: ${e.message}`);
    }

    return false;
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
            console.log(`[Main] 📊 Recent ${wins+losses} closed: $${realPnl.toFixed(4)} | W:${wins} L:${losses} WR:${wr}%`);
            stats.realPnl = realPnl;
        }
    } catch { /* non-critical */ }
}

// ─── MATH HELPERS ────────────────────────────────────────────────────────────

function ema(candles: any[], period: number): number {
    // True EMA (exponential) rather than SMA — better for trend detection
    if (candles.length < period) return Number(candles[candles.length-1]?.[4] ?? 0);
    const k = 2 / (period + 1);
    let val = candles.slice(0, period).reduce((s: number, c: any) => s + Number(c?.[4] ?? 0), 0) / period;
    for (let i = period; i < candles.length; i++) {
        val = Number(candles[i]?.[4] ?? val) * k + val * (1 - k);
    }
    return val;
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
    const smooth = (arr: number[]): number[] => {
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

// ─── VWAP (approximate intraday) ──────────────────────────────────────────────
function calcVwap(candles: any[]): number {
    let tpvSum = 0, volSum = 0;
    for (const c of candles) {
        const hi = +c?.[2]||0, lo = +c?.[3]||0, cl = +c?.[4]||0, vol = +c?.[5]||0;
        const tp = (hi + lo + cl) / 3;
        tpvSum += tp * vol;
        volSum += vol;
    }
    return volSum > 0 ? tpvSum / volSum : 0;
}

// ─── SWING HIGH/LOW ───────────────────────────────────────────────────────────
function calcSwings(candles: any[], lookback = 20): { high: number; low: number } {
    const slice = candles.slice(-lookback);
    let high = 0, low = Infinity;
    for (const c of slice) {
        const h = +c?.[2]||0, l = +c?.[3]||Infinity;
        if (h > high) high = h;
        if (l < low)  low  = l;
    }
    return { high, low: low === Infinity ? 0 : low };
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function fetchMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching GOLD market data...`);
    try {
        const [ticker, ob, c5m, c30m, c1h, c4h, c1w] = await Promise.all([
            exchange.fetchTicker(MARKET_SYMBOL),
            exchange.fetchOrderBook(MARKET_SYMBOL, 20),
            exchange.fetchOHLCV(MARKET_SYMBOL, '5m',  undefined, 50),  // more candles for VWAP
            exchange.fetchOHLCV(MARKET_SYMBOL, '30m', undefined, 12),
            exchange.fetchOHLCV(MARKET_SYMBOL, '1h',  undefined, 60),
            exchange.fetchOHLCV(MARKET_SYMBOL, '4h',  undefined, 10),
            exchange.fetchOHLCV(MARKET_SYMBOL, '1w',  undefined, 3),
        ]);

        const price = ticker.last ?? 0;
        if (!price) { console.warn(`[Data] No price`); return []; }

        // ── ATR on 5m ─────────────────────────────────────────────────────
        let totalTR = 0, volSum = 0;
        const vols: number[] = [];
        for (let i = 1; i < c5m.length; i++) {
            const c = c5m[i], p = c5m[i - 1];
            if (!c || !p) continue;
            const hi = +c[2]||price, lo = +c[3]||price, pCl = +p[4]||price;
            totalTR += Math.max(hi - lo, Math.abs(hi - pCl), Math.abs(lo - pCl));
            const v = +c[5]||0; volSum += v; vols.push(v);
        }
        const atr5m       = totalTR / Math.max(c5m.length - 1, 1);
        const avgVol      = volSum / Math.max(vols.length, 1);
        const lastVol     = vols[vols.length - 1] ?? 0;
        const volumeRatio = avgVol > 0 ? lastVol / avgVol : 1;

        // ── EMA (true exponential) from 1h ────────────────────────────────
        const ema8  = ema(c1h, 8);
        const ema21 = ema(c1h, 21);
        const ema50 = ema(c1h, 50);
        const emaTrend: 'bullish' | 'bearish' | 'neutral' =
            ema8 > ema21 && ema21 > ema50 ? 'bullish' :
            ema8 < ema21 && ema21 < ema50 ? 'bearish' : 'neutral';

        const rsi = calcRSI(c1h, 14);

        // ── Momentum ─────────────────────────────────────────────────────
        const now   = +c5m[c5m.length - 1]?.[4]  || price;
        const p5m   = +c5m[Math.max(0, c5m.length - 2)]?.[4]  || price;
        const p30m  = +c30m[Math.max(0, c30m.length - 2)]?.[4] || price;
        const p1h   = +c1h[Math.max(0, c1h.length - 13)]?.[4] || price;
        const mom5m  = (now - p5m)  / (p5m  || 1) * 100;
        const mom30m = (now - p30m) / (p30m || 1) * 100;
        const mom1h  = (now - p1h)  / (p1h  || 1) * 100;

        // ── 4h bias ───────────────────────────────────────────────────────
        const c4hClose = +c4h[c4h.length - 1]?.[4] || price;
        const c4hPrev  = +c4h[Math.max(0, c4h.length - 2)]?.[4] || price;
        const trendBias4h: 'bull' | 'bear' | 'neutral' =
            c4hClose > c4hPrev * 1.001 ? 'bull' :
            c4hClose < c4hPrev * 0.999 ? 'bear' : 'neutral';

        // ── Weekly bias ───────────────────────────────────────────────────
        const wClose = +c1w[c1w.length - 1]?.[4] || price;
        const wPrev  = +c1w[Math.max(0, c1w.length - 2)]?.[4] || price;
        const weeklyBias: 'bullish' | 'bearish' | 'neutral' =
            wClose > wPrev ? 'bullish' : wClose < wPrev ? 'bearish' : 'neutral';

        // ── Price structure ───────────────────────────────────────────────
        const h24 = ticker.high ?? price, l24 = ticker.low ?? price;
        const mid = (h24 + l24) / 2;
        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            price > mid * 1.001 ? 'uptrend' :
            price < mid * 0.999 ? 'downtrend' : 'ranging';

        const adx = calcADX(c5m, 14);

        // ── Order book walls ──────────────────────────────────────────────
        const wallFilter = (levels: any[]) =>
            levels
                .map(l => ({ price: +l[0]||0, notionalUsd: (+l[0]||0) * (+l[1]||0) }))
                .filter(w => w.notionalUsd > 500)
                .slice(0, 5);

        const bidWalls = wallFilter(ob.bids ?? []);
        const askWalls = wallFilter(ob.asks ?? []);
        const nearestSupport    = bidWalls[0]?.price ?? price - 10;
        const nearestResistance = askWalls[0]?.price ?? price + 10;

        const bestBid    = +ob.bids?.[0]?.[0] || price;
        const bestAsk    = +ob.asks?.[0]?.[0] || price;
        const spreadUsd  = Math.max(0, bestAsk - bestBid);

        // ── OB imbalance (top 5 levels) ───────────────────────────────────
        const bidVol = ob.bids?.slice(0,5).reduce((s: number, l: any[]) => s + (+l[1]||0), 0) ?? 0;
        const askVol = ob.asks?.slice(0,5).reduce((s: number, l: any[]) => s + (+l[1]||0), 0) ?? 0;
        const totalObVol = bidVol + askVol;
        const obImbalance = totalObVol > 0 ? (bidVol - askVol) / totalObVol : 0;

        // ── VWAP ─────────────────────────────────────────────────────────
        const vwap       = calcVwap(c5m);
        const priceVsVwap = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

        // ── Swing high/low from 5m (last 20 candles) ──────────────────────
        const swings = calcSwings(c5m, 20);

        // ── Funding rate ──────────────────────────────────────────────────
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
            spreadUsd, obImbalance, priceVsVwap,
            recentSwingHigh: swings.high,
            recentSwingLow:  swings.low,
        };

        const range24h = h24 - l24;
        const rangePos = range24h > 0 ? ((price - l24) / range24h * 100).toFixed(0) : '50';
        console.log(`[Data] $${price.toFixed(2)} EMA:${emaTrend} RSI:${rsi.toFixed(1)} ADX:${adx.toFixed(1)} OBI:${(obImbalance*100).toFixed(0)}%`);
        console.log(`[Data] Range pos: ${rangePos}% | Spread: $${spreadUsd.toFixed(3)} | VWAP: $${vwap.toFixed(2)} (${priceVsVwap.toFixed(3)}%)`);
        console.log(`[Data] Mom 5m:${mom5m.toFixed(4)}% 30m:${mom30m.toFixed(4)}% 1h:${mom1h.toFixed(4)}% | 24h range: $${range24h.toFixed(2)}`);

        return [{
            symbol:     DISPLAY_SYMBOL,
            price,
            change_24h: ticker.percentage ?? 0,
            indicators,
            orderBook:  { bidWalls, askWalls },
        }];

    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
    checkReset();
    totalTrades++;

    const session = getSession();
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | ${session.name} [${session.quality}]`);
    console.log(`[Main] Day: attempts=${stats.attempts} fills=${stats.fills} cancelled=${stats.cancelled} exits=${stats.emergencyExits}`);
    console.log(`[Main] Balance (virtual): $${virtualTradingBalance.toFixed(4)} | Banked: $${sessionBanked.toFixed(4)} | Total: $${(virtualTradingBalance+sessionBanked).toFixed(4)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.attempts >= CONFIG.MAX_TRADES_DAY) {
        console.log(`[Main] Daily limit ${CONFIG.MAX_TRADES_DAY} reached. Resting until midnight.`);
        return;
    }

    try {
        // ── STEP 1: Position health check ─────────────────────────────────
        const emergencyFired = await checkPositionHealth();
        if (emergencyFired) {
            await updateRealPnl();
            return;
        }

        // ── STEP 2: If position is open, let TP work — don't pile in ──────
        if (await hasOpenPosition()) {
            console.log(`[Main] 📊 Position open — letting TP run.`);
            return;
        }

        // ── STEP 3: Balance check ──────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Main] On-chain balance: $${balance.toFixed(4)} USDC`);

        // Initialise virtual balance on first cycle
        if (virtualTradingBalance <= 0) {
            virtualTradingBalance = balance;
            initialBalance.value  = balance;
            initialBalance.set    = true;
            console.log(`[Bank] 💰 Virtual balance init: $${virtualTradingBalance.toFixed(4)}`);
        }

        if (balance < 1.50) {
            console.log(`[Main] ⚠️ Balance $${balance.toFixed(4)} too low. Stopping.`);
            return;
        }

        // Recycle alert
        if (balance >= CONFIG.RECYCLE_BALANCE) {
            console.log(`[Main] 🎯 RECYCLE ALERT — $${balance.toFixed(2)} ≥ $${CONFIG.RECYCLE_BALANCE}`);
            console.log(`[Main] 💰 Consider withdrawing $${(balance - CONFIG.RECYCLE_KEEP).toFixed(2)}, keeping $${CONFIG.RECYCLE_KEEP}.`);
            // Does NOT stop trading — just logs the opportunity
        }

        // ── STEP 4: Fetch market data + generate signal ────────────────────
        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No data.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') {
                console.log(`[Main] ⏸️ Neutral — skip.`);
                continue;
            }

            stats.attempts++;
            totalFills++;

            const result = await executeHyperliquidTrade(signal, virtualTradingBalance);

            if (result.outcome === 'tp_confirmed' && result.netProfit !== undefined) {
                // ── BANKING: 50% banked, 50% compounds ────────────────────
                const net       = result.netProfit;
                const banked    = net * CONFIG.BANK_FRACTION;
                const compound  = net * (1 - CONFIG.BANK_FRACTION);

                sessionBanked         += banked;
                virtualTradingBalance += compound;
                stats.fills++;
                stats.sessionBanked   += banked;
                stats.grossProfit     += result.grossProfit ?? 0;
                stats.netProfit       += net;

                if (result.fillTimeMs) stats.fillTimes.push(result.fillTimeMs);
                if (result.tpTimeMs)   stats.tpTimes.push(result.tpTimeMs);

                console.log(`[Bank] ✅ Net=$${net.toFixed(4)} Banked=$${banked.toFixed(4)} | vBal=$${virtualTradingBalance.toFixed(4)} AllBanked=$${sessionBanked.toFixed(4)}`);
                console.log(`[Bank] 📊 Total value: $${(virtualTradingBalance + sessionBanked).toFixed(4)}`);

            } else if (result.outcome === 'orders_placed') {
                // TP not confirmed yet (poll timeout) — orders still live
                stats.fills++;
                if (result.fillTimeMs) stats.fillTimes.push(result.fillTimeMs);

            } else if (result.outcome === 'cancelled') {
                stats.cancelled++;
                stats.attempts--;   // cancelled = not a real attempt
            } else if (result.outcome === 'error') {
                console.error(`[Main] Trade error: ${result.message}`);
            }
        }

        // ── STEP 5: Update real PnL from exchange ────────────────────────
        await updateRealPnl();

    } catch (e: any) {
        console.error(`[Main] Cycle error: ${e.message}`);
    }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
// Uses session-aware timing exported from signals.ts.
// PEAK hours: 45-75s cycles. LOW hours: 80-130s cycles.
// Randomised to avoid pattern detection.

function scheduleNext(): void {
    const session = getSession();
    const ms = Math.floor(
        Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin
    );
    console.log(`[Main] Next cycle in ${(ms / 1000).toFixed(0)}s [${session.name}]`);
    setTimeout(async () => {
        try {
            await runCycle();
        } catch (e: any) {
            console.error(`[Main] Uncaught cycle error: ${e.message}`);
        }
        scheduleNext();
    }, ms);
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
    console.log(`\n[Main] SIGTERM — printing final summary...`);
    printDailySummary();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log(`\n[Main] SIGINT — printing final summary...`);
    printDailySummary();
    process.exit(0);
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────

if (!process.env.HYPERLIQUID_WALLET_ADDRESS || !process.env.HYPERLIQUID_API_SECRET) {
    console.error(`❌ Missing environment variables:
  HYPERLIQUID_WALLET_ADDRESS=0x...
  HYPERLIQUID_API_SECRET=0x...
  GEMINI_API_KEY=...
  GEMINI_API_KEY2=... (optional fallback)`);
    process.exit(1);
}

console.log(`\n${'█'.repeat(65)}`);
console.log(`  MODUVISE GOLD PERP BOT — HYPERLIQUID`);
console.log(`  ─────────────────────────────────────────────────────────`);
console.log(`  Asset:     GOLD/USDC:USDC perp`);
console.log(`  Leverage:  25x isolated`);
console.log(`  TP:        $2.00 PostOnly (maker exit)`);
console.log(`  SL:        NONE — range trading strategy`);
console.log(`  Emergency: $40 adverse move → market close`);
console.log(`  Entry:     PostOnly limit @ best bid/ask (0.0144%)`);
console.log(`  Banking:   50% of net profit banked per trade`);
console.log(`  Timing:    45–75s (PEAK) / 80–130s (LOW)`);
console.log(`  Start:     ${new Date().toISOString()}`);
console.log(`${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);
