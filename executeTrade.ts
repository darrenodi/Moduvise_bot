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
// Exchange constants + the per-asset FIXED-dollar TP/SL distances.
// Gold runs a SYMMETRIC bracket (TP == SL in $ terms):
//   long  entry E → TP = E + tpFixedUsd, SL = E − slFixedUsd
//   short entry E → TP = E − tpFixedUsd, SL = E + slFixedUsd
// Override per run with env TP_FIXED_USD / SL_FIXED_USD.
//
// Per-asset tick-based tuning:
//   entryOffsetTicks : how far inside bid/ask the maker entry sits
//   slLimitTicks     : how far the stop-limit LIMIT price sits beyond the trigger
//   tp2OffsetTicks   : TP2 rescue offset from entry
//   tpMinTicks/slMinTicks : floor so a distance is never sub-tick
//
// TP is a maker post-only limit (0 fee). SL is an Algo CONDITIONAL STOP_MARKET —
// guaranteed fill, taker (~0.04%) only when it fires. Symmetric TP/SL means the
// fee is the only thing pushing breakeven win rate above 50%.

interface SymbolConfig {
    tick:             number;   // minimum price increment
    qtyStep:          number;   // minimum quantity increment
    minQty:           number;   // minimum order quantity
    priceDp:          number;   // decimal places for price
    qtyDp:            number;   // decimal places for quantity
    maxLeverage:      number;   // exchange maximum leverage
    tpFixedUsd:       number;   // fixed TP distance in USD
    slFixedUsd:       number;   // fixed SL distance in USD
    entryOffsetTicks: number;   // ticks inside bid/ask for the maker entry
    slLimitTicks:     number;   // ticks the stop-limit price sits beyond the trigger
    tp2OffsetTicks:   number;   // TP2 rescue offset from entry, in ticks
    tpMinTicks:       number;   // minimum TP distance in ticks (sub-tick floor)
    slMinTicks:       number;   // minimum SL distance in ticks (sub-tick floor)
    maxSpreadUsd:     number;   // skip entry if bid/ask spread exceeds this (price units)
    lossCooldownMs:   number;   // pause after a loss before next entry (per-asset, NOT env)
    maxHoldMs:        number;   // time-stop: scratch if TP unfilled after this (per-asset, NOT env)
}

function getConfig(symbol: string): SymbolConfig {
    const s = symbol.toUpperCase();
    if (s === 'ETHUSDT')  return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 0.50, slFixedUsd: 5.00,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.05,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    if (s === 'BTCUSDT')  return {
        tick: 0.10, qtyStep: 0.001, minQty: 0.001, priceDp: 1, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 5.00, slFixedUsd: 50.00,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 1.00,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    if (s === 'DOGEUSDT') return {
        tick: 0.00001, qtyStep: 1, minQty: 1, priceDp: 5, qtyDp: 0,
        maxLeverage: 75, tpFixedUsd: 0.0001, slFixedUsd: 0.0020,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.0002,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    // USDC-margined perps — 0% maker, so profitable to scalp like XAU.
    if (s === 'ETHUSDC')  return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 0.10, slFixedUsd: 2.00,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.05,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    if (s === 'BTCUSDC')  return {
        tick: 0.10, qtyStep: 0.001, minQty: 0.001, priceDp: 1, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 1.00, slFixedUsd: 20.00,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 1.00,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    // Default: XAUUSDT — TP $10.00 / SL $10.00 (symmetric bracket, ~53.8% breakeven)
    return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 10.00, slFixedUsd: 10.00,
        entryOffsetTicks: 7, slLimitTicks: 5, tp2OffsetTicks: 3,   // 7 ticks = $0.07 pullback
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.10,
        // maxHoldMs is a hygiene backstop only now — the symmetric $10/$10 bracket
        // already bounds risk cleanly, so this doesn't need to fire often or fast
        // (a tight timer here just reintroduces the timer-selection-bias problem:
        // conditioning on "still open" selects for trades drifting away from TP).
        lossCooldownMs: 30_000, maxHoldMs: 25 * 60_000,
    };
}

const _cfg = getConfig(MARKET_SYMBOL);

// Per-asset trading timing for the current symbol — imported by main.ts (no env).
export const ASSET_TIMING = {
    lossCooldownMs: _cfg.lossCooldownMs,
    maxHoldMs:      _cfg.maxHoldMs,
};

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
const STRATEGY = {
    SYMBOL:          MARKET_SYMBOL,
    MARGIN_PER_TRADE: Number(process.env.MARGIN_PER_TRADE ?? 1),

    get LEVERAGE() {
        const raw = Number(process.env.BOT_LEVERAGE ?? (IS_DEMO ? 10 : 100));
        const cap = _cfg.maxLeverage;
        return IS_DEMO ? Math.min(raw, 10) : Math.min(raw, cap);
    },

    // TP and SL are SYMMETRIC fixed-dollar price moves. Breakeven win rate for a
    // symmetric bracket is just above 50% (maker TP = 0 fee, taker SL = ~0.04% fee
    // on exit notional) — leverage-INVARIANT, since both sides scale by the same
    // position size. This replaces the earlier asymmetric TP$1.50/SL-50%-margin
    // design, which needed ~96% WR and pushed losses into a biased time-stop.
    get TP_FIXED_USD() { return Number(process.env.TP_FIXED_USD ?? _cfg.tpFixedUsd); },
    get SL_FIXED_USD() { return Number(process.env.SL_FIXED_USD ?? _cfg.slFixedUsd); },

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

// ─── SWEEP BANKED PROFIT: FUTURES → SPOT ──────────────────────────────────────
// Physically moves banked USDT out of the Futures wallet to Spot, so it's fully
// out of reach of any futures liquidation. Only called once the banked pile is
// worth moving (threshold gated in main.ts). Needs the API key to permit
// Universal Transfer; fails gracefully (isolated margin still protects otherwise).
export async function transferBankedToSpot(amount: number, asset = 'USDT'): Promise<boolean> {
    if (IS_DEMO) { console.log('[Bank] transfer skipped (demo/testnet)'); return false; }
    if (!(amount > 0)) return false;
    try {
        const ts     = Date.now();
        const params = { type: 'UMFUTURE_MAIN', asset, amount: amount.toFixed(4), timestamp: ts, recvWindow: 10000 };
        const raw    = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
        const sig    = createHmac('sha256', API_SECRET).update(raw).digest('hex');
        const res = await fetch(`https://api.binance.com/sapi/v1/asset/transfer`, {
            method:  'POST',
            headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    raw + `&signature=${sig}`,
            signal:  AbortSignal.timeout(10_000),
        });
        const j: any = await res.json();
        if (j?.tranId) { console.log(`[Bank] ✅ Swept $${amount.toFixed(4)} ${asset} Futures→Spot (tranId ${j.tranId})`); return true; }
        console.error(`[Bank] Transfer failed: ${JSON.stringify(j)}`);
        return false;
    } catch (e: any) {
        console.error(`[Bank] Transfer error: ${e.message}`);
        return false;
    }
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

// Safety close: try a maker limit at the touch first (free); if it doesn't fill in
// 5s, MARKET close (taker) to guarantee flat. Used to recover orphans and to flatten
// when the SL couldn't be placed — a guaranteed close beats carrying unbounded risk.
export async function triggerEmergencyClose(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[CLOSE] 🛑 ${closeSide} ${size} ${STRATEGY.SYMBOL} | ${reason}`);
    await cancelAllOrders();

    // 1) maker attempt (no fee)
    try {
        const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${STRATEGY.SYMBOL}`)
            .then(r => r.json()) as any;
        const limitPrice = closeSide === 'SELL' ? Number(ticker.askPrice) : Number(ticker.bidPrice);
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
            // Give the maker close time to fill (0 fee) before any taker fallback.
            const makerWaitMs = Number(process.env.EMERGENCY_MAKER_WAIT_MS ?? 12_000);
            const start = Date.now();
            while (Date.now() - start < makerWaitMs) {
                await new Promise(r => setTimeout(r, 500));
                const check = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: limitOrder.orderId });
                if (check.status === 'FILLED') {
                    console.log(`[CLOSE] ✅ Maker close filled @ $${limitPrice.toFixed(_cfg.priceDp)}`);
                    clearActiveTrade();
                    return;
                }
            }
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: limitOrder.orderId }).catch(() => {});
        }
    } catch { /* fall through to market */ }

    // 2) market close (taker) — guarantee flat
    try {
        await privatePost('/fapi/v1/order', {
            symbol: STRATEGY.SYMBOL, side: closeSide, type: 'MARKET',
            quantity: size.toFixed(_cfg.qtyDp), reduceOnly: 'true',
        });
        console.log(`[CLOSE] ✅ Market close executed (taker)`);
        clearActiveTrade();
    } catch (e: any) {
        console.error(`[CLOSE] Close FAILED: ${e.message}`);
        await sendAlert(`🚨 ${STRATEGY.SYMBOL} CLOSE FAILED ${size} — CHECK NOW. ${e.message}`);
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

// ─── TP / SL CALCULATION (symmetric fixed-dollar bracket) ─────────────────────
function calcTpDistance(): number {
    const floor = _cfg.tpMinTicks * _cfg.tick;
    return tickRound(Math.max(STRATEGY.TP_FIXED_USD, floor));
}

function calcSlDistance(): number {
    const floor = _cfg.slMinTicks * _cfg.tick;
    return tickRound(Math.max(STRATEGY.SL_FIXED_USD, floor));
}

// ─── MAIN EXECUTION ENGINE ────────────────────────────────────────────────────
// Order flow:
//   1. GTX limit entry           → maker, pullback; cancels if it would be taker
//   2. GTX limit TP              → post-only maker (0 fee)
//   3. Algo CONDITIONAL STOP_MARKET → guaranteed-fill stop; taker (~0.04%) only when
//                                     it fires, to CAP the loss (vs riding to liquidation)
//   Entry + TP + SL all placed within seconds of fill; no position lives without both.
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

        // Spread gate — a wide spread relative to a tiny TP means thin/risky book.
        const spread = liveAsk - liveBid;
        if (!IS_DEMO && spread > _cfg.maxSpreadUsd) {
            return { success: false, outcome: 'skipped', message: `Spread $${spread.toFixed(3)} > $${_cfg.maxSpreadUsd} cap` };
        }

        // Isolated margin so a liquidation can only ever take THIS position's margin
        // (the trading stack) — never the banked profit sitting in the wallet. This
        // is what makes "banked money is protected" actually true (cross margin uses
        // the whole wallet, incl. banked, as collateral). Set only while flat.
        try {
            await privatePost('/fapi/v1/marginType', { symbol: STRATEGY.SYMBOL, marginType: process.env.MARGIN_TYPE ?? 'ISOLATED' });
        } catch { /* -4046: already set */ }

        // Set leverage
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        // PULLBACK entry — wait for a small retracement against the pre-entry move,
        // then enter in the signal's direction: buy on a DIP (below bid), sell on a
        // BOUNCE (above ask). We fill at a better price, positioned for the move
        // toward TP instead of chasing. Maker via GTX (cancels if it would cross).
        const pull = Number(process.env.ENTRY_PULLBACK_TICKS ?? _cfg.entryOffsetTicks) * _cfg.tick;
        const rawEntry   = isBuy
            ? liveBid - pull   // buy the dip
            : liveAsk + pull;  // sell the bounce
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

        // ── Calculate TP (maker) and SL (stop-market, caps the loss) prices ──────
        const tpDist  = calcTpDistance();
        const slDist  = calcSlDistance();
        let   tpPrice = tickRound(isBuy ? actualEntry + tpDist : actualEntry - tpDist);
        const slPrice = tickRound(isBuy ? actualEntry - slDist : actualEntry + slDist);

        console.log(`[Filled] ✅ ${direction.toUpperCase()} @ $${actualEntry.toFixed(_cfg.priceDp)} | size=${size} | TP=$${tpPrice.toFixed(_cfg.priceDp)} (+$${tpDist.toFixed(_cfg.priceDp)}) | SL=$${slPrice.toFixed(_cfg.priceDp)} (-$${slDist.toFixed(_cfg.priceDp)}) | fillTime=${fillMs}ms`);

        // ── 2. TP limit order — POST-ONLY (GTX), never taker ─────────────────
        // MUST succeed — no TP = uncontrolled position. If price has already run
        // past the TP, GTX would cross (-5022); we then re-anchor to the current
        // touch (join the ask/bid) so it still rests as MAKER instead of crossing.
        let tpOrderId = 0;
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                const tpRes = await privatePost('/fapi/v1/order', {
                    symbol:      STRATEGY.SYMBOL,
                    side:        closeSide,
                    type:        'LIMIT',
                    timeInForce: 'GTX',   // post-only: cancels if it would be taker
                    price:       tpPrice.toFixed(_cfg.priceDp),
                    quantity:    size.toFixed(_cfg.qtyDp),
                    reduceOnly:  'true',
                });
                if (tpRes?.orderId) {
                    tpOrderId = tpRes.orderId;
                    console.log(`[TP] ✅ Post-only @ $${tpPrice.toFixed(_cfg.priceDp)} | id=${tpOrderId}`);
                    break;
                }
                // -5022: post-only would cross (price already past TP). Re-anchor to
                // the maker touch so we still rest as maker (join ask for a sell).
                if (tpRes?.code === -5022) {
                    const bt = await fetch(`${BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
                    tpPrice = tickRound(isBuy ? Number(bt.askPrice) : Number(bt.bidPrice));
                    console.warn(`[TP] ⚠️ price ran past TP — re-anchoring post-only to touch $${tpPrice.toFixed(_cfg.priceDp)}`);
                    continue;
                }
                console.error(`[TP] ❌ Attempt ${attempt}: ${JSON.stringify(tpRes)}`);
                if (attempt < 4) await new Promise(r => setTimeout(r, 800));
            } catch (e: any) {
                console.error(`[TP] ❌ Attempt ${attempt} threw: ${e.message}`);
                if (attempt < 4) await new Promise(r => setTimeout(r, 800));
            }
        }

        if (!tpOrderId) {
            console.error(`[TP] ❌ ALL ATTEMPTS FAILED — emergency closing`);
            await sendAlert(`🚨 ${STRATEGY.SYMBOL} TP failed 3x — emergency closing!`);
            await triggerEmergencyClose(direction, size, 'TP placement total failure');
            return { success: false, outcome: 'error', message: 'TP failed, emergency closed.' };
        }

        // ── 3. SL — Algo CONDITIONAL STOP_MARKET (caps the loss) ──────────────
        // Guaranteed-fill stop: on trigger it market-closes (taker ~0.04%). That
        // tiny taker cost is the price of bounding the loss to ~slDist instead of
        // riding to a 100%-of-margin liquidation. Placed via the Algo endpoint
        // (plain STOP on /fapi/v1/order is rejected -4120). slOrderId is an algoId.
        let slOrderId = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const slRes = await privatePost('/fapi/v1/algoOrder', {
                    symbol:       STRATEGY.SYMBOL,
                    side:         closeSide,
                    algoType:     'CONDITIONAL',
                    type:         'STOP_MARKET',
                    quantity:     size.toFixed(_cfg.qtyDp),
                    triggerPrice: slPrice.toFixed(_cfg.priceDp),
                    workingType:  'MARK_PRICE',
                    reduceOnly:   'true',
                });
                if (slRes?.algoId) {
                    slOrderId = slRes.algoId;
                    console.log(`[SL] ✅ Stop-Market trigger=$${slPrice.toFixed(_cfg.priceDp)} | algoId=${slOrderId}`);
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
            // Can't protect the position — cancel TP and flatten (taker) rather than
            // carry unbounded risk. Bounded loss is the whole point now.
            console.error(`[SL] ❌ ALL ATTEMPTS FAILED — cancelling TP and closing`);
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: tpOrderId }).catch(() => {});
            await sendAlert(`🚨 ${STRATEGY.SYMBOL} SL failed — closing to avoid unbounded risk!`);
            await triggerEmergencyClose(direction, size, 'SL placement total failure');
            return { success: false, outcome: 'error', message: 'SL failed, closed.' };
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
            `TP: $${tpPrice.toFixed(_cfg.priceDp)} (+$${tpDist.toFixed(_cfg.priceDp)}) | SL: $${slPrice.toFixed(_cfg.priceDp)} (-$${slDist.toFixed(_cfg.priceDp)})\n` +
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
