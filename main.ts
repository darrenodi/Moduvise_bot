import { generateSignals, getSession, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import {
    executeBinanceTrade,
    getAvailableBalance,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    getOrderStatus,
    emergencyClose,
    calcSize,
    BASE_URL,
    privateDelete,
} from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    MAX_TRADES_DAY:      400,
    MAX_TRADING_BALANCE: 25_000,
    BANK_THRESHOLD:      5.00,       // accumulate until $5 before any spot transfer
    BANK_FRACTION:       0.30,       // 30% to spot when threshold crossed
    RECYCLE_BALANCE:     800,
    RECYCLE_KEEP:        400,
    // Monitoring: runs on a SEPARATE loop from the signal cycle.
    // Checks every 5s while a position is open.
    // NOT responsible for SL — exchange STOP_MARKET handles that.
    // Responsible for: detecting TP fill, detecting orphan positions,
    // cleaning up if both bracket orders disappear unexpectedly.
    MONITOR_INTERVAL_MS: 5_000,
} as const;

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

// ─── BANKING ──────────────────────────────────────────────────────────────────

let virtualTradingBalance  = 0;
let accumulatedNetProfit   = 0;
let totalBanked            = 0;
const startTime            = Date.now();
const initialBalance       = { value: 0, set: false };

function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date !== today) { printDailySummary(); stats = freshStats(); stats.date = today; }
}

function printDailySummary(): void {
    const total   = virtualTradingBalance + totalBanked;
    const uptime  = ((Date.now() - startTime) / 3_600_000).toFixed(1);
    const tpRate  = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    const avgFill = stats.fillTimes.length
        ? (stats.fillTimes.reduce((a, b) => a + b, 0) / stats.fillTimes.length / 1000).toFixed(1) : '0';
    console.log(`\n${'█'.repeat(65)}`);
    console.log(`📊 ${stats.date} (${uptime}h) | ${stats.fills} trades | TP:${stats.tpHits}(${tpRate}%) SL:${stats.slHits} Skip:${stats.skipped}`);
    console.log(`Gross: $${stats.grossProfit.toFixed(4)} | Net: $${stats.netProfit.toFixed(4)} | SL loss: $${stats.slLoss.toFixed(4)}`);
    console.log(`Avg fill: ${avgFill}s | Pending bank: $${accumulatedNetProfit.toFixed(4)}`);
    console.log(`💼 $${virtualTradingBalance.toFixed(2)} trading | 🏦 $${totalBanked.toFixed(2)} banked | Total: $${total.toFixed(2)}`);
    if (initialBalance.set) console.log(`📈 Return: ${((total - initialBalance.value) / initialBalance.value * 100).toFixed(2)}%`);
    console.log(`${'█'.repeat(65)}\n`);
}

function bankProfit(net: number): void {
    if (net <= 0) {
        // SL hit — deduct from balance
        virtualTradingBalance = Math.max(1.50, virtualTradingBalance + net);
        stats.slLoss  -= net; // net is negative, slLoss accumulates positive
        stats.netProfit += net;
        console.log(`[Bank] SL loss $${net.toFixed(4)} | vBal=$${virtualTradingBalance.toFixed(2)}`);
        return;
    }

    accumulatedNetProfit += net;
    stats.grossProfit    += net;
    stats.netProfit      += net;

    console.log(`[Bank] +$${net.toFixed(4)} | accumulated=$${accumulatedNetProfit.toFixed(4)} / threshold=$${CONFIG.BANK_THRESHOLD}`);

    if (virtualTradingBalance >= CONFIG.MAX_TRADING_BALANCE) {
        // At cap — bank everything
        totalBanked += net;
        accumulatedNetProfit = 0;
        console.log(`[Bank] 🏦 At cap — banked $${net.toFixed(4)} | total=$${totalBanked.toFixed(2)}`);
        return;
    }

    if (accumulatedNetProfit >= CONFIG.BANK_THRESHOLD) {
        const toSpot    = accumulatedNetProfit * CONFIG.BANK_FRACTION;
        const toBalance = accumulatedNetProfit * (1 - CONFIG.BANK_FRACTION);
        totalBanked           += toSpot;
        virtualTradingBalance  = Math.min(virtualTradingBalance + toBalance, CONFIG.MAX_TRADING_BALANCE);
        accumulatedNetProfit   = 0;
        console.log(`[Bank] 💸 $${toSpot.toFixed(4)} → spot | $${toBalance.toFixed(4)} → balance`);
        console.log(`[Bank] vBal=$${virtualTradingBalance.toFixed(2)} | banked=$${totalBanked.toFixed(2)} | total=$${(virtualTradingBalance + totalBanked).toFixed(2)}`);
        console.log(`[Bank] ⚠️  ACTION: Transfer $${toSpot.toFixed(4)} from futures to spot now.`);
    } else {
        virtualTradingBalance = Math.min(virtualTradingBalance + net, CONFIG.MAX_TRADING_BALANCE);
        console.log(`[Bank] Compounding | vBal=$${virtualTradingBalance.toFixed(2)}`);
    }
}

// ─── MONITORING LOOP ──────────────────────────────────────────────────────────
// Runs every 5 seconds while a position is active.
// PRIMARY SL is exchange-side STOP_MARKET — this is a BACKUP safety net.
// Detects: TP fill (position gone + TP order FILLED), SL hit (position gone +
// SL order FILLED), orphan (position exists but no local record), stale brackets
// (both orders cancelled/expired but position still open).

let monitorTimer: ReturnType<typeof setTimeout> | null = null;

function stopMonitor(): void {
    if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
}

function startMonitor(): void {
    stopMonitor();
    monitorTimer = setTimeout(runMonitor, CONFIG.MONITOR_INTERVAL_MS);
}

async function runMonitor(): Promise<void> {
    const trade = getActiveTrade();
    if (!trade) { stopMonitor(); return; }

    try {
        const pos = await getOpenPositionDetails();

        if (!pos.exists) {
            // Position closed — determine if TP or SL hit
            let outcome: 'tp' | 'sl' = 'tp'; // default assume TP

            if (trade.tpOrderId) {
                const tpStatus = await getOrderStatus(trade.tpOrderId);
                if (tpStatus === 'FILLED') {
                    outcome = 'tp';
                } else if (tpStatus === 'CANCELED' || tpStatus === 'EXPIRED') {
                    outcome = 'sl'; // TP was cancelled → SL must have fired
                }
            }

            if (trade.slOrderId) {
                const slStatus = await getOrderStatus(trade.slOrderId);
                if (slStatus === 'FILLED') outcome = 'sl';
            }

            if (outcome === 'tp') {
                console.log(`[Monitor] ✅ TP confirmed — +$${trade.grossProfit.toFixed(4)}`);
                stats.fills++;
                stats.tpHits++;
                bankProfit(trade.netProfit);
            } else {
                const slLoss = trade.size * Math.abs(trade.slPrice - trade.entryPrice);
                console.log(`[Monitor] 🛑 SL confirmed — -$${slLoss.toFixed(4)}`);
                stats.fills++;
                stats.slHits++;
                bankProfit(-slLoss);
            }

            if (trade.tpOrderId) {
                try { await privateDelete('/fapi/v1/order', { symbol: MARKET_SYMBOL, orderId: trade.tpOrderId }); } catch { /* already gone */ }
            }
            if (trade.slOrderId) {
                try { await privateDelete('/fapi/v1/order', { symbol: MARKET_SYMBOL, orderId: trade.slOrderId }); } catch { /* already gone */ }
            }

            clearActiveTrade();
            stopMonitor();
            return;
        }

        // Position still open — check bracket health
        const tpStatus = trade.tpOrderId ? await getOrderStatus(trade.tpOrderId) : null;
        const slStatus = trade.slOrderId ? await getOrderStatus(trade.slOrderId) : null;

        const tpAlive = tpStatus === 'NEW' || tpStatus === 'PARTIALLY_FILLED';
        const slAlive = slStatus === 'NEW' || slStatus === 'PARTIALLY_FILLED';

        const adverse = pos.side === 'long'
            ? trade.entryPrice - pos.currentPrice
            : pos.currentPrice - trade.entryPrice;

        const emoji = adverse > Math.abs(trade.slPrice - trade.entryPrice) * 0.7 ? '🔴'
                    : adverse > 0 ? '🟡' : '🟢';

        console.log(`[Monitor] ${emoji} ${pos.side?.toUpperCase()} @ $${trade.entryPrice.toFixed(2)} | now $${pos.currentPrice.toFixed(2)} | ${adverse > 0 ? '-' : '+'}$${Math.abs(adverse).toFixed(2)} | TP:${tpAlive ? '✅' : '❌'} SL:${slAlive ? '✅' : '❌'}`);

        // Replace missing bracket orders if position still open
        if (!slAlive && pos.exists) {
            console.log(`[Monitor] ⚠️ SL order gone but position open — replacing STOP_MARKET`);
            const closeSide = pos.side === 'long' ? 'SELL' : 'BUY';
            try {
                const newSl = await (await import('./executeTrade.js') as any).privatePost('/fapi/v1/order', {
                    symbol: MARKET_SYMBOL, side: closeSide, type: 'STOP_MARKET',
                    stopPrice: trade.slPrice.toFixed(2), quantity: trade.size,
                    reduceOnly: 'true', workingType: 'MARK_PRICE',
                });
                console.log(`[Monitor] ✅ SL replaced: id=${newSl.orderId}`);
            } catch (e: any) {
                console.error(`[Monitor] SL replace failed: ${e.message} — will retry next cycle`);
            }
        }

        if (!tpAlive && pos.exists) {
            console.log(`[Monitor] ⚠️ TP order gone but position open — replacing GTX limit`);
            const closeSide = pos.side === 'long' ? 'SELL' : 'BUY';
            const tpPrice   = trade.tpPrice;
            try {
                const newTp = await (await import('./executeTrade.js') as any).privatePost('/fapi/v1/order', {
                    symbol: MARKET_SYMBOL, side: closeSide, type: 'LIMIT',
                    timeInForce: 'GTX', price: tpPrice.toFixed(2),
                    quantity: trade.size, reduceOnly: 'true',
                });
                console.log(`[Monitor] ✅ TP replaced: id=${newTp.orderId}`);
            } catch (e: any) {
                console.error(`[Monitor] TP replace failed: ${e.message}`);
            }
        }

    } catch (e: any) {
        console.error(`[Monitor] Error: ${e.message}`);
    }

    // Schedule next monitor tick
    startMonitor();
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`klines ${res.status}`);
    return res.json();
}

function emaOf(v: number[], p: number): number {
    if (v.length < p) return v.at(-1) ?? 0;
    const k = 2 / (p + 1); let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < v.length; i++) e = v[i]! * k + e * (1 - k); return e;
}
function rsiOf(c: number[], p = 14): number {
    if (c.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = c.length - p; i < c.length; i++) { const d = c[i]! - c[i-1]!; if (d > 0) g += d; else l -= d; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function adxOf(h: number[], l: number[], c: number[], p = 14): number {
    if (h.length < p + 1) return 20;
    const trs: number[] = [], pd: number[] = [], md: number[] = [];
    for (let i = 1; i < h.length; i++) {
        trs.push(Math.max(h[i]! - l[i]!, Math.abs(h[i]! - c[i-1]!), Math.abs(l[i]! - c[i-1]!)));
        const p_ = Math.max(h[i]! - h[i-1]!, 0), m_ = Math.max(l[i-1]! - l[i]!, 0);
        pd.push(p_ > m_ ? p_ : 0); md.push(m_ > p_ ? m_ : 0);
    }
    const st = trs.slice(-p).reduce((a, b) => a + b, 0);
    if (!st) return 20;
    const pdi = pd.slice(-p).reduce((a, b) => a + b, 0) / st * 100;
    const mdi = md.slice(-p).reduce((a, b) => a + b, 0) / st * 100;
    return (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 20;
}

async function fetchMarketData(): Promise<MarketData[]> {
    try {
        const [ticker, k5m, k30m, k1h, k4h, kW, depth, funding] = await Promise.all([
            fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${MARKET_SYMBOL}`).then(r => r.json()),
            fetchKlines(MARKET_SYMBOL, '5m',  120),
            fetchKlines(MARKET_SYMBOL, '30m', 60),
            fetchKlines(MARKET_SYMBOL, '1h',  60),
            fetchKlines(MARKET_SYMBOL, '4h',  30),
            fetchKlines(MARKET_SYMBOL, '1w',  4),
            fetch(`${BASE_URL}/fapi/v1/depth?symbol=${MARKET_SYMBOL}&limit=20`).then(r => r.json()),
            fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${MARKET_SYMBOL}`).then(r => r.json()).catch(() => null),
        ]);

        const price = Number(ticker.lastPrice ?? 0);
        if (!price) throw new Error('No price');

        const c5 = k5m.map((c: any[]) => Number(c[4]));
        const h5 = k5m.map((c: any[]) => Number(c[2]));
        const l5 = k5m.map((c: any[]) => Number(c[3]));
        const v5 = k5m.map((c: any[]) => Number(c[5]));

        const ema8  = emaOf(c5, 8);
        const ema21 = emaOf(c5, 21);
        const ema50 = emaOf(c5, 50);
        const emaTrend = ema8 > ema21 && ema21 > ema50 ? 'bullish' as const
                       : ema8 < ema21 && ema21 < ema50 ? 'bearish' as const : 'neutral' as const;
        const rsi = rsiOf(c5);
        const adx = adxOf(h5, l5, c5);

        const c30 = k30m.map((c: any[]) => Number(c[4]));
        const c1h = k1h.map((c: any[]) => Number(c[4]));
        const c4h = k4h.map((c: any[]) => Number(c[4]));
        const cW  = kW.map((c: any[]) => Number(c[4]));

        const mom5m  = c5.length  >= 2 ? (c5.at(-1)!  - c5.at(-2)!)  / c5.at(-2)!  * 100 : 0;
        const mom30m = c30.length >= 2 ? (c30.at(-1)! - c30.at(-2)!) / c30.at(-2)! * 100 : 0;
        const mom1h  = c1h.length >= 2 ? (c1h.at(-1)! - c1h.at(-2)!) / c1h.at(-2)! * 100 : 0;

        const priceStructure = ema8 > ema50 * 1.001 ? 'uptrend' as const
                             : ema8 < ema50 * 0.999 ? 'downtrend' as const : 'ranging' as const;
        const trendBias4h = c4h.at(-1)! > c4h.at(-5)! * 1.002 ? 'bull' as const
                          : c4h.at(-1)! < c4h.at(-5)! * 0.998 ? 'bear' as const : 'neutral' as const;
        const weeklyBias  = cW.at(-1)! > cW.at(-2)! * 1.005 ? 'bullish' as const
                          : cW.at(-1)! < cW.at(-2)! * 0.995 ? 'bearish' as const : 'neutral' as const;

        const trs   = h5.slice(-20).map((h, i) => { const lv = l5.slice(-20)[i]!; const pc = i > 0 ? c5.slice(-20)[i-1]! : lv; return Math.max(h - lv, Math.abs(h - pc), Math.abs(lv - pc)); });
        const atr5m = trs.reduce((a, b) => a + b, 0) / trs.length;
        const rv    = v5.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const av    = v5.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volumeRatio = av > 0 ? rv / av : 1;

        const sw = k5m.slice(-30);
        const swH: number[] = [], swL: number[] = [];
        for (let i = 2; i < sw.length - 2; i++) {
            const hv = Number(sw[i]![2]), lv = Number(sw[i]![3]);
            if (hv > Number(sw[i-1]![2]) && hv > Number(sw[i+1]![2])) swH.push(hv);
            if (lv < Number(sw[i-1]![3]) && lv < Number(sw[i+1]![3])) swL.push(lv);
        }
        const nearestResistance = swH.filter(h => h > price).length ? Math.min(...swH.filter(h => h > price)) : price + atr5m;
        const nearestSupport    = swL.filter(l => l < price).length ? Math.max(...swL.filter(l => l < price)) : price - atr5m;

        const h24 = Number(ticker.highPrice ?? price + atr5m);
        const l24 = Number(ticker.lowPrice  ?? price - atr5m);
        const fundingRate = funding?.lastFundingRate != null ? Number(funding.lastFundingRate) : null;

        const bestBid   = Number(depth?.bids?.[0]?.[0] ?? price - 0.05);
        const bestAsk   = Number(depth?.asks?.[0]?.[0] ?? price + 0.05);
        const spreadUsd = bestAsk - bestBid;

        const bids = (depth?.bids ?? []).slice(0, 10);
        const asks = (depth?.asks ?? []).slice(0, 10);
        const bidQ = bids.reduce((s: number, b: any[]) => s + Number(b[1]), 0);
        const askQ = asks.reduce((s: number, a: any[]) => s + Number(a[1]), 0);
        const obImbalance = (bidQ + askQ) > 0 ? (bidQ - askQ) / (bidQ + askQ) : 0;

        const vN = k5m.slice(-20).reduce((s: number, c: any[]) => s + ((Number(c[2]) + Number(c[3]) + Number(c[4])) / 3) * Number(c[5]), 0);
        const vD = v5.slice(-20).reduce((a, b) => a + b, 0);
        const vwap = vD > 0 ? vN / vD : price;

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50, rsi, momentum5m: mom5m, momentum30m: mom30m, momentum1h: mom1h,
            priceStructure, trendBias4h, weeklyBias, atr5m, atrPct: atr5m / price * 100, volumeRatio,
            nearestResistance, nearestSupport,
            distanceToResistance: nearestResistance - price, distanceToSupport: price - nearestSupport,
            high24h: h24, low24h: l24, adx, fundingRate, spreadUsd, obImbalance,
            priceVsVwap: (price - vwap) / vwap * 100,
            recentSwingHigh: nearestResistance, recentSwingLow: nearestSupport,
        };

        const rng = h24 > l24 ? ((price - l24) / (h24 - l24) * 100).toFixed(0) : '50';
        console.log(`[Data] $${price.toFixed(2)} EMA:${emaTrend} RSI:${rsi.toFixed(1)} ADX:${adx.toFixed(1)} ATR:$${atr5m.toFixed(2)} Spread:$${spreadUsd.toFixed(3)} OB:${(obImbalance*100).toFixed(0)}% Rng:${rng}%`);

        return [{ symbol: DISPLAY_SYMBOL, price, change_24h: Number(ticker.priceChangePercent ?? 0), indicators, orderBook: {
            bidWalls: bids.map((b: any[]) => ({ price: Number(b[0]), notionalUsd: Number(b[0]) * Number(b[1]) })).filter((b: any) => b.notionalUsd > 50_000),
            askWalls: asks.map((a: any[]) => ({ price: Number(a[0]), notionalUsd: Number(a[0]) * Number(a[1]) })).filter((a: any) => a.notionalUsd > 50_000),
        }}];
    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`); return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────
// Signal cycle only fires when NO position is open.
// Monitoring runs independently on its own 5s timer.

async function runCycle(): Promise<void> {
    checkReset();
    const session = getSession();

    // Skip signal cycle if position is open — monitor handles it
    if (getActiveTrade()) {
        console.log(`[Main] Position open — skipping signal cycle, monitor active.`);
        return;
    }

    if (stats.fills >= CONFIG.MAX_TRADES_DAY) {
        console.log(`[Main] Daily limit ${CONFIG.MAX_TRADES_DAY} reached.`);
        return;
    }

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | ${session.name} [${session.quality}] | ${IS_TESTNET ? '🧪 TEST' : '🔴 LIVE'}`);
    console.log(`[Main] trades=${stats.fills}/${CONFIG.MAX_TRADES_DAY} tp=${stats.tpHits} sl=${stats.slHits} skip=${stats.skipped}`);
    console.log(`[Main] vBal=$${virtualTradingBalance.toFixed(2)} | pending=$${accumulatedNetProfit.toFixed(4)} | banked=$${totalBanked.toFixed(2)}`);
    console.log(`${'═'.repeat(65)}`);

    try {
        const balance = await getAvailableBalance();

        if (virtualTradingBalance <= 0) {
            if (balance <= 0) { console.log(`[Main] Balance unavailable.`); return; }
            virtualTradingBalance = balance;
            initialBalance.value  = balance;
            initialBalance.set    = true;
            console.log(`[Bank] Init: $${virtualTradingBalance.toFixed(4)}`);
        }

        const effectiveBalance = balance > 0 ? balance : virtualTradingBalance;
        if (effectiveBalance < 1.50) { console.log(`[Main] Balance too low.`); return; }

        if (balance >= CONFIG.RECYCLE_BALANCE) {
            console.log(`[Main] 🎯 RECYCLE — consider withdrawing $${(balance - CONFIG.RECYCLE_KEEP).toFixed(2)}`);
        }

        // Orphan check — position exists but no local trade record
        const pos = await getOpenPositionDetails();
        if (pos.exists && !getActiveTrade()) {
            console.log(`[Main] 🚨 Orphan position detected — emergency close`);
            if (pos.side && pos.size > 0) await emergencyClose(pos.side, pos.size, 'orphan on startup');
            return;
        }

        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No market data.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') { stats.skipped++; continue; }

            stats.attempts++;
            const result = await executeBinanceTrade(signal, virtualTradingBalance);

            if (result.outcome === 'orders_placed') {
                stats.fills++;
                if (result.fillTimeMs) stats.fillTimes.push(result.fillTimeMs);
                // Start monitoring loop now that position is live
                startMonitor();
            } else if (result.outcome === 'skipped') {
                stats.attempts--;
                stats.skipped++;
            } else if (result.outcome === 'error') {
                console.error(`[Main] Error: ${result.message}`);
                stats.attempts--;
            }
            break;
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
console.log(`  MODUVISE GOLD BOT v3 — BINANCE USDM FUTURES`);
console.log(`  Mode:      ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'}`);
console.log(`  Entry:     GTX $0.20 offset | 0% maker`);
console.log(`  TP:        $1.00 GTX resting | 0% maker`);
console.log(`  SL:        $3.00 STOP_MARKET exchange-side | 0.045% taker`);
console.log(`  Bracket:   Both placed immediately after fill`);
console.log(`  Monitor:   5s loop — backup only, not primary SL`);
console.log(`  R:R:       1:3 | breakeven 75% | target WR >78%`);
console.log(`  Size:      100% balance every trade | 40x`);
console.log(`  Banking:   $5 threshold | 30% spot | 70% compound`);
console.log(`  Cap:       $${CONFIG.MAX_TRADING_BALANCE.toLocaleString()} | ${CONFIG.MAX_TRADES_DAY} trades/day`);
console.log(`  Start:     ${new Date().toISOString()}`);
console.log(`${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);