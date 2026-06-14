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
} from './executeTrade.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// KEY CHANGE: MAX_TRADES_DAY raised from 300 → 400
// isMomentumFresh removed from cycle — saved 1 API call per cycle (klines fetch)
// Momentum is embedded in the bias scoring inside signals.ts

const CONFIG = {
    MAX_TRADES_DAY:      400,            // raised from 300
    MAX_TRADING_BALANCE: 25_000,
    BANK_FRACTION:       0.50,
    RECYCLE_BALANCE:     800,
    RECYCLE_KEEP:        400,
} as const;

// ─── EXCHANGE (market data only) ──────────────────────────────────────────────

const BASE_URL = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const exchange = new (ccxt as any).binanceusdm({
    timeout:         15_000,
    enableRateLimit: true,
    options:         { defaultType: 'future' },
    ...(IS_TESTNET ? {
        urls: { api: {
            public:       BASE_URL,
            fapiPublic:   BASE_URL + '/fapi/v1/',
            fapiPublicV2: BASE_URL + '/fapi/v2/',
        }},
    } : {}),
});

// ─── DAILY STATS ──────────────────────────────────────────────────────────────

interface DayStats {
    date:          string;
    attempts:      number;
    fills:         number;
    tpHits:        number;
    slHits:        number;
    skipped:       number;
    grossProfit:   number;
    netProfit:     number;
    slLoss:        number;
    sessionBanked: number;
    fillTimes:     number[];
    avgFillMs:     number;
}

let stats: DayStats = freshStats();

function freshStats(): DayStats {
    return {
        date: new Date().toISOString().slice(0, 10),
        attempts: 0, fills: 0, tpHits: 0, slHits: 0, skipped: 0,
        grossProfit: 0, netProfit: 0, slLoss: 0, sessionBanked: 0,
        fillTimes: [], avgFillMs: 0,
    };
}

// ─── BANKING STATE ────────────────────────────────────────────────────────────

let virtualTradingBalance = 0;
let sessionBanked         = 0;
const startTime           = Date.now();
const initialBalance      = { value: 0, set: false };

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
    fillTimeMs?: number;
}
let pendingTrade: PendingTrade | null = null;

function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) {
        printDailySummary();
        stats = freshStats();
        stats.date = today;
    }
}

function printDailySummary(): void {
    const total    = virtualTradingBalance + sessionBanked;
    const uptime   = ((Date.now() - startTime) / 3600000).toFixed(1);
    const tpRate   = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    const fillRate = stats.attempts > 0 ? ((stats.fills / stats.attempts) * 100).toFixed(0) : '0';
    stats.avgFillMs = stats.fillTimes.length > 0
        ? stats.fillTimes.reduce((a, b) => a + b, 0) / stats.fillTimes.length : 0;

    const summary = [
        `📊 DAILY SUMMARY — ${stats.date} (${uptime}h uptime)`,
        `Attempts: ${stats.attempts} | Fills: ${stats.fills} (${fillRate}%) | TP: ${stats.tpHits} (${tpRate}%) | SL: ${stats.slHits} | Skipped: ${stats.skipped}`,
        `Gross P&L: $${stats.grossProfit.toFixed(4)} | Net: $${stats.netProfit.toFixed(4)} | SL losses: $${stats.slLoss.toFixed(4)}`,
        `Avg fill time: ${(stats.avgFillMs / 1000).toFixed(1)}s`,
        `Banked today: $${stats.sessionBanked.toFixed(4)}`,
        `💼 vBal: $${virtualTradingBalance.toFixed(2)} | 🏦 Banked: $${sessionBanked.toFixed(2)} | 📊 Total: $${total.toFixed(2)}`,
        initialBalance.set ? `📈 Return: ${((total - initialBalance.value) / initialBalance.value * 100).toFixed(2)}%` : '',
    ].filter(Boolean).join('\n');

    console.log(`\n${'█'.repeat(65)}\n${summary}\n${'█'.repeat(65)}\n`);
}

function bankProfit(net: number): void {
    if (net <= 0) return;
    const toBank   = net * CONFIG.BANK_FRACTION;
    const toReinvest = net - toBank;
    sessionBanked         += toBank;
    virtualTradingBalance += toReinvest;
    stats.sessionBanked   += toBank;
    virtualTradingBalance  = Math.min(virtualTradingBalance, CONFIG.MAX_TRADING_BALANCE);
    console.log(`[Bank] +$${net.toFixed(4)} → bank=$${toBank.toFixed(4)} reinvest=$${toReinvest.toFixed(4)} | vBal=$${virtualTradingBalance.toFixed(2)} banked=$${sessionBanked.toFixed(2)}`);
}

async function updateRealPnl(): Promise<void> {
    try {
        const bal = await getAvailableBalance();
        if (bal > 0 && bal !== virtualTradingBalance) {
            console.log(`[Bank] On-chain=$${bal.toFixed(4)} | virtual=$${virtualTradingBalance.toFixed(4)}`);
        }
    } catch { /* non-critical */ }
}

// ─── POSITION HEALTH CHECK ────────────────────────────────────────────────────

async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const pos = await getOpenPositionDetails();

    if (!pos.exists) {
        if (pendingTrade) return 'tp';
        return 'none';
    }

    const trade = pendingTrade ?? getActiveTrade();
    if (!trade) {
        console.log(`[Health] Orphan position detected — no local trade record.`);
        return 'open';
    }

    const adverseMove = pos.side === 'long'
        ? trade.entryPrice - pos.currentPrice
        : pos.currentPrice - trade.entryPrice;

    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);
    const inFavour    = -adverseMove;

    const emoji = adverseMove > slThreshold * 0.7 ? '🔴' :
                  adverseMove > 0                 ? '🟡' : '🟢';

    console.log(`[Health] ${emoji} ${pos.side?.toUpperCase()} @ $${trade.entryPrice.toFixed(2)} | now $${pos.currentPrice.toFixed(2)} | ${adverseMove > 0 ? `adverse -$${adverseMove.toFixed(2)}` : `+$${inFavour.toFixed(2)}`} | SL@$${trade.slPrice.toFixed(2)}`);

    if (adverseMove >= slThreshold) {
        console.log(`[Health] 🛑 SL — $${adverseMove.toFixed(2)} ≥ $${slThreshold.toFixed(2)}`);
        const side = pos.side ?? (pendingTrade?.side ?? getActiveTrade()?.side ?? 'long');
        await triggerStopLoss(side, pos.size, `SL threshold hit`);
        stats.slHits++;
        stats.slLoss += pos.size * slThreshold;
        pendingTrade = null;
        await updateRealPnl();
        return 'sl';
    }

    return 'open';
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function fetchKlines(symbol: string, timeframe: string, limit: number): Promise<any[]> {
    const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`klines ${res.status}`);
    return res.json();
}

function computeEMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let ema  = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) ema = values[i]! * k + ema * (1 - k);
    return ema;
}

function computeRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i]! - closes[i - 1]!;
        if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    return 100 - 100 / (1 + rs);
}

function computeADX(highs: number[], lows: number[], closes: number[], period = 14): number {
    if (highs.length < period + 1) return 20;
    const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        const tr      = Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!));
        const plusDM  = Math.max(highs[i]! - highs[i - 1]!, 0);
        const minusDM = Math.max(lows[i - 1]! - lows[i]!, 0);
        trs.push(tr);
        plusDMs.push(plusDM > minusDM ? plusDM : 0);
        minusDMs.push(minusDM > plusDM ? minusDM : 0);
    }
    const sumTR = trs.slice(-period).reduce((a, b) => a + b, 0);
    const pDI   = sumTR > 0 ? (plusDMs.slice(-period).reduce((a, b) => a + b, 0) / sumTR) * 100 : 0;
    const mDI   = sumTR > 0 ? (minusDMs.slice(-period).reduce((a, b) => a + b, 0) / sumTR) * 100 : 0;
    const dx    = (pDI + mDI) > 0 ? Math.abs(pDI - mDI) / (pDI + mDI) * 100 : 0;
    return dx;
}

async function fetchMarketData(): Promise<MarketData[]> {
    try {
        // All fetches in parallel — single round trip to exchange
        const [
            ticker,
            ohlcv5m,
            ohlcv30m,
            ohlcv1h,
            ohlcv4h,
            ohlcvW,
            depthData,
            fundingData,
        ] = await Promise.all([
            fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${MARKET_SYMBOL}`).then(r => r.json()),
            fetchKlines(MARKET_SYMBOL, '5m',  120),
            fetchKlines(MARKET_SYMBOL, '30m', 60),
            fetchKlines(MARKET_SYMBOL, '1h',  60),
            fetchKlines(MARKET_SYMBOL, '4h',  30),
            fetchKlines(MARKET_SYMBOL, '1w',  4),
            fetch(`${BASE_URL}/fapi/v1/depth?symbol=${MARKET_SYMBOL}&limit=20`).then(r => r.json()),
            fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${MARKET_SYMBOL}`).then(r => r.json()).catch(() => null),
        ]);

        const price = Number(ticker.lastPrice ?? ticker.price ?? 0);
        if (!price) throw new Error('No price from ticker');

        const closes5m  = ohlcv5m.map((c: any[]) => Number(c[4]));
        const highs5m   = ohlcv5m.map((c: any[]) => Number(c[2]));
        const lows5m    = ohlcv5m.map((c: any[]) => Number(c[3]));
        const closes30m = ohlcv30m.map((c: any[]) => Number(c[4]));
        const closes1h  = ohlcv1h.map((c: any[]) => Number(c[4]));
        const closes4h  = ohlcv4h.map((c: any[]) => Number(c[4]));
        const closesW   = ohlcvW.map((c: any[]) => Number(c[4]));
        const volumes5m = ohlcv5m.map((c: any[]) => Number(c[5]));

        const ema8  = computeEMA(closes5m, 8);
        const ema21 = computeEMA(closes5m, 21);
        const ema50 = computeEMA(closes5m, 50);
        const emaTrend = ema8 > ema21 && ema21 > ema50 ? 'bullish'
                       : ema8 < ema21 && ema21 < ema50 ? 'bearish' : 'neutral';

        const rsi = computeRSI(closes5m);
        const adx = computeADX(highs5m, lows5m, closes5m);

        const c5m  = closes5m;
        const mom5m  = c5m.length >= 2  ? ((c5m[c5m.length - 1]! - c5m[c5m.length - 2]!)  / c5m[c5m.length - 2]!  * 100) : 0;
        const mom30m = closes30m.length  >= 2  ? ((closes30m.at(-1)! - closes30m.at(-2)!)  / closes30m.at(-2)!  * 100) : 0;
        const mom1h  = closes1h.length   >= 2  ? ((closes1h.at(-1)!  - closes1h.at(-2)!)   / closes1h.at(-2)!   * 100) : 0;

        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            ema8 > ema50 * 1.001 ? 'uptrend' :
            ema8 < ema50 * 0.999 ? 'downtrend' : 'ranging';

        const trendBias4h: 'bull' | 'bear' | 'neutral' =
            closes4h.at(-1)! > closes4h.at(-5)! * 1.002 ? 'bull' :
            closes4h.at(-1)! < closes4h.at(-5)! * 0.998 ? 'bear' : 'neutral';

        const weeklyBias: 'bullish' | 'bearish' | 'neutral' =
            closesW.at(-1)! > closesW.at(-2)! * 1.005 ? 'bullish' :
            closesW.at(-1)! < closesW.at(-2)! * 0.995 ? 'bearish' : 'neutral';

        // ATR (5m)
        const trueRanges = highs5m.slice(-20).map((h, i, arr) => {
            const l = lows5m.slice(-20)[i]!;
            const pc = i > 0 ? closes5m.slice(-20)[i - 1]! : l;
            return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        });
        const atr5m = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;

        // Volume ratio
        const recentVol = volumes5m.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const avgVol    = volumes5m.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;

        // S/R (swing highs/lows over 30 candles)
        const lookback = 30;
        const recent5m = ohlcv5m.slice(-lookback);
        const swingHighs: number[] = [], swingLows: number[] = [];
        for (let i = 2; i < recent5m.length - 2; i++) {
            const h = Number(recent5m[i]![2]);
            const l = Number(recent5m[i]![3]);
            if (h > Number(recent5m[i-1]![2]) && h > Number(recent5m[i+1]![2])) swingHighs.push(h);
            if (l < Number(recent5m[i-1]![3]) && l < Number(recent5m[i+1]![3])) swingLows.push(l);
        }
        const swings = {
            high: swingHighs.length ? Math.min(...swingHighs.filter(h => h > price)) || price + atr5m : price + atr5m,
            low:  swingLows.length  ? Math.max(...swingLows.filter(l => l < price))  || price - atr5m : price - atr5m,
        };
        const nearestResistance = swings.high;
        const nearestSupport    = swings.low === Infinity ? price - atr5m : swings.low;

        // 24h range
        const h24 = Number(ticker.highPrice ?? price + atr5m);
        const l24 = Number(ticker.lowPrice  ?? price - atr5m);

        // Funding rate
        const fundingRate = fundingData?.lastFundingRate != null
            ? Number(fundingData.lastFundingRate) : null;

        // Spread from order book
        const bestBid    = Number(depthData?.bids?.[0]?.[0] ?? price - 0.05);
        const bestAsk    = Number(depthData?.asks?.[0]?.[0] ?? price + 0.05);
        const spreadUsd  = bestAsk - bestBid;

        // OB imbalance (top 10 levels)
        const bids  = (depthData?.bids ?? []).slice(0, 10);
        const asks  = (depthData?.asks ?? []).slice(0, 10);
        const bidQ  = bids.reduce((s: number, b: any[]) => s + Number(b[1]), 0);
        const askQ  = asks.reduce((s: number, a: any[]) => s + Number(a[1]), 0);
        const obImbalance = (bidQ + askQ) > 0 ? (bidQ - askQ) / (bidQ + askQ) : 0;

        // VWAP (5m)
        const vwapNumer = ohlcv5m.slice(-20).reduce((s: number, c: any[]) => s + ((Number(c[2]) + Number(c[3]) + Number(c[4])) / 3) * Number(c[5]), 0);
        const vwapDenom = ohlcv5m.slice(-20).reduce((s: number, c: any[]) => s + Number(c[5]), 0);
        const vwap      = vwapDenom > 0 ? vwapNumer / vwapDenom : price;
        const priceVsVwap = ((price - vwap) / vwap) * 100;

        // OB walls (notional > $50K)
        const bidWalls = bids
            .map((b: any[]) => ({ price: Number(b[0]), notionalUsd: Number(b[0]) * Number(b[1]) }))
            .filter((b: any) => b.notionalUsd > 50_000);
        const askWalls = asks
            .map((a: any[]) => ({ price: Number(a[0]), notionalUsd: Number(a[0]) * Number(a[1]) }))
            .filter((a: any) => a.notionalUsd > 50_000);

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50,
            rsi, momentum5m: mom5m, momentum30m: mom30m, momentum1h: mom1h,
            priceStructure, trendBias4h, weeklyBias,
            atr5m, atrPct: (atr5m / price) * 100, volumeRatio,
            nearestResistance, nearestSupport,
            distanceToResistance: nearestResistance - price,
            distanceToSupport:    price - nearestSupport,
            high24h: h24, low24h: l24, adx, fundingRate,
            spreadUsd, obImbalance, priceVsVwap,
            recentSwingHigh: swings.high,
            recentSwingLow:  swings.low === Infinity ? price : swings.low,
        };

        const rangePos = h24 > l24 ? ((price - l24) / (h24 - l24) * 100).toFixed(0) : '50';
        console.log(`[Data] $${price.toFixed(2)} EMA:${emaTrend} RSI:${rsi.toFixed(1)} ADX:${adx.toFixed(1)} ATR:$${atr5m.toFixed(2)} Spread:$${spreadUsd.toFixed(3)} OB:${(obImbalance*100).toFixed(0)}% Range:${rangePos}%`);

        return [{
            symbol: DISPLAY_SYMBOL, price,
            change_24h: Number(ticker.priceChangePercent ?? 0),
            indicators,
            orderBook: { bidWalls, askWalls },
        }];
    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────
// isMomentumFresh REMOVED — was a separate klines fetch per cycle.
// Momentum conflict detection is now embedded in signals.ts bias scoring.
// This saves 1 API round trip per cycle and ~500ms of latency.

async function runCycle(): Promise<void> {
    checkReset();

    const session = getSession();
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | ${session.name} [${session.quality}] | ${IS_TESTNET ? '🧪 TESTNET' : '🔴 LIVE'}`);
    console.log(`[Main] trades=${stats.fills}/${CONFIG.MAX_TRADES_DAY} | tp=${stats.tpHits} sl=${stats.slHits} skipped=${stats.skipped}`);
    console.log(`[Main] vBal=$${virtualTradingBalance.toFixed(2)} | Banked=$${sessionBanked.toFixed(2)} | Total=$${(virtualTradingBalance + sessionBanked).toFixed(2)}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.fills >= CONFIG.MAX_TRADES_DAY) {
        console.log(`[Main] Daily limit reached (${CONFIG.MAX_TRADES_DAY}).`);
        return;
    }

    try {
        const health = await checkPositionHealth();

        if (health === 'tp') {
            if (pendingTrade) {
                const net = pendingTrade.netProfit;
                stats.fills++;
                stats.tpHits++;
                stats.grossProfit += pendingTrade.grossProfit;
                stats.netProfit   += net;
                if (pendingTrade.fillTimeMs) stats.fillTimes.push(pendingTrade.fillTimeMs);
                bankProfit(net);
                clearActiveTrade();
                pendingTrade = null;
            }
            await updateRealPnl();
            return;
        }

        if (health === 'sl') {
            pendingTrade = null;
            await updateRealPnl();
            return;
        }

        if (health === 'open') {
            if (!pendingTrade) {
                console.log(`[Main] 🚨 Orphan position — closing...`);
                const pos = await getOpenPositionDetails();
                if (pos.exists && pos.side && pos.size > 0) {
                    await triggerStopLoss(pos.side, pos.size, 'orphan on startup');
                }
                return;
            }
            console.log(`[Main] 📊 Trade open — SL@$${pendingTrade.slPrice.toFixed(2)} TP@$${pendingTrade.tpPrice.toFixed(2)}`);
            return;
        }

        // ── No position — attempt new entry ──────────────────────────────

        const balance = await getAvailableBalance();

        if (virtualTradingBalance <= 0) {
            if (balance <= 0) {
                console.log(`[Main] ⚠️ Balance unavailable this cycle.`);
                return;
            }
            virtualTradingBalance = balance;
            initialBalance.value  = balance;
            initialBalance.set    = true;
            console.log(`[Bank] 💰 Init: $${virtualTradingBalance.toFixed(4)}`);
        }

        const effectiveBalance = balance > 0 ? balance : virtualTradingBalance;
        if (effectiveBalance < 1.50) { console.log(`[Main] ⚠️ Balance too low.`); return; }

        if (balance >= CONFIG.RECYCLE_BALANCE) {
            console.log(`[Main] 🎯 RECYCLE — $${balance.toFixed(2)} ≥ $${CONFIG.RECYCLE_BALANCE} | Consider withdrawing $${(balance - CONFIG.RECYCLE_KEEP).toFixed(2)}`);
        }

        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No market data.`); return; }

        // generateSignals is now synchronous (no Gemini API call)
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
                    size:        calcSize(virtualTradingBalance, result.entryPrice, result.sizePct ?? 0.80, result.leverage ?? 40),
                    grossProfit: result.grossProfit!,
                    netProfit:   result.netProfit!,
                    fees:        result.fees!,
                    openedAt:    Date.now(),
                    tpMove:      result.tpMove,
                    fillTimeMs:  result.fillTimeMs,
                };
            } else if (result.outcome === 'skipped') {
                stats.attempts--;
                stats.skipped++;
            } else if (result.outcome === 'error') {
                console.error(`[Main] Trade error: ${result.message}`);
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
    const ms = Math.floor(
        Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin
    );
    console.log(`[Main] Next cycle in ${(ms / 1000).toFixed(0)}s [${session.name}]`);
    setTimeout(async () => {
        try { await runCycle(); } catch (e: any) { console.error(`[Main] Uncaught: ${e.message}`); }
        scheduleNext();
    }, ms);
}

// ─── SHUTDOWN ─────────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { printDailySummary(); process.exit(0); });
process.on('SIGINT',  () => { printDailySummary(); process.exit(0); });

// ─── STARTUP ──────────────────────────────────────────────────────────────────

const hasKeys = ENVIRONMENT === 'live'
    ? (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET)
    : (process.env.BINANCE_BOT_API && process.env.BINANCE_BOT_SECRET);

if (!hasKeys) {
    console.error(ENVIRONMENT === 'live'
        ? '❌ Missing: BINANCE_API_KEY, BINANCE_API_SECRET'
        : '❌ Missing: BINANCE_BOT_API, BINANCE_BOT_SECRET'
    );
    process.exit(1);
}

const startupMsg = [
    `MODUVISE GOLD PERP BOT v2 — BINANCE FUTURES`,
    `Mode:       ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'}`,
    `Asset:      XAUUSDT perp`,
    `Leverage:   40x`,
    `Entry:      GTX (ALO) @ ±$0.15 from market | 0.00% maker fee`,
    `TP:         $0.50 GTX resting | 0.00% maker fee`,
    `SL:         $2.00 monitored | MARKET reduceOnly | 0.045% taker`,
    `R:R:        1:4 — breakeven at 80% win rate (before taker fee on SL)`,
    `Daily cap:  ${CONFIG.MAX_TRADES_DAY} trades`,
    `Cycles:     Peak 20–30s | High 25–40s | Off-hours 60–90s`,
    `Gemini:     REMOVED — pure local bias engine, zero API latency`,
    `Momentum:   Embedded in bias score — no separate klines call`,
    `Banking:    50% banked per TP | Recycle at $${CONFIG.RECYCLE_BALANCE}`,
    `Start:      ${new Date().toISOString()}`,
].join('\n  ');

console.log(`\n${'█'.repeat(65)}\n  ${startupMsg}\n${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);
