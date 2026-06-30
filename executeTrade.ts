import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────
export const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
export const IS_DEMO     = ENVIRONMENT !== 'live';

const BASE_URL   = IS_DEMO ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
const API_KEY    = IS_DEMO ? (process.env.BINANCE_BOT_API    ?? '') : (process.env.BINANCE_API_KEY    ?? '');
const API_SECRET = IS_DEMO ? (process.env.BINANCE_BOT_SECRET ?? '') : (process.env.BINANCE_API_SECRET ?? '');

// ─── PER-SYMBOL CONFIGURATION ─────────────────────────────────────────────────
// Each symbol has its own TP target, SL distance, tick size, and qty precision.
// TP targets are fixed dollar moves for HFT scalping — not ATR-based percentages.
// SL is set wide enough to survive normal oscillation but tight enough to protect capital.
//
// HFT Scalping targets (as requested):
//   XAUUSDT : TP = $0.05  | SL = $0.30  (6:1 risk — tight gold scalp)
//   ETHUSDT : TP = $5.00  | SL = $10.00 (2:1 risk — ETH has clean $5 swings)
//   BTCUSDT : TP = $10.00 | SL = $20.00 (2:1 risk — BTC minimum viable move)
//   DOGEUSDT: TP = 0.47%  | SL = 1.00%  (2:1 risk — percentage-based for tiny price)
//
// SL is placed as Stop-Limit (maker) not Stop-Market, to avoid taker fees.
// Limit price is set 1 tick beyond trigger to ensure fill while staying maker.

interface SymbolConfig {
    tick:        number;   // minimum price increment
    qtyStep:     number;   // minimum quantity increment
    minQty:      number;   // minimum order quantity
    priceDp:     number;   // decimal places for price
    qtyDp:       number;   // decimal places for quantity
    maxLeverage: number;   // exchange maximum leverage
    tpFixed:     number;   // fixed TP in USD (or fraction for DOGE %)
    tpIsPct:     boolean;  // true = tpFixed is a percentage of price
    slFixed:     number;   // fixed SL distance in USD (or fraction for DOGE %)
    slIsPct:     boolean;  // true = slFixed is a percentage of price
    tp2Offset:   number;   // TP2 rescue limit offset from entry
    entryOffset: number;   // how far inside bid/ask to place entry (maker offset)
}

function getConfig(symbol: string): SymbolConfig {
    const s = symbol.toUpperCase();
    if (s === 'ETHUSDT')  return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100,
        tpFixed: 5.00,   tpIsPct: false,   // $5 TP
        slFixed: 10.00,  slIsPct: false,   // $10 SL
        tp2Offset: 1.00, entryOffset: 0.01,
    };
    if (s === 'BTCUSDT')  return {
        tick: 0.10, qtyStep: 0.001, minQty: 0.001, priceDp: 1, qtyDp: 3,
        maxLeverage: 100,
        tpFixed: 10.00,  tpIsPct: false,   // $10 TP
        slFixed: 20.00,  slIsPct: false,   // $20 SL
        tp2Offset: 2.00, entryOffset: 0.10,
    };
    if (s === 'DOGEUSDT') return {
        tick: 0.00001, qtyStep: 1, minQty: 1, priceDp: 5, qtyDp: 0,
        maxLeverage: 75,
        tpFixed: 0.0047, tpIsPct: true,    // 0.47% of price
        slFixed: 0.0100, slIsPct: true,    // 1.00% of price
        tp2Offset: 0.0001, entryOffset: 0.00001,
    };
    // Default: XAUUSDT
    return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100,
        tpFixed: 0.05,   tpIsPct: false,   // $0.05 TP
        slFixed: 0.30,   slIsPct: false,   // $0.30 SL
        tp2Offset: 0.03, entryOffset: 0.01,
    };
}

const _cfg = getConfig(MARKET_SYMBOL);

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
const STRATEGY = {
    SYMBOL:          MARKET_SYMBOL,
    MARGIN_PER_TRADE: Number(process.env.MARGIN_PER_TRADE ?? 1),

    get LEVERAGE() {
        const raw = Number(process.env.BOT_LEVERAGE ?? (IS_DEMO ? 10 : 100));
        const cap = _cfg.maxLeverage;
        return IS_DEMO ? Math.min(raw, 10) : Math.min(raw, cap);
    },

    TP1_TIMEOUT_MS:    90_000,
    TP2_TIMEOUT_MS:    30_000,
    SCRATCH_TIMEOUT_MS: 130_000,

    FILL_TIMEOUT: 60_000,
    MIN_NOTIONAL: 5.0,
} as const;

// ─── INTERFACES ───────────────────────────────────────────────────────────────
export type TradeOutcome = 'orders_placed' | 'tp_confirmed' | 'sl_triggered' | 'skipped' | 'error';

export interface TradeResult {
    success:      boolean;
    outcome:      TradeOutcome;
    entryPrice?:  number;
    tpPrice?:     number;
    slPrice?:     number;
    grossProfit?: number;
    message?:     string;
    fillTimeMs?:  number;
}

export interface ActiveTrade {
    entryPrice:    number;
    tpPrice:       number;
    slPrice:       number;
    side:          'long' | 'short';
    size:          number;
    margin:        number;
    posVal:        number;
    leverage:      number;
    openedAt:      number;
    tpOrderId?:    number;
    slOrderId?:    number;
    tp2Phase:      boolean;
    tp2StartedAt?: number;
    tp2OrderId?:   number;
    tp2Price?:     number;
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

// ─── ALERTING ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_GROUP_ID  ?? process.env.TELEGRAM_CHAT_ID ?? '';

export async function sendAlert(message: string): Promise<void> {
    console.log(`[Alert] ${message}`);
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `🤖 ${message}` }),
            signal:  AbortSignal.timeout(8_000),
        });
    } catch (e: any) {
        console.error(`[Alert] Telegram failed: ${e.message}`);
    }
}

// ─── API INFRASTRUCTURE ───────────────────────────────────────────────────────
function signedUrl(path: string, params: Record<string, string | number> = {}): string {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const query   = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(query).digest('hex');
    return `${BASE_URL}${path}?${query}&signature=${sig}`;
}

export async function privateGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), {
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

export async function privatePost(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const rawQ    = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const body    = Object.entries(entries).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(rawQ).digest('hex');
    const res = await fetch(`${BASE_URL}${path}`, {
        method:  'POST',
        headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body + `&signature=${sig}`,
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

async function privateDelete(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), {
        method:  'DELETE',
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
export async function getAvailableBalance(): Promise<number> {
    try {
        const data = await privateGet('/fapi/v3/account');
        return Number(data?.availableBalance ?? 0);
    } catch { return 0; }
}

export async function hasOpenPosition(): Promise<boolean> {
    try {
        const data = await privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL });
        return Array.isArray(data) && data.some((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0);
    } catch { return false; }
}

export async function getOpenPositionDetails(): Promise<{
    exists: boolean; side: 'long' | 'short' | null;
    entryPrice: number; size: number; currentPrice: number;
}> {
    try {
        const [positions, priceData] = await Promise.all([
            privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL }),
            fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()),
        ]);
        const pos = Array.isArray(positions)
            ? positions.find((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0)
            : null;
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0, currentPrice: 0 };
        return {
            exists:       true,
            side:         Number(pos.positionAmt) > 0 ? 'long' : 'short',
            entryPrice:   Number(pos.entryPrice),
            size:         Math.abs(Number(pos.positionAmt)),
            currentPrice: Number((priceData as any).price),
        };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0, currentPrice: 0 };
    }
}

export async function getRealizedPnlSince(sinceMs: number): Promise<{ pnl: number; trades: number } | null> {
    try {
        await new Promise(r => setTimeout(r, 1_500));
        const data = await privateGet('/fapi/v1/userTrades', {
            symbol:    STRATEGY.SYMBOL,
            startTime: sinceMs,
            limit:     50,
        });
        if (!Array.isArray(data) || !data.length) {
            // Retry with broader window for clock skew
            const data2 = await privateGet('/fapi/v1/userTrades', {
                symbol:    STRATEGY.SYMBOL,
                startTime: sinceMs - 10_000,
                limit:     50,
            });
            if (!Array.isArray(data2) || !data2.length) return null;
            const pnl2 = data2.reduce((s: number, t: any) => s + Number(t.realizedPnl ?? 0), 0);
            console.log(`[PnL] ${data2.length} trades (broad) | PnL: $${pnl2.toFixed(6)}`);
            return { pnl: pnl2, trades: data2.length };
        }
        const pnl = data.reduce((s: number, t: any) => s + Number(t.realizedPnl ?? 0), 0);
        console.log(`[PnL] ${data.length} trades | PnL: $${pnl.toFixed(6)}`);
        return { pnl, trades: data.length };
    } catch (e: any) {
        console.error(`[PnL] Failed: ${e.message}`);
        return null;
    }
}

export async function cancelAllOrders(slAlgoId?: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL });
        console.log(`[Cleanup] All orders cancelled`);
    } catch (e: any) {
        console.error(`[Cleanup] Cancel failed: ${e.message}`);
    }
    if (slAlgoId && slAlgoId > 0) {
        try {
            await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: slAlgoId });
        } catch { /* no-op */ }
    }
}

export async function cancelAlgoOrder(algoId: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId });
    } catch { /* no-op */ }
}

export async function triggerEmergencyClose(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[EMERGENCY] 🛑 ${closeSide} ${size} ${STRATEGY.SYMBOL} | ${reason}`);
    await cancelAllOrders();

    // Try limit close first (maker — no fee)
    try {
        const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${STRATEGY.SYMBOL}`)
            .then(r => r.json()) as any;
        const limitPrice = closeSide === 'SELL' ? Number(ticker.bidPrice) : Number(ticker.askPrice);
        const limitOrder = await privatePost('/fapi/v1/order', {
            symbol:      STRATEGY.SYMBOL,
            side:        closeSide,
            type:        'LIMIT',
            timeInForce: 'GTC',
            price:       limitPrice.toFixed(_cfg.priceDp),
            quantity:    size.toFixed(_cfg.qtyDp),
            reduceOnly:  'true',
        });
        if (limitOrder?.orderId) {
            const start = Date.now();
            while (Date.now() - start < 5_000) {
                await new Promise(r => setTimeout(r, 500));
                const check = await privateGet('/fapi/v1/order', {
                    symbol: STRATEGY.SYMBOL, orderId: limitOrder.orderId,
                });
                if (check.status === 'FILLED') {
                    console.log(`[EMERGENCY] ✅ Limit close filled @ $${limitPrice.toFixed(_cfg.priceDp)}`);
                    clearActiveTrade();
                    return;
                }
            }
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: limitOrder.orderId }).catch(() => {});
        }
    } catch { /* fall through to market */ }

    // Market close as last resort
    try {
        await privatePost('/fapi/v1/order', {
            symbol:     STRATEGY.SYMBOL,
            side:       closeSide,
            type:       'MARKET',
            quantity:   size,
            reduceOnly: 'true',
        });
        console.log(`[EMERGENCY] ✅ Market close executed`);
        clearActiveTrade();
    } catch (e: any) {
        console.error(`[EMERGENCY] Close FAILED: ${e.message}`);
        await sendAlert(`🚨 EMERGENCY CLOSE FAILED ${STRATEGY.SYMBOL} ${size}. CHECK NOW. ${e.message}`);
    }
}

// ─── TP2 RESCUE LIMIT ─────────────────────────────────────────────────────────
export async function placeReduceOnlyLimit(side: string, price: number, quantity: number): Promise<number> {
    const res = await privatePost('/fapi/v1/order', {
        symbol:      STRATEGY.SYMBOL,
        side,
        type:        'LIMIT',
        timeInForce: 'GTC',
        price:       price.toFixed(_cfg.priceDp),
        quantity:    quantity.toFixed(_cfg.qtyDp),
        reduceOnly:  'true',
    });
    if (!res?.orderId) throw new Error(`TP2 rejected: ${JSON.stringify(res)}`);
    return res.orderId as number;
}

// ─── SIZING ───────────────────────────────────────────────────────────────────
function tickRound(price: number): number {
    const inv = 1 / _cfg.tick;
    return Math.round(price * inv) / inv;
}

function qtyFloor(qty: number): number {
    const steps = Math.floor(qty / _cfg.qtyStep);
    return Math.max(_cfg.minQty, steps * _cfg.qtyStep);
}

export function calcSize(price: number): number {
    const margin   = Number(process.env.MARGIN_PER_TRADE ?? STRATEGY.MARGIN_PER_TRADE);
    const leverage = STRATEGY.LEVERAGE;
    const notional = Math.min(margin * leverage, 5000);
    const raw      = notional / price;
    let   size     = qtyFloor(raw);
    while (size * price < STRATEGY.MIN_NOTIONAL) {
        size = Number((size + _cfg.qtyStep).toFixed(_cfg.qtyDp === 0 ? 0 : 3));
    }
    console.log(`[Size] ${STRATEGY.SYMBOL} | margin=$${Number(margin).toFixed(2)} ${leverage}x | notional=$${(size*price).toFixed(2)} | size=${size}`);
    return size;
}

// ─── TP AND SL CALCULATION ────────────────────────────────────────────────────
function calcTpDistance(price: number): number {
    if (_cfg.tpIsPct) return tickRound(price * _cfg.tpFixed);
    return _cfg.tpFixed;
}

function calcSlDistance(price: number): number {
    if (_cfg.slIsPct) return tickRound(price * _cfg.slFixed);
    return _cfg.slFixed;
}

// ─── MAIN EXECUTION ENGINE ────────────────────────────────────────────────────
// Order flow (all maker, no taker unless emergency):
//   1. GTX limit entry     → maker, cancels if it would be taker
//   2. GTC limit TP        → maker resting order
//   3. Algo Conditional Stop-Market SL → only mechanism Binance Futures allows
//                                          for stops outside the Algo API
//   Entry + TP + SL all placed within seconds of fill.
//   No position ever lives without both TP and SL.
export async function executeBinanceTrade(
    signal:          GeneratedSignal,
    _tradingBalance: number,
): Promise<TradeResult> {
    if (signal.direction === 'neutral') return { success: false, outcome: 'skipped' };

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'BUY'  : 'SELL';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const leverage  = STRATEGY.LEVERAGE;

    try {
        if (_activeTrade || await hasOpenPosition()) {
            return { success: false, outcome: 'skipped', message: 'Position already open.' };
        }

        const liveBid = signal.bid;
        const liveAsk = signal.ask;

        // Set leverage
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        // Entry price: 1 tick inside bid/ask, rounded to symbol tick
        const rawEntry   = isBuy
            ? liveBid - _cfg.entryOffset
            : liveAsk + _cfg.entryOffset;
        const entryPrice = tickRound(rawEntry);
        const size       = calcSize(entryPrice);

        console.log(`[Entry] 🟢 ${STRATEGY.SYMBOL} ${direction.toUpperCase()} | entry=$${entryPrice.toFixed(_cfg.priceDp)} size=${size} | bid=$${liveBid.toFixed(_cfg.priceDp)} ask=$${liveAsk.toFixed(_cfg.priceDp)}`);

        // ── 1. GTX maker entry ────────────────────────────────────────────────
        const entryOrder = await privatePost('/fapi/v1/order', {
            symbol:      STRATEGY.SYMBOL,
            side,
            type:        'LIMIT',
            timeInForce: 'GTX',   // Post-Only: cancels if would be taker
            price:       entryPrice.toFixed(_cfg.priceDp),
            quantity:    size.toFixed(_cfg.qtyDp),
        });

        if (!entryOrder?.orderId) {
            const msg = JSON.stringify(entryOrder);
            if (entryOrder?.code === -2019) return { success: false, outcome: 'skipped', message: `MARGIN_INSUFFICIENT: ${msg}` };
            if (entryOrder?.code === -5022) return { success: false, outcome: 'skipped', message: `GTX cancelled (would be taker)` };
            return { success: false, outcome: 'error', message: `Entry rejected: ${msg}` };
        }

        // Poll for fill (up to 60s)
        const fillStart   = Date.now();
        let   filled      = false;
        let   actualEntry = entryPrice;
        while (Date.now() - fillStart < STRATEGY.FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, 1_000));
            const check = await privateGet('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId,
            });
            if (check.status === 'FILLED') {
                filled      = true;
                actualEntry = Number(check.avgPrice ?? entryPrice);
                break;
            }
            if (check.status === 'CANCELED' || check.status === 'EXPIRED') break;
        }

        if (!filled) {
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }).catch(() => {});
            return { success: false, outcome: 'skipped', message: 'Entry not filled within timeout.' };
        }

        const fillMs = Date.now() - fillStart;

        // ── Calculate TP and SL prices ────────────────────────────────────────
        const tpDist  = calcTpDistance(actualEntry);
        const slDist  = calcSlDistance(actualEntry);
        const tpPrice = tickRound(isBuy ? actualEntry + tpDist : actualEntry - tpDist);
        const slPrice = tickRound(isBuy ? actualEntry - slDist : actualEntry + slDist);

        console.log(`[Filled] ✅ ${direction.toUpperCase()} @ $${actualEntry.toFixed(_cfg.priceDp)} | size=${size} | TP=$${tpPrice.toFixed(_cfg.priceDp)} (+$${tpDist.toFixed(_cfg.priceDp)}) | SL=$${slPrice.toFixed(_cfg.priceDp)} (-$${slDist.toFixed(_cfg.priceDp)}) | fillTime=${fillMs}ms`);

        // ── 2. TP limit order (maker, GTC) ───────────────────────────────────
        // MUST succeed — no TP = uncontrolled position
        let tpOrderId = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const tpRes = await privatePost('/fapi/v1/order', {
                    symbol:      STRATEGY.SYMBOL,
                    side:        closeSide,
                    type:        'LIMIT',
                    timeInForce: 'GTC',
                    price:       tpPrice.toFixed(_cfg.priceDp),
                    quantity:    size.toFixed(_cfg.qtyDp),
                    reduceOnly:  'true',
                });
                if (tpRes?.orderId) {
                    tpOrderId = tpRes.orderId;
                    console.log(`[TP] ✅ Limit @ $${tpPrice.toFixed(_cfg.priceDp)} | id=${tpOrderId}`);
                    break;
                }
                console.error(`[TP] ❌ Attempt ${attempt}: ${JSON.stringify(tpRes)}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1_000));
            } catch (e: any) {
                console.error(`[TP] ❌ Attempt ${attempt} threw: ${e.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1_000));
            }
        }

        if (!tpOrderId) {
            console.error(`[TP] ❌ ALL ATTEMPTS FAILED — emergency closing`);
            await sendAlert(`🚨 ${STRATEGY.SYMBOL} TP failed 3x — emergency closing!`);
            await triggerEmergencyClose(direction, size, 'TP placement total failure');
            return { success: false, outcome: 'error', message: 'TP failed, emergency closed.' };
        }

        // ── 3. SL — Algo Conditional Stop-Market ──────────────────────────────
        // Binance Futures rejects STOP/STOP_LIMIT on /fapi/v1/order (-4120).
        // The only working stop-loss mechanism is the Algo Order endpoint.
        // This still triggers as a stop, but executes as taker on fire — that's
        // the cost of having a guaranteed-fill SL. Acceptable: SL firing rarely,
        // and a missed SL is far worse than a small taker fee.
        let slOrderId = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const slAlgo = await privatePost('/fapi/v1/algoOrder', {
                    symbol:       STRATEGY.SYMBOL,
                    side:         closeSide,
                    algoType:     'CONDITIONAL',
                    type:         'STOP_MARKET',
                    quantity:     size.toFixed(_cfg.qtyDp),
                    triggerPrice: slPrice.toFixed(_cfg.priceDp),
                    workingType:  'MARK_PRICE',
                    reduceOnly:   'true',
                });
                if (slAlgo?.algoId) {
                    slOrderId = slAlgo.algoId;
                    console.log(`[SL] ✅ Algo Stop-Market @ $${slPrice.toFixed(_cfg.priceDp)} | algoId=${slOrderId}`);
                    break;
                }
                console.error(`[SL] ❌ Algo attempt ${attempt}: ${JSON.stringify(slAlgo)}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1_000));
            } catch (e: any) {
                console.error(`[SL] ❌ Attempt ${attempt} threw: ${e.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1_000));
            }
        }

        if (!slOrderId) {
            // No SL at all — cancel TP and emergency close
            console.error(`[SL] ❌ ALL SL ATTEMPTS FAILED — cancelling TP and emergency closing`);
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: tpOrderId }).catch(() => {});
            await sendAlert(`🚨 ${STRATEGY.SYMBOL} SL failed — emergency closing!`);
            await triggerEmergencyClose(direction, size, 'SL placement total failure');
            return { success: false, outcome: 'error', message: 'SL failed, emergency closed.' };
        }

        // ── Lock active trade state ───────────────────────────────────────────
        _activeTrade = {
            entryPrice:  actualEntry,
            tpPrice,
            slPrice,
            side:        direction,
            size,
            margin:      Number(process.env.MARGIN_PER_TRADE ?? STRATEGY.MARGIN_PER_TRADE),
            posVal:      size * actualEntry,
            leverage,
            openedAt:    Date.now(),
            tpOrderId,
            slOrderId,
            tp2Phase:    false,
        };

        await sendAlert(
            `✅ ${STRATEGY.SYMBOL} ${direction.toUpperCase()} @ $${actualEntry.toFixed(_cfg.priceDp)}\n` +
            `TP: $${tpPrice.toFixed(_cfg.priceDp)} (+$${tpDist.toFixed(_cfg.priceDp)})\n` +
            `SL: $${slPrice.toFixed(_cfg.priceDp)} (-$${slDist.toFixed(_cfg.priceDp)})\n` +
            `Size: ${size} | Margin: $${Number(process.env.MARGIN_PER_TRADE ?? 1).toFixed(2)}`
        );

        return {
            success:     true,
            outcome:     'orders_placed',
            entryPrice:  actualEntry,
            tpPrice,
            slPrice,
            grossProfit: size * tpDist,
            fillTimeMs:  fillMs,
        };

    } catch (e: any) {
        console.error(`[Trade] Unhandled error: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
