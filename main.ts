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
// 'demo'    → demo.binance.com keys (BINANCE_BOT_API / BINANCE_BOT_SECRET)
// 'testnet' → testnet.binancefuture.com keys
// 'live'    → binance.com live keys

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
    MAX_TRADES_DAY:      300,
    MAX_TRADING_BALANCE: 25_000,     // capped at 40x × $25K = $1M max notional
    BANK_FRACTION:       0.30,       // 50% banked per TP
    RECYCLE_BALANCE:     800,
    RECYCLE_KEEP:        400,
    MOMENTUM_CANDLES:    3,
} as const;

// ─── EXCHANGE (market data only) ──────────────────────────────────────────────

const API_KEY    = ENVIRONMENT === 'live'
    ? (process.env.BINANCE_API_KEY    ?? '')
    : (process.env.BINANCE_BOT_API    ?? '');

const API_SECRET = ENVIRONMENT === 'live'
    ? (process.env.BINANCE_API_SECRET ?? '')
    : (process.env.BINANCE_BOT_SECRET ?? '');

// Public market data — no auth, point directly at demo-fapi.binance.com
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
    date:            string;
    attempts:        number;
    fills:           number;
    tpHits:          number;
    slHits:          number;
    momentumBlocked: number;
    grossProfit:     number;
    netProfit:       number;
    slLoss:          number;
    sessionBanked:   number;
    fillTimes:       number[];
    avgFillMs:       number;
}

let stats: DayStats = freshStats();

function freshStats(): DayStats {
    return {
        date: new Date().toISOString().slice(0, 10),
        attempts: 0, fills: 0, tpHits: 0, slHits: 0,
        momentumBlocked: 0, grossProfit: 0, netProfit: 0,
        slLoss: 0, sessionBanked: 0, fillTimes: [], avgFillMs: 0,
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
    const total  = virtualTradingBalance + sessionBanked;
    const uptime = ((Date.now() - startTime) / 3600000).toFixed(1);
    const tpRate = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    stats.avgFillMs = stats.fillTimes.length > 0
        ? stats.fillTimes.reduce((a, b) => a + b, 0) / stats.fillTimes.length : 0;

    const summary = [
        `📊 DAILY SUMMARY — ${stats.date} (${uptime}h uptime)`,
        `Attempts: ${stats.attempts} | Fills: ${stats.fills} | TP: ${stats.tpHits} (${tpRate}%) | SL: ${stats.slHits} | MomBlock: ${stats.momentumBlocked}`,
        `Gross P&L: $${stats.grossProfit.toFixed(4)} | Net: $${stats.netProfit.toFixed(4)} | SL losses: $${stats.slLoss.toFixed(4)}`,
        `Banked today: $${stats.sessionBanked.toFixed(4)}`,
        `💼 vBal: $${virtualTradingBalance.toFixed(2)} | 🏦 Banked: $${sessionBanked.toFixed(2)} | 📊 Total: $${total.toFixed(2)}`,
        initialBalance.set ? `📈 Return: ${((total - initialBalance.value) / initialBalance.value * 100).toFixed(2)}%` : '',
    ].filter(Boolean).join('\n');

    console.log(`\n${'█'.repeat(65)}\n${summary}\n${'█'.repeat(65)}\n`);
}

// ─── MOMENTUM FRESHNESS ───────────────────────────────────────────────────────

async function isMomentumFresh(direction: 'long' | 'short'): Promise<boolean> {
    try {
        const candles = await fetchKlines(MARKET_SYMBOL, '1m', CONFIG.MOMENTUM_CANDLES + 2);
        if (!candles || candles.length < CONFIG.MOMENTUM_CANDLES + 1) return true;

        const recent = candles.slice(-(CONFIG.MOMENTUM_CANDLES + 1));
        let conflicts = 0;

        for (let i = 1; i < recent.length; i++) {
            const open  = Number(recent[i]?.[1] ?? 0);
            const close = Number(recent[i]?.[4] ?? 0);
            if (direction === 'long'  && close < open) conflicts++;
            if (direction === 'short' && close > open) conflicts++;
        }

        if (conflicts >= CONFIG.MOMENTUM_CANDLES) {
            console.log(`[Momentum] 🚫 All ${CONFIG.MOMENTUM_CANDLES} candles against ${direction.toUpperCase()} — skip.`);
            return false;
        }
        console.log(`[Momentum] ✅ ${direction.toUpperCase()} fresh (${conflicts}/${CONFIG.MOMENTUM_CANDLES} conflicts).`);
        return true;
    } catch (e: any) {
        console.warn(`[Momentum] Check failed: ${e.message} — allowing entry.`);
        return true;
    }
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
        console.log(`[Health] Orphan position detected — no trade record.`);
        return 'open';
    }

    const adverseMove = pos.side === 'long'
        ? trade.entryPrice - pos.currentPrice
        : pos.currentPrice - trade.entryPrice;

    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);
    const inFavour    = -adverseMove;

    const emoji = adverseMove > slThreshold * 0.7 ? '🔴' :
                  adverseMove > 0                 ? '🟡' : '🟢';

    console.log(`[Health] ${emoji} ${pos.side?.toUpperCase()} @ $${trade.entryPrice.toFixed(2)} | now $${pos.currentPrice.toFixed(2)} | ${adverseMove > 0 ? `adverse -$${adverseMove.toFixed(2)}` : `+$${inFavour.toFixed(2)}`} | SL@$${trade.slPrice.toFixed(2)} (±$${slThreshold.toFixed(2)})`);

    if (adverseMove >= slThreshold) {
        console.log(`[Health] 🛑 SL TRIGGERED — $${adverseMove.toFixed(2)} ≥ $${slThreshold.toFixed(2)} | 1:1 R:R`);

        await triggerStopLoss(pos.side!, pos.size, `$${adverseMove.toFixed(2)} adverse ≥ $${slThreshold.toFixed(2)}`);

        const slLoss  = pos.size * adverseMove;
        const fees    = pendingTrade?.fees ?? (pos.size * pos.currentPrice * 0.0005); // taker-only SL exit
        const netLoss = -(slLoss + fees);

        stats.slHits++;
        stats.slLoss    += slLoss;
        stats.netProfit += netLoss;
        virtualTradingBalance = Math.max(1.50, virtualTradingBalance + netLoss);

        pendingTrade = null;
        clearActiveTrade();
        return 'sl';
    }

    return 'open';
}

// ─── BANKING ──────────────────────────────────────────────────────────────────

function bankProfit(netProfit: number): void {
    const atCap = virtualTradingBalance >= CONFIG.MAX_TRADING_BALANCE;

    if (atCap) {
        sessionBanked       += netProfit;
        stats.sessionBanked += netProfit;
        console.log(`[Bank] 🏦 CAP REACHED — 100% banked: +$${netProfit.toFixed(4)} | Total banked: $${sessionBanked.toFixed(4)}`);
    } else {
        const banked   = netProfit * CONFIG.BANK_FRACTION;
        const compound = netProfit * (1 - CONFIG.BANK_FRACTION);

        sessionBanked         += banked;
        virtualTradingBalance  = Math.min(virtualTradingBalance + compound, CONFIG.MAX_TRADING_BALANCE);
        stats.sessionBanked   += banked;

        console.log(`[Bank] ✅ Net=$${netProfit.toFixed(4)} | +$${compound.toFixed(4)} compound | +$${banked.toFixed(4)} banked`);
        console.log(`[Bank] 💼 vBal=$${virtualTradingBalance.toFixed(2)} | 🏦 Banked=$${sessionBanked.toFixed(2)} | Total=$${(virtualTradingBalance + sessionBanked).toFixed(2)}`);
    }
}

// ─── REAL PnL TRACKER ─────────────────────────────────────────────────────────

async function updateRealPnl(): Promise<void> {
    try {
        // Raw signed fetch — ccxt private calls don't work on demo-fapi
        const { createHmac } = await import('crypto');
        const secret  = process.env.BINANCE_BOT_SECRET ?? process.env.BINANCE_API_SECRET ?? '';
        const apiKey  = process.env.BINANCE_BOT_API    ?? process.env.BINANCE_API_KEY    ?? '';
        const ts      = Date.now();
        const query   = `symbol=${MARKET_SYMBOL}&limit=20&timestamp=${ts}&recvWindow=10000`;
        const sig     = createHmac('sha256', secret).update(query).digest('hex');
        const res     = await fetch(`${BASE_URL}/fapi/v1/userTrades?${query}&signature=${sig}`, {
            headers: { 'X-MBX-APIKEY': apiKey },
        });
        if (!res.ok) return;
        const trades = await res.json() as any[];
        if (!trades?.length) return;
        let pnl = 0, w = 0, l = 0;
        for (const t of trades) {
            const p = parseFloat(t.realizedPnl ?? '0');
            if (!isNaN(p) && p !== 0) { pnl += p; if (p > 0) w++; else l++; }
        }
        if (w + l > 0) console.log(`[Main] 📊 Exchange recent ${w + l} trades: $${pnl.toFixed(4)} W:${w} L:${l} WR:${((w / (w + l)) * 100).toFixed(0)}%`);
    } catch { /* non-critical */ }
}

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────

function ema(candles: any[], period: number): number {
    if (candles.length < period) return Number(candles[candles.length - 1]?.[4] ?? 0);
    const k = 2 / (period + 1);
    let val = candles.slice(0, period).reduce((s: number, c: any) => s + Number(c?.[4] ?? 0), 0) / period;
    for (let i = period; i < candles.length; i++) {
        val = Number(candles[i]?.[4] ?? val) * k + val * (1 - k);
    }
    return val;
}

function calcRSI(candles: any[], period = 14): number {
    if (candles.length < period + 1) return 50;
    let g = 0, l = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const d = Number(candles[i]?.[4] ?? 0) - Number(candles[i - 1]?.[4] ?? 0);
        if (d > 0) g += d; else l -= d;
    }
    if (l === 0) return 100;
    return 100 - 100 / (1 + (g / period) / (l / period));
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

function calcVwap(candles: any[]): number {
    let tpv = 0, vol = 0;
    for (const c of candles) {
        const tp = (+c?.[2]||0 + +c?.[3]||0 + +c?.[4]||0) / 3;
        tpv += tp * (+c?.[5]||0); vol += +c?.[5]||0;
    }
    return vol > 0 ? tpv / vol : 0;
}

function calcSwings(candles: any[], n = 20): { high: number; low: number } {
    const s = candles.slice(-n);
    let h = 0, l = Infinity;
    for (const c of s) { if (+c?.[2] > h) h = +c[2]; if (+c?.[3] < l) l = +c[3]; }
    return { high: h, low: l === Infinity ? 0 : l };
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

async function rawGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const qs  = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    const url = `${BASE_URL}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    const data = await rawGet('/fapi/v1/klines', { symbol, interval, limit });
    return Array.isArray(data) ? data : [];
}

async function fetchMarketData(): Promise<MarketData[]> {
    console.log(`[Data] Fetching XAUUSDT market data from Binance...`);
    try {
        const [ticker, ob, c5m, c30m, c1h, c4h, c1w, frData] = await Promise.all([
            rawGet('/fapi/v1/ticker/24hr', { symbol: MARKET_SYMBOL }),
            rawGet('/fapi/v1/depth',       { symbol: MARKET_SYMBOL, limit: 20 }),
            fetchKlines(MARKET_SYMBOL, '5m',  50),
            fetchKlines(MARKET_SYMBOL, '30m', 12),
            fetchKlines(MARKET_SYMBOL, '1h',  60),
            fetchKlines(MARKET_SYMBOL, '4h',  10),
            fetchKlines(MARKET_SYMBOL, '1w',   3),
            rawGet('/fapi/v1/premiumIndex', { symbol: MARKET_SYMBOL }).catch(() => null),
        ]);

        // Binance klines: [openTime, open, high, low, close, volume, ...]
        // ccxt format:    [openTime, open, high, low, close, volume]
        // They match — index same.

        const price = Number(ticker.lastPrice ?? 0);
        if (!price) { console.warn(`[Data] No price`); return []; }

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
        const volumeRatio = avgVol > 0 ? (vols[vols.length - 1] ?? 0) / avgVol : 1;

        const ema = (candles: any[], period: number): number => {
            if (candles.length < period) return Number(candles[candles.length - 1]?.[4] ?? 0);
            const k = 2 / (period + 1);
            let val = candles.slice(0, period).reduce((s: number, c: any) => s + Number(c?.[4] ?? 0), 0) / period;
            for (let i = period; i < candles.length; i++) val = Number(candles[i]?.[4] ?? val) * k + val * (1 - k);
            return val;
        };

        const ema8  = ema(c1h, 8);
        const ema21 = ema(c1h, 21);
        const ema50 = ema(c1h, 50);
        const emaTrend: 'bullish' | 'bearish' | 'neutral' =
            ema8 > ema21 && ema21 > ema50 ? 'bullish' :
            ema8 < ema21 && ema21 < ema50 ? 'bearish' : 'neutral';

        const calcRSI = (candles: any[], period = 14): number => {
            if (candles.length < period + 1) return 50;
            let g = 0, l = 0;
            for (let i = candles.length - period; i < candles.length; i++) {
                const d = Number(candles[i]?.[4] ?? 0) - Number(candles[i - 1]?.[4] ?? 0);
                if (d > 0) g += d; else l -= d;
            }
            if (l === 0) return 100;
            return 100 - 100 / (1 + (g / period) / (l / period));
        };

        const rsi = calcRSI(c1h, 14);

        const now  = +c5m[c5m.length - 1]?.[4]  || price;
        const p5m  = +c5m[Math.max(0, c5m.length - 2)]?.[4]  || price;
        const p30m = +c30m[Math.max(0, c30m.length - 2)]?.[4] || price;
        const p1h  = +c1h[Math.max(0, c1h.length - 13)]?.[4] || price;

        const c4hClose = +c4h[c4h.length - 1]?.[4] || price;
        const c4hPrev  = +c4h[Math.max(0, c4h.length - 2)]?.[4] || price;
        const trendBias4h: 'bull' | 'bear' | 'neutral' =
            c4hClose > c4hPrev * 1.001 ? 'bull' :
            c4hClose < c4hPrev * 0.999 ? 'bear' : 'neutral';

        const wClose = +c1w[c1w.length - 1]?.[4] || price;
        const wPrev  = +c1w[Math.max(0, c1w.length - 2)]?.[4] || price;
        const weeklyBias: 'bullish' | 'bearish' | 'neutral' =
            wClose > wPrev ? 'bullish' : wClose < wPrev ? 'bearish' : 'neutral';

        const h24 = Number(ticker.highPrice ?? price);
        const l24 = Number(ticker.lowPrice  ?? price);
        const mid = (h24 + l24) / 2;
        const priceStructure: 'uptrend' | 'downtrend' | 'ranging' =
            price > mid * 1.001 ? 'uptrend' :
            price < mid * 0.999 ? 'downtrend' : 'ranging';

        const calcADX = (candles: any[], period = 14): number => {
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
        };

        const adx = calcADX(c5m, 14);

        // Order book — Binance depth format: { bids: [[price, qty]], asks: [[price, qty]] }
        const wallFilter = (levels: string[][]) =>
            levels.map(l => ({ price: +l[0]||0, notionalUsd: (+l[0]||0) * (+l[1]||0) }))
                  .filter(w => w.notionalUsd > 500).slice(0, 5);

        const bidWalls          = wallFilter(ob.bids ?? []);
        const askWalls          = wallFilter(ob.asks ?? []);
        const nearestSupport    = bidWalls[0]?.price ?? price - 10;
        const nearestResistance = askWalls[0]?.price ?? price + 10;

        const bestBid   = +(ob.bids?.[0]?.[0] ?? price);
        const bestAsk   = +(ob.asks?.[0]?.[0] ?? price);
        const spreadUsd = Math.max(0, bestAsk - bestBid);

        const bidVol     = (ob.bids ?? []).slice(0, 5).reduce((s: number, l: string[]) => s + (+l[1]||0), 0);
        const askVol     = (ob.asks ?? []).slice(0, 5).reduce((s: number, l: string[]) => s + (+l[1]||0), 0);
        const totalObVol = bidVol + askVol;
        const obImbalance = totalObVol > 0 ? (bidVol - askVol) / totalObVol : 0;

        const calcVwap = (candles: any[]): number => {
            let tpv = 0, vol = 0;
            for (const c of candles) {
                const tp = (+c?.[2]||0 + +c?.[3]||0 + +c?.[4]||0) / 3;
                tpv += tp * (+c?.[5]||0); vol += +c?.[5]||0;
            }
            return vol > 0 ? tpv / vol : 0;
        };

        const vwap        = calcVwap(c5m);
        const priceVsVwap = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

        const swings = c5m.slice(-20).reduce(
            (acc: { high: number; low: number }, c: any) => ({
                high: Math.max(acc.high, +c?.[2]||0),
                low:  Math.min(acc.low,  +c?.[3]||Infinity),
            }),
            { high: 0, low: Infinity }
        );

        const fundingRate: number | null = frData ? Number(frData.lastFundingRate ?? null) : null;

        const indicators: TechnicalIndicators = {
            emaTrend, ema8, ema21, ema50, rsi,
            momentum5m:  (now - p5m) / (p5m || 1) * 100,
            momentum30m: (now - p30m) / (p30m || 1) * 100,
            momentum1h:  (now - p1h) / (p1h || 1) * 100,
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
        console.log(`[Data] $${price.toFixed(2)} EMA:${emaTrend} RSI:${rsi.toFixed(1)} ADX:${adx.toFixed(1)} Spread:$${spreadUsd.toFixed(3)} Range:${rangePos}%`);

        return [{ symbol: DISPLAY_SYMBOL, price, change_24h: Number(ticker.priceChangePercent ?? 0), indicators, orderBook: { bidWalls, askWalls } }];
    } catch (e: any) {
        console.error(`[Data] Error: ${e.message}`);
        return [];
    }
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
    checkReset();

    const session = getSession();
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`[Main] ${new Date().toISOString()} | ${session.name} [${session.quality}] | ${IS_TESTNET ? '🧪 TESTNET' : '🔴 LIVE'}`);
    console.log(`[Main] attempts=${stats.attempts} fills=${stats.fills} tp=${stats.tpHits} sl=${stats.slHits} momBlocked=${stats.momentumBlocked}`);
    console.log(`[Main] vBal=$${virtualTradingBalance.toFixed(2)} | Banked=$${sessionBanked.toFixed(2)} | Total=$${(virtualTradingBalance + sessionBanked).toFixed(2)} | Cap=$${CONFIG.MAX_TRADING_BALANCE.toLocaleString()}`);
    console.log(`${'═'.repeat(65)}`);

    if (stats.attempts >= CONFIG.MAX_TRADES_DAY) {
        console.log(`[Main] Daily limit reached.`);
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
                // Orphan position — no local record. Close it immediately to protect capital.
                console.log(`[Main] 🚨 Orphan position — closing to protect capital...`);
                const pos = await getOpenPositionDetails();
                if (pos.exists && pos.side && pos.size > 0) {
                    await triggerStopLoss(pos.side, pos.size, 'orphan position on restart');
                    console.log(`[Main] ✅ Orphan position closed.`);
                }
                return;
            }
            console.log(`[Main] 📊 Trade in progress — SL@$${pendingTrade.slPrice.toFixed(2)} TP@$${pendingTrade.tpPrice.toFixed(2)}`);
            return;
        }

        // ── No position — attempt new trade ──────────────────────────────

        const balance = await getAvailableBalance();
        console.log(`[Main] On-chain balance: $${balance.toFixed(4)}`);

        if (virtualTradingBalance <= 0) {
            if (balance <= 0) {
                console.log(`[Main] ⚠️ Balance unavailable this cycle — retrying next cycle.`);
                return;
            }
            virtualTradingBalance = balance;
            initialBalance.value  = balance;
            initialBalance.set    = true;
            console.log(`[Bank] 💰 Init virtual balance: $${virtualTradingBalance.toFixed(4)}`);
        }

        // Use virtualTradingBalance as fallback if on-chain fetch returned 0
        const effectiveOnChain = balance > 0 ? balance : virtualTradingBalance;
        if (effectiveOnChain < 1.50) { console.log(`[Main] ⚠️ Balance too low.`); return; }

        if (balance >= CONFIG.RECYCLE_BALANCE) {
            console.log(`[Main] 🎯 RECYCLE ALERT — $${balance.toFixed(2)} ≥ $${CONFIG.RECYCLE_BALANCE}\nConsider withdrawing $${(balance - CONFIG.RECYCLE_KEEP).toFixed(2)}, keeping $${CONFIG.RECYCLE_KEEP}.`);
        }

        const assets = await fetchMarketData();
        if (!assets.length) { console.log(`[Main] No data.`); return; }

        const signals = await generateSignals(assets);

        for (const signal of signals) {
            if (signal.direction === 'neutral') { console.log(`[Main] ⏸️ Neutral.`); continue; }

            const fresh = await isMomentumFresh(signal.direction as 'long' | 'short');
            if (!fresh) { stats.momentumBlocked++; continue; }

            stats.attempts++;

            const result = await executeBinanceTrade(signal, virtualTradingBalance);

            if (result.outcome === 'orders_placed' && result.entryPrice) {
                pendingTrade = {
                    entryPrice:  result.entryPrice,
                    tpPrice:     result.tpPrice!,
                    slPrice:     result.slPrice!,
                    side:        signal.direction as 'long' | 'short',
                    size:        calcSize(virtualTradingBalance, result.entryPrice, result.sizePct ?? 0.80, result.leverage ?? 20),
                    grossProfit: result.grossProfit!,
                    netProfit:   result.netProfit!,
                    fees:        result.fees!,
                    openedAt:    Date.now(),
                    tpMove:      result.tpMove,
                    fillTimeMs:  result.fillTimeMs,
                } as any;
            } else if (result.outcome === 'skipped') {
                stats.attempts--;
            } else if (result.outcome === 'error') {
                console.error(`[Main] Trade error: ${result.message}`);
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
    const ms = Math.floor(
        Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin
    );
    console.log(`[Main] Next cycle in ${(ms / 1000).toFixed(0)}s [${session.name}]`);
    setTimeout(async () => {
        try { await runCycle(); } catch (e: any) { console.error(`[Main] Uncaught: ${e.message}`); }
        scheduleNext();
    }, ms);
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────

process.on('SIGTERM', () => { printDailySummary(); process.exit(0); });
process.on('SIGINT',  () => { printDailySummary(); process.exit(0); });

// ─── STARTUP ──────────────────────────────────────────────────────────────────

const hasKeys = ENVIRONMENT === 'live'
    ? (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET)
    : (process.env.BINANCE_BOT_API && process.env.BINANCE_BOT_SECRET);

if (!hasKeys) {
    console.error(ENVIRONMENT === 'live'
        ? '❌ Missing: BINANCE_API_KEY, BINANCE_API_SECRET (live binance.com keys)'
        : '❌ Missing: BINANCE_BOT_API, BINANCE_BOT_SECRET (from demo.binance.com/api-management)'
    );
    process.exit(1);
}

const startupMsg = [
    `MODUVISE GOLD PERP BOT — BINANCE FUTURES`,
    `Mode:      ${IS_TESTNET ? '🧪 TESTNET (demo.binance.com)' : '🔴 MAINNET (live)'}`,
    `Asset:     XAUUSDT perp`,
    `Leverage:  40x fixed`,
    `Entry:     ALO GTX @ -$0.30 from market | 0.00% maker fee`,
    `TP:        $0.50 FIXED | GTX resting maker | 0.00% maker fee`,
    `SL:        $2.00 fixed | Taker market exit | 0.05% taker fee`,
    `R:R:       1:4 (risk $2 to make $0.50) — breakeven at 89% win rate`,
    `Fees:      Entry=FREE | TP=FREE | SL exit=0.05% taker only`,
    `Size:      DYNAMIC — session quality × ATR regime (20%–95% of balance)`,
    `Fee gate:  Gross > fees × 1 (always passes at 0% maker)`,
    `Cap:       $${CONFIG.MAX_TRADING_BALANCE.toLocaleString()} trading balance (40x = $1M max notional)`,
    `Banking:   50% banked per TP | 100% banked at cap`,
    `Start:     ${new Date().toISOString()}`,
].join('\n  ');

console.log(`\n${'█'.repeat(65)}\n  ${startupMsg}\n${'█'.repeat(65)}\n`);

runCycle().then(scheduleNext);