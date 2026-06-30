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
// Only EXCHANGE constants live here (tick/step/precision/max leverage). The TP and
// SL distances are NOT hardcoded per asset — they are derived at runtime from the
// margin-ROI targets (TP_ROI_PCT / SL_ROI_PCT) so behaviour is identical across
// every symbol regardless of price scale.
//
//   TP price distance = entry * (TP_ROI_PCT/100) / leverage   (default +0.5% margin)
//   SL price distance = entry * (SL_ROI_PCT/100) / leverage   (default -2.0% margin)
//
// The only per-asset tuning kept here is expressed in TICKS (scale-free):
//   entryOffsetTicks : how far inside bid/ask the maker entry sits
//   slLimitTicks     : how far the stop-limit LIMIT price sits beyond the trigger
//   tp2OffsetTicks   : TP2 rescue offset from entry
//   tpMinTicks/slMinTicks : floor so an ROI-derived distance is never sub-tick
//
// SL is a true maker Stop-Limit (type=STOP) — never Stop-Market (taker).

interface SymbolConfig {
    tick:             number;   // minimum price increment
    qtyStep:          number;   // minimum quantity increment
    minQty:           number;   // minimum order quantity
    priceDp:          number;   // decimal places for price
    qtyDp:            number;   // decimal places for quantity
    maxLeverage:      number;   // exchange maximum leverage
    entryOffsetTicks: number;   // ticks inside bid/ask for the maker entry
    slLimitTicks:     number;   // ticks the stop-limit price sits beyond the trigger
    tp2OffsetTicks:   number;   // TP2 rescue offset from entry, in ticks
    tpMinTicks:       number;   // minimum TP distance in ticks (sub-tick floor)
    slMinTicks:       number;   // minimum SL distance in ticks (sub-tick floor)
}

function getConfig(symbol: string): SymbolConfig {
    const s = symbol.toUpperCase();
    if (s === 'ETHUSDT')  return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5,
    };
    if (s === 'BTCUSDT')  return {
        tick: 0.10, qtyStep: 0.001, minQty: 0.001, priceDp: 1, qtyDp: 3,
        maxLeverage: 100,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5,
    };
    if (s === 'DOGEUSDT') return {
        tick: 0.00001, qtyStep: 1, minQty: 1, priceDp: 5, qtyDp: 0,
        maxLeverage: 75,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5,
    };
    // Default: XAUUSDT
    return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5,
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

    // Margin-ROI targets (asset-agnostic). TP/SL price distances are derived from
    // these at runtime: priceDist = entry * (roiPct/100) / leverage.
    get TP_ROI_PCT() { return Number(process.env.TP_ROI_PCT ?? 0.5); },
    get SL_ROI_PCT() { return Number(process.env.SL_ROI_PCT ?? 2.0); },

    // Exit-lifecycle timeouts — env-tunable for HFT cadence.
    get TP1_TIMEOUT_MS()     { return Number(process.env.TP1_TIMEOUT_MS     ?? 90_000); },
    get TP2_TIMEOUT_MS()     { return Number(process.env.TP2_TIMEOUT_MS     ?? 30_000); },
    get SCRATCH_TIMEOUT_MS() { return Number(process.env.SCRATCH_TIMEOUT_MS ?? 130_000); },

    // Maker entry should fill fast or be abandoned (keeps REST polling cheap).
    get FILL_TIMEOUT() { return Number(process.env.FILL_TIMEOUT_MS ?? 6_000); },
    get FILL_POLL_MS() { return Number(process.env.FILL_POLL_MS    ?? 1_000); },
    MIN_NOTIONAL: 5.0,
};

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
let _entryInProgress = false;   // locks the async fill-poll window against re-entry
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }
export function isEntryInProgress(): boolean { return _entryInProgress; }

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

// ─── ORDER-RATE GUARD ─────────────────────────────────────────────────────────
// Binance Futures caps order ops at 300/10s (per account). We throttle every
// order placement/cancel through a token bucket sized well under that limit so a
// burst of HFT cycles can never trip -1015 (too many orders).
const ORDER_MAX_PER_10S = Number(process.env.ORDER_MAX_PER_10S ?? 100);
let   _orderTimestamps: number[] = [];

async function orderRateGuard(): Promise<void> {
    for (;;) {
        const now = Date.now();
        _orderTimestamps = _orderTimestamps.filter(t => now - t < 10_000);
        if (_orderTimestamps.length < ORDER_MAX_PER_10S) {
            _orderTimestamps.push(now);
            return;
        }
        const waitMs = 10_000 - (now - _orderTimestamps[0]) + 50;
        console.warn(`[RateGuard] ⏳ order cap reached (${ORDER_MAX_PER_10S}/10s) — waiting ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
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
    if (path.toLowerCase().includes('order')) await orderRateGuard();
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
    if (path.toLowerCase().includes('order')) await orderRateGuard();   // /order, /allOpenOrders, /algoOrder
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

export async function hasOpenOrders(): Promise<boolean> {
    try {
        const data = await privateGet('/fapi/v1/openOrders', { symbol: STRATEGY.SYMBOL });
        return Array.isArray(data) && data.length > 0;
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

// Cancels the resting TP (normal order) via /allOpenOrders AND the SL algo
// stop-limit via the Algo endpoint (allOpenOrders does NOT touch algo orders).
// slAlgoId is the algoId returned when the SL was placed.
export async function cancelAllOrders(slAlgoId?: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL });
        console.log(`[Cleanup] Open orders cancelled`);
    } catch (e: any) {
        console.error(`[Cleanup] Cancel failed: ${e.message}`);
    }
    if (slAlgoId && slAlgoId > 0) {
        try {
            await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: slAlgoId });
            console.log(`[Cleanup] SL algo ${slAlgoId} cancelled`);
        } catch (e: any) {
            console.error(`[Cleanup] Algo cancel failed: ${e.message}`);
        }
    }
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
// TP2 price = entry ± tp2OffsetTicks, tick-rounded (per-asset, scale-free).
export function getTp2Price(entryPrice: number, side: 'long' | 'short'): number {
    const offset = _cfg.tp2OffsetTicks * _cfg.tick;
    return tickRound(side === 'long' ? entryPrice + offset : entryPrice - offset);
}

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

// ─── TP AND SL CALCULATION (margin-ROI based) ─────────────────────────────────
// priceDist = entry * (roiPct/100) / leverage, floored to a minimum tick count so
// the distance is never sub-tick (would round to zero and reject the order).
function roiPriceDist(entry: number, roiPct: number, leverage: number): number {
    return entry * (roiPct / 100) / leverage;
}

function calcTpDistance(entry: number, leverage: number): number {
    const raw   = roiPriceDist(entry, STRATEGY.TP_ROI_PCT, leverage);
    const floor = _cfg.tpMinTicks * _cfg.tick;
    return tickRound(Math.max(raw, floor));
}

function calcSlDistance(entry: number, leverage: number): number {
    const raw   = roiPriceDist(entry, STRATEGY.SL_ROI_PCT, leverage);
    const floor = _cfg.slMinTicks * _cfg.tick;
    return tickRound(Math.max(raw, floor));
}

// ─── MAIN EXECUTION ENGINE ────────────────────────────────────────────────────
// Order flow (all maker, never taker except emergency close):
//   1. GTX limit entry        → maker, cancels if it would be taker
//   2. GTC limit TP            → maker resting order
//   3. Algo CONDITIONAL STOP   → maker stop-LIMIT; on trigger posts a limit (maker),
//                                limit sits a few ticks beyond the trigger so it fills
//   Entry + TP + SL all placed within seconds of fill.
//   No position ever lives without both TP and SL.
export async function executeBinanceTrade(
    signal:          GeneratedSignal,
    _tradingBalance: number,
): Promise<TradeResult> {
    if (signal.direction === 'neutral') return { success: false, outcome: 'skipped' };

    // ── Re-entry guard ────────────────────────────────────────────────────────
    // _entryInProgress closes the async fill-poll window; the exchange checks
    // (position + resting orders) close the cross-process gap. If flat but stale
    // orders linger, clear them before opening anything new.
    if (_entryInProgress || _activeTrade) {
        return { success: false, outcome: 'skipped', message: 'Position already open.' };
    }
    if (await hasOpenPosition()) {
        return { success: false, outcome: 'skipped', message: 'Position already open.' };
    }
    if (await hasOpenOrders()) {
        console.warn(`[Entry] Stale resting orders with no position — cancelling before entry`);
        await cancelAllOrders();
        return { success: false, outcome: 'skipped', message: 'Cleared stale orders; retry next cycle.' };
    }

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'BUY'  : 'SELL';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const leverage  = STRATEGY.LEVERAGE;

    _entryInProgress = true;
    try {
        const liveBid = signal.bid;
        const liveAsk = signal.ask;

        // Set leverage
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        // Entry price: entryOffsetTicks inside bid/ask, rounded to symbol tick
        const entryOffset = _cfg.entryOffsetTicks * _cfg.tick;
        const rawEntry   = isBuy
            ? liveBid - entryOffset
            : liveAsk + entryOffset;
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

        // Poll for fill (bounded by FILL_TIMEOUT — short, to keep REST cheap)
        const fillStart   = Date.now();
        let   filled      = false;
        let   actualEntry = entryPrice;
        while (Date.now() - fillStart < STRATEGY.FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, STRATEGY.FILL_POLL_MS));
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
            // The order may have filled right at the buzzer. Re-query authoritatively
            // BEFORE giving up — otherwise we'd cancel a filled order and leave a
            // naked position with no TP/SL.
            const finalCheck = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }).catch(() => null);
            if (finalCheck?.status === 'FILLED') {
                filled = true; actualEntry = Number(finalCheck.avgPrice ?? entryPrice);
            } else {
                await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }).catch(() => {});
                // The cancel itself can race a fill — verify once more after cancelling.
                const postCancel = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }).catch(() => null);
                if (postCancel?.status === 'FILLED') {
                    filled = true; actualEntry = Number(postCancel.avgPrice ?? entryPrice);
                } else {
                    return { success: false, outcome: 'skipped', message: 'Entry not filled within timeout.' };
                }
            }
        }

        const fillMs = Date.now() - fillStart;

        // ── Calculate TP and SL prices (margin-ROI based) ─────────────────────
        const tpDist  = calcTpDistance(actualEntry, leverage);
        const slDist  = calcSlDistance(actualEntry, leverage);
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

        // ── 3. SL — maker Stop-Limit via Algo Conditional ─────────────────────
        // Binance rejects STOP on /fapi/v1/order (-4120: "use the Algo Order API").
        // So we place a CONDITIONAL algo order with orderType=STOP — a true
        // stop-LIMIT: on trigger it posts a LIMIT (maker), not a market (taker).
        // The limit price sits slLimitTicks beyond the trigger in the adverse
        // direction so it still fills as price continues through, while never
        // crossing the book as a taker on placement. slOrderId is an algoId.
        const slLimitOffset = _cfg.slLimitTicks * _cfg.tick;
        const slLimitPrice  = tickRound(isBuy ? slPrice - slLimitOffset : slPrice + slLimitOffset);
        let slOrderId = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const slRes = await privatePost('/fapi/v1/algoOrder', {
                    symbol:       STRATEGY.SYMBOL,
                    side:         closeSide,
                    algoType:     'CONDITIONAL',
                    type:         'STOP',           // stop-LIMIT (maker), not STOP_MARKET
                    timeInForce:  'GTC',
                    quantity:     size.toFixed(_cfg.qtyDp),
                    price:        slLimitPrice.toFixed(_cfg.priceDp),
                    triggerPrice: slPrice.toFixed(_cfg.priceDp),
                    workingType:  'MARK_PRICE',
                    reduceOnly:   'true',
                });
                if (slRes?.algoId) {
                    slOrderId = slRes.algoId;
                    console.log(`[SL] ✅ Algo Stop-Limit trigger=$${slPrice.toFixed(_cfg.priceDp)} limit=$${slLimitPrice.toFixed(_cfg.priceDp)} | algoId=${slOrderId}`);
                    break;
                }
                console.error(`[SL] ❌ Attempt ${attempt}: ${JSON.stringify(slRes)}`);
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
    } finally {
        _entryInProgress = false;
    }
}
