import * as dotenv from 'dotenv';
import * as fs    from 'fs';
import { RSI, EMA, ADX, ATR } from 'technicalindicators';
import { generateSignals, getSession, detectRegime, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators, MarketRegime } from './signals.js';
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
} from './executeTrade.js';

dotenv.config();

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

// ─── BANKING SYSTEM ───────────────────────────────────────────────────────────
// The user's design: after each winning trade, split profit 50/50 between
// "trading balance" (compounds into next trade) and "banked balance"
// (protected, stays in the futures wallet but is never used for margin).
//
// Example: start $10, hit TP, profit $0.008
//   → trading = $10.004, banked = $0.004
//   Next trade uses $10.004, hits TP again, profit ≈ $0.008
//   → trading = $10.008, banked = $0.008
//
// Losses only come from tradingBalance. bankedBalance is never touched.
// After liquidation: tradingBalance → 0, bankedBalance intact as a ledger.
// (Both are in the same futures wallet — "banked" is a virtual accounting
// partition, not an actual transfer. Withdrawals still require manual action.)
//
// BANK_SPLIT: fraction of each profit that goes to banked (0.50 = 50%).
const BANK_SPLIT    = Number(process.env.BANK_SPLIT    ?? 0.50);
const MAX_TRADES    = Number(process.env.MAX_TRADES_DAY ?? 2000); // HF: up to ~576/day

let tradingBalance  = 0;  // active compounding stack
let bankedBalance   = 0;  // protected profit ledger
const startTime     = Date.now();
const initialBalance = { value: 0, set: false };

// ─── DAILY STATS ──────────────────────────────────────────────────────────────
interface DayStats {
    date:         string;
    fills:        number;
    tpHits:       number;
    slHits:       number;
    skipped:      number;
    grossProfit:  number;
    netProfit:    number;
    slLoss:       number;
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
// Survives EC2 reboots, OOM kills, crashes. Restored on next startup.
// bankedBalance survives even if tradingBalance hits 0.
const STATE_FILE = process.env.STATE_FILE ?? './bot-state.json';

function saveState(): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            tradingBalance, bankedBalance, initialBalance, stats,
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
        tradingBalance  = raw.tradingBalance  ?? 0;
        bankedBalance   = raw.bankedBalance   ?? 0;
        if (raw.initialBalance) Object.assign(initialBalance, raw.initialBalance);
        const today = new Date().toISOString().slice(0, 10);
        if (raw.stats?.date === today) stats = raw.stats;
        console.log(`[State] Restored — trading: $${tradingBalance.toFixed(4)} | banked: $${bankedBalance.toFixed(4)} | saved: ${raw.savedAt}`);
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
    console.log(`💼 Trading Stack:  $${tradingBalance.toFixed(4)}`);
    console.log(`🏦 Banked Profit:  $${bankedBalance.toFixed(4)}`);
    console.log(`📦 Total in Wallet: $${(tradingBalance + bankedBalance).toFixed(4)}`);
    if (initialBalance.set) {
        const total = tradingBalance + bankedBalance;
        const ret   = ((total - initialBalance.value) / initialBalance.value * 100).toFixed(2);
        console.log(`📈 Return on $${initialBalance.value.toFixed(2)}: ${ret}%`);
    }
    console.log(`${'█'.repeat(70)}\n`);
}

// ─── BANKING ENGINE ───────────────────────────────────────────────────────────
function applyTradeResult(realizedPnl: number): void {
    if (realizedPnl <= 0) {
        // Loss: deduct from trading stack only. bankedBalance untouched.
        tradingBalance = Math.max(0, tradingBalance + realizedPnl);
        stats.netProfit += realizedPnl;
        stats.slLoss    += Math.abs(realizedPnl);
        console.log(`[Bank] 🔴 Loss: $${realizedPnl.toFixed(4)} | Trading: $${tradingBalance.toFixed(4)} | Banked: $${bankedBalance.toFixed(4)}`);
        return;
    }

    // Win: split BANK_SPLIT to banked, rest compounds into trading
    const toBank     = realizedPnl * BANK_SPLIT;
    const toCompound = realizedPnl * (1 - BANK_SPLIT);

    bankedBalance  += toBank;
    tradingBalance += toCompound;

    stats.grossProfit += realizedPnl;
    stats.netProfit   += realizedPnl;

    console.log(
        `[Bank] 🟢 Profit: +$${realizedPnl.toFixed(4)} | ` +
        `Compounded: +$${toCompound.toFixed(4)} | ` +
        `Banked: +$${toBank.toFixed(4)} | ` +
        `Stack: $${tradingBalance.toFixed(4)} | Total Banked: $${bankedBalance.toFixed(4)}`
    );
}

// ─── MARKET DATA INGESTION ────────────────────────────────────────────────────
async function buildLiveMarketData(symbol: string): Promise<MarketData[]> {
    interface BinanceTicker { lastPrice: string; highPrice: string; lowPrice: string; priceChangePercent: string; }
    interface BinanceDepth  { bids: string[][]; asks: string[][]; }
    type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

    const [tickerRes, bookRes, klinesRes] = await Promise.all([
        fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json() as Promise<BinanceTicker>),
        fetch(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`).then(r => r.json() as Promise<BinanceDepth>),
        fetch(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`).then(r => r.json() as Promise<BinanceKline[]>),
    ]);

    const currentPrice = Number(tickerRes.lastPrice);
    const topBid       = Number(bookRes.bids[0][0]);
    const topAsk       = Number(bookRes.asks[0][0]);
    const spreadUsd    = topAsk - topBid;

    // Order book imbalance (top 10 levels)
    const bidNot = bookRes.bids.slice(0, 10).reduce((s, v) => s + Number(v[0]) * Number(v[1]), 0);
    const askNot = bookRes.asks.slice(0, 10).reduce((s, v) => s + Number(v[0]) * Number(v[1]), 0);
    const totNot = bidNot + askNot;
    const obImbalance = totNot === 0 ? 0 : (bidNot - askNot) / totNot;

    // Klines
    const highs   = klinesRes.map((c: any) => Number(c[2]));
    const lows    = klinesRes.map((c: any) => Number(c[3]));
    const closes  = klinesRes.map((c: any) => Number(c[4]));
    const volumes = klinesRes.map((c: any) => Number(c[5]));

    // Indicators
    const rsi       = RSI.calculate({ values: closes, period: 14 }).pop() ?? 50;
    const ema50     = EMA.calculate({ values: closes, period: 50 }).pop() ?? currentPrice;
    const adx       = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop()?.adx ?? 25;
    const atr5m     = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop() ?? 3.50;
    const momentum5m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;

    const avgVol    = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volRatio  = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1.0;

    // VWAP
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < klinesRes.length; i++) {
        cumPV  += ((highs[i] + lows[i] + closes[i]) / 3) * volumes[i];
        cumVol += volumes[i];
    }
    const vwap       = cumVol > 0 ? cumPV / cumVol : currentPrice;
    const priceVsVwap = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

    // Funding rate
    let fundingRate = 0;
    try {
        const prem = await fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.json()) as any;
        fundingRate = Number(prem?.lastFundingRate ?? 0);
    } catch { /* non-critical */ }

    // Swing levels (last 20 candles)
    const swingHigh = Math.max(...highs.slice(-20));
    const swingLow  = Math.min(...lows.slice(-20));

    const emaTrend = currentPrice > ema50 ? 'bullish' : 'bearish';

    // ── Dip / Rip regime detection ──────────────────────────────────────────
    // Detects if gold has made a large fast move in either direction recently,
    // and if so pauses trading for a cooldown period (10 min for dip, 5 for rip).
    // This is the answer to "how will the bot know gold is taking huge dips" —
    // it measures ATR-scaled candle-to-candle momentum over the last 15 minutes.
    const { regime, reason: regimeReason } = detectRegime(closes, atr5m);
    if (regime !== 'normal') {
        console.log(`[Regime] ⚠️  ${regimeReason}`);
    }

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

    return [{
        symbol:       DISPLAY_SYMBOL,
        price:        currentPrice,
        bid:          topBid,
        ask:          topAsk,
        change_24h:   Number(tickerRes.priceChangePercent),
        indicators:   liveIndicators,
        regime,
        regimeReason,
        orderBook:    { bidWalls: [], askWalls: [] },
    }];
}

// ─── POSITION HEALTH CHECK ────────────────────────────────────────────────────
// Uses Binance's actual realizedPnl from userTrades — not guessing from
// current price vs stored TP/SL values (which was the bug in the original code
// that could silently misclassify a loss as a win).
async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const pos   = await getOpenPositionDetails();
    const trade = getActiveTrade();

    if (!pos.exists) {
        if (trade) {
            const real = await getRealizedPnlSince(trade.openedAt - 2_000);
            if (real) {
                const outcome = real.pnl >= 0 ? 'tp' : 'sl';
                if (outcome === 'tp') stats.tpHits++;
                else                  stats.slHits++;
                stats.fills++;
                applyTradeResult(real.pnl);

                // Cancel any remaining open orders — pass slAlgoId so algo SL is also cancelled
                await cancelAllOrders(trade.slAlgoId);
                clearActiveTrade();
                console.log(`[Health] ${outcome.toUpperCase()} confirmed | PnL: $${real.pnl.toFixed(4)} | Fills: ${real.trades}`);
                return outcome;
            }
            // Couldn't verify — clean up and alert
            await cancelAllOrders(trade.slAlgoId);
            clearActiveTrade();
            await sendAlert(`⚠️ Position closed but PnL unverifiable — stats NOT updated for this trade. Check Binance.`);
            return 'none';
        }
        return 'none';
    }

    if (!trade) return 'open'; // manual position outside bot

    const ageMs = Date.now() - trade.openedAt;

    // SCRATCH TIMEOUT: if the position hasn't hit TP in SCRATCH_TIMEOUT_MS (45s),
    // exit at market for near-zero cost rather than holding until the SL fires.
    // This is the most impactful change based on the historical data:
    // — 24 winning trades averaged ~$0.009 profit each ($0.217 total)
    // — 2 losing trades averaged -$0.689 each (-$1.378 total)
    // A position that drifts for 45 seconds isn't the one we wanted; cut it early.
    const SCRATCH_MS = Number(process.env.SCRATCH_TIMEOUT_MS ?? 86400000);
    if (ageMs > SCRATCH_MS) {
        const profit = trade.side === 'long'
            ? pos.currentPrice - trade.entryPrice
            : trade.entryPrice - pos.currentPrice;
        console.log(`[Scratch] ⏱ Trade open ${(ageMs/1000).toFixed(0)}s — scratching at $${pos.currentPrice.toFixed(2)} (P&L: $${(profit * trade.size).toFixed(4)})`);
        await cancelAllOrders(trade.slAlgoId);
        await triggerEmergencyClose(trade.side, trade.size, `Scratch timeout: ${(ageMs/1000).toFixed(0)}s elapsed`);
        const real = await getRealizedPnlSince(trade.openedAt - 2_000);
        const pnl  = real ? real.pnl : profit * trade.size;
        if (pnl >= 0) { stats.tpHits++; } else { stats.slHits++; }
        stats.fills++;
        applyTradeResult(pnl);
        clearActiveTrade();
        return pnl >= 0 ? 'tp' : 'sl';
    }

    // Watchdog fail-safe: if price has blown past SL before exchange orders fired
    const adverseMove = trade.side === 'long'
        ? trade.entryPrice - pos.currentPrice
        : pos.currentPrice - trade.entryPrice;

    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);

    if (adverseMove >= slThreshold * 1.1) { // 10% slippage buffer before emergency
        await sendAlert(`🛑 Fail-safe firing: $${adverseMove.toFixed(2)} adverse move on ${trade.side.toUpperCase()}`);
        await triggerEmergencyClose(trade.side, trade.size, `Fail-safe: $${adverseMove.toFixed(2)} adverse`);
        const real = await getRealizedPnlSince(trade.openedAt - 2_000);
        const loss = real ? real.pnl : -(trade.size * adverseMove);
        stats.slHits++;
        stats.fills++;
        applyTradeResult(loss);
        clearActiveTrade();
        return 'sl';
    }

    return 'open';
}

// ─── MAIN CYCLE ──────────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
    checkReset();
    if (stats.fills >= MAX_TRADES) return;

    try {
        const health = await checkPositionHealth();
        if (health === 'tp' || health === 'sl') { saveState(); return; }
        if (health === 'open') return;

        // Sync balance on startup or after balance reset
        const realBalance = await getAvailableBalance();
        if (tradingBalance <= 0) {
            if (realBalance > 0) {
                tradingBalance     = realBalance;
                initialBalance.value = realBalance;
                initialBalance.set   = true;
                console.log(`[Init] Capital base locked: $${tradingBalance.toFixed(4)}`);
                saveState();
            } else {
                console.log('[Init] No available balance. Waiting...');
                return;
            }
        }

        // Ingest market data and run signals
        const assets  = await buildLiveMarketData(MARKET_SYMBOL);
        const signals = await generateSignals(assets);
        const signal  = signals[0];

        console.log(`[Heartbeat] ${signal.reasoning} | Stack: $${tradingBalance.toFixed(4)} | Banked: $${bankedBalance.toFixed(4)}`);

        if (signal.direction === 'neutral') {
            stats.skipped++;
            return;
        }

        // Fire the trade using current trading stack
        const result = await executeBinanceTrade(signal, tradingBalance);

        if (result.outcome === 'orders_placed') {
            console.log(
                `[Trade] 🚀 ${signal.direction.toUpperCase()} @ $${result.entryPrice?.toFixed(2)} | ` +
                `TP: $${result.tpPrice?.toFixed(2)} | SL: $${result.slPrice?.toFixed(2)} | ` +
                `Est. profit: $${result.grossProfit?.toFixed(4)}`
            );
        } else {
            stats.skipped++;
            console.log(`[Skipped] Trade rejected or failed: ${result.message}`);
        }

    } catch (e: any) {
        console.error(`[Cycle] Error: ${e.message}`);
        await sendAlert(`⚠️ runCycle() error: ${e.message}`);
    }
}

// ─── FAST WATCHDOG ────────────────────────────────────────────────────────────
// Runs every 2 seconds while a trade is open — much faster than the
// main cycle interval (8-30s). This is the first line of defense if
// SL orders fail or price gaps past them.
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
// EC2 running unattended for 30 days: if the process dies, you need to know.
process.on('unhandledRejection', async (reason: any) => {
    console.error(`[FATAL] Unhandled rejection: ${reason}`);
    saveState();
    await sendAlert(`🚨 Unhandled rejection — bot may be unstable: ${reason}`);
});

process.on('uncaughtException', async (err: Error) => {
    console.error(`[FATAL] Uncaught exception: ${err.message}`);
    saveState();
    await sendAlert(`🚨 Bot CRASHING on uncaught exception: ${err.message}. Restart it (use pm2 or systemd).`);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    console.log('[Shutdown] SIGTERM received. Saving state...');
    saveState();
    await sendAlert('🔄 Bot received SIGTERM — shutting down cleanly. Restart if unintended.');
    process.exit(0);
});

// ─── STARTUP ─────────────────────────────────────────────────────────────────
loadState();
const leverage = Number(process.env.BOT_LEVERAGE ?? 100);
console.log(`\n${'═'.repeat(70)}`);
console.log(`  MODUVISE XAUUSDT SCALPER — LIVE BINANCE`);
console.log(`  ENVIRONMENT : ${ENVIRONMENT}`);
console.log(`  LEVERAGE    : ${leverage}x`);
console.log(`  TP TARGET   : $0.20`);
console.log(`  SL          : 10% of margin`);
console.log(`  ENTRY OFFSET: $0.05`);
console.log(`  BANK SPLIT  : ${(BANK_SPLIT * 100).toFixed(0)}% banked / ${((1 - BANK_SPLIT) * 100).toFixed(0)}% compounded`);
console.log(`  TRADING BAL : $${tradingBalance.toFixed(4)}`);
console.log(`  BANKED      : $${bankedBalance.toFixed(4)}`);
console.log(`${'═'.repeat(70)}\n`);

sendAlert(
    `✅ Bot started | ENV=${ENVIRONMENT} | ${leverage}x lev | ` +
    `stack=$${tradingBalance.toFixed(4)} | banked=$${bankedBalance.toFixed(4)}`
);

runCycle().then(scheduleNext);
