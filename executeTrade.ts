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
// User spec 2026-07-09: TAKER market entry (immediate fill in signal direction —
// no passive-limit adverse selection), maker post-only TP at a fixed $4 move
// (TP_MIN_USD), Algo STOP_MARKET SL at a fixed $10 move (SL_FIXED_USD). The
// 90min time-stop remains behind both as hygiene. See calcTpDistance /
// calcSlDistance for the disclosed breakeven math.
//   long  entry E → TP = E + tpDist, SL = E − slDist
//   short entry E → TP = E − tpDist, SL = E + slDist
// Override per run with env TP_MIN_USD / SL_FIXED_USD.
//
// Per-asset tick-based tuning:
//   entryOffsetTicks : unused now (taker entry has no pullback); kept for reference
//   slLimitTicks     : unused now (SL is stop-MARKET, no limit leg)
//   tp2OffsetTicks   : TP2 rescue offset from entry
//   tpMinTicks/slMinTicks : floor so a distance is never sub-tick

interface SymbolConfig {
    tick:             number;   // minimum price increment
    qtyStep:          number;   // minimum quantity increment
    minQty:           number;   // minimum order quantity
    priceDp:          number;   // decimal places for price
    qtyDp:            number;   // decimal places for quantity
    maxLeverage:      number;   // exchange maximum leverage
    tpFixedUsd:       number;   // fixed TP distance in USD (the "win" unit)
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
        maxLeverage: 100, tpFixedUsd: 0.50,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.05,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    if (s === 'BTCUSDT')  return {
        tick: 0.10, qtyStep: 0.001, minQty: 0.001, priceDp: 1, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 5.00,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 1.00,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    if (s === 'DOGEUSDT') return {
        tick: 0.00001, qtyStep: 1, minQty: 1, priceDp: 5, qtyDp: 0,
        maxLeverage: 75, tpFixedUsd: 0.0001,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.0002,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    // USDC-margined perps — 0% maker, so profitable to scalp like XAU.
    if (s === 'ETHUSDC')  return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 0.10,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.05,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    if (s === 'BTCUSDC')  return {
        tick: 0.10, qtyStep: 0.001, minQty: 0.001, priceDp: 1, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 1.00,
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 1.00,
        lossCooldownMs: 30_000, maxHoldMs: 8 * 60_000,
    };
    // Default: XAUUSDT — TAKER entry, TP fixed $4 maker, SL fixed $10 stop-market
    return {
        tick: 0.01, qtyStep: 0.001, minQty: 0.001, priceDp: 2, qtyDp: 3,
        maxLeverage: 100, tpFixedUsd: 10.00,
        // 1 tick = $0.01 pullback. A wider pullback (was 7 ticks = $0.07) sat too
        // far below the touch in a trending market — the entry kept timing out
        // unfilled while price ran away, retrying every cycle with zero fills.
        entryOffsetTicks: 1, slLimitTicks: 5, tp2OffsetTicks: 3,
        tpMinTicks: 2, slMinTicks: 5, maxSpreadUsd: 0.10,
        // maxHoldMs is a hygiene backstop only — the SL already bounds risk exactly
        // to 2x TP incl. fee, so this must NOT be the primary exit. Live evidence
        // it was too tight: with TP/SL both fee-floored at ~$1.67 (quiet market),
        // 4/4 trades timed out at 25min in a choppy/rangebound stretch and got
        // force-closed as MARKET (taker) — paying a fee they shouldn't AND
        // bypassing the exact loss-cap (a time-stop exit realizes whatever price
        // the market is at, not the designed 2x-TP formula). Lengthened so the
        // free maker TP/SL get real room to resolve naturally first; a tight timer
        // also reintroduces timer-selection-bias (conditioning on "still open"
        // selects for trades drifting away from TP).
        lossCooldownMs: 30_000, maxHoldMs: 90 * 60_000,
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

    // TP is a fixed $0.50 price move; SL is a fixed 70%-of-margin ROI stop, set
    // independently (user decision, 2026-07-06, with 100x leverage). Loss-per-win
    // ratio is large and floating by design here — the user explicitly traded
    // "capped loss ratio" for "simple, predictable, wide-enough-to-avoid-noise SL".
    get TP_FIXED_USD()       { return Number(process.env.TP_FIXED_USD ?? _cfg.tpFixedUsd); },

    // Fill-poll interval used by the chase-to-fill entry loop below.
    get FILL_POLL_MS() { return Number(process.env.FILL_POLL_MS ?? 1_000); },
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

// ─── LIVE TAKER FEE RATE ──────────────────────────────────────────────────────
// The SL-sizing formula needs the REAL taker rate to hold its "at most N wins"
// cap exactly. Fetched once from the account's actual commission schedule (fee
// promos can change), then cached. Falls back to a configured default if the
// call fails, so a transient API error can't block trading.
const TAKER_FEE_FALLBACK = Number(process.env.TAKER_FEE_FALLBACK ?? 0.0004);
let _takerFeeRate: number | null = null;

export async function getTakerFeeRate(): Promise<number> {
    if (_takerFeeRate !== null) return _takerFeeRate;
    try {
        const res = await privateGet('/fapi/v1/commissionRate', { symbol: STRATEGY.SYMBOL });
        const rate = Number(res?.takerCommissionRate);
        if (Number.isFinite(rate) && rate >= 0) {
            _takerFeeRate = rate;
            console.log(`[Fee] ${STRATEGY.SYMBOL} taker=${(rate * 100).toFixed(4)}% maker=${(Number(res?.makerCommissionRate ?? 0) * 100).toFixed(4)}% (live from exchange)`);
            return rate;
        }
    } catch (e: any) {
        console.error(`[Fee] commissionRate fetch failed: ${e.message}`);
    }
    console.warn(`[Fee] Using fallback taker rate ${(TAKER_FEE_FALLBACK * 100).toFixed(4)}% — could not verify live rate`);
    _takerFeeRate = TAKER_FEE_FALLBACK;
    return _takerFeeRate;
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

// Adopt an orphaned position (exists at the exchange, no in-memory trade — e.g.
// after a restart or state wipe) as the active trade, so the normal exit machinery
// applies to it: TP fill detection, the 90min time-stop, PnL logging and bankroll
// update. Without adoption, the orphan-net "let it ride" path had NO time-stop
// (that requires a trade object), so a single underwater orphan could block all
// new entries indefinitely while carrying unbounded no-SL risk — observed live
// 2026-07-09: the pre-reset short rode 7h+ frozen, $16 underwater, bot dark.
// openedAt uses the position's updateTime when available so an already-old orphan
// time-stops immediately instead of getting a fresh 90 minutes.
export async function adoptOrphanPosition(pos: { side: 'long' | 'short'; size: number; entryPrice: number }): Promise<boolean> {
    if (_activeTrade) return false;
    try {
        const [orders, positions] = await Promise.all([
            privateGet('/fapi/v1/openOrders', { symbol: STRATEGY.SYMBOL }),
            privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL }),
        ]);
        const tp = Array.isArray(orders)
            ? orders.find((o: any) => o.type === 'LIMIT' && (o.reduceOnly === true || o.reduceOnly === 'true'))
            : null;
        if (!tp) return false;   // naked orphans stay with the emergency-close path
        const raw = Array.isArray(positions) ? positions.find((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0) : null;
        const openedAt = Number(raw?.updateTime) > 0 ? Number(raw.updateTime) : Date.now();
        _activeTrade = {
            entryPrice: pos.entryPrice,
            tpPrice:    Number(tp.price),
            slPrice:    0,
            side:       pos.side,
            size:       pos.size,
            margin:     Number(process.env.MARGIN_PER_TRADE ?? STRATEGY.MARGIN_PER_TRADE),
            posVal:     pos.size * pos.entryPrice,
            leverage:   STRATEGY.LEVERAGE,
            openedAt,
            tpOrderId:  Number(tp.orderId) || undefined,
            slOrderId:  undefined,
            tp2Phase:   false,
        };
        console.log(`[Adopt] 🤝 Orphan ${pos.side} ${pos.size} @ $${pos.entryPrice.toFixed(_cfg.priceDp)} adopted | TP=$${Number(tp.price).toFixed(_cfg.priceDp)} | age=${((Date.now() - openedAt) / 60_000).toFixed(0)}min — time-stop now applies`);
        return true;
    } catch (e: any) {
        console.error(`[Adopt] Failed: ${e.message}`);
        return false;
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
        // realizedPnl on userTrades EXCLUDES commission (it's a separate field per
        // fill). With maker-everything that was fine (0 fee); with taker entries
        // every trade pays ~0.04% that was silently missing from logged PnL — the
        // bot credited wins ~40% larger than the wallet actually received, and the
        // bankroll compounded numbers that didn't exist (found 2026-07-07: log said
        // +$0.083 while the wallet dropped $0.12 over the same 19 trades).
        const netPnl = (rows: any[]) => rows.reduce((s: number, t: any) =>
            s + Number(t.realizedPnl ?? 0) - (t.commissionAsset === 'USDT' ? Number(t.commission ?? 0) : 0), 0);
        if (!Array.isArray(data) || !data.length) {
            // Retry with broader window for clock skew
            const data2 = await privateGet('/fapi/v1/userTrades', {
                symbol:    STRATEGY.SYMBOL,
                startTime: sinceMs - 10_000,
                limit:     50,
            });
            if (!Array.isArray(data2) || !data2.length) return null;
            const pnl2 = netPnl(data2);
            console.log(`[PnL] ${data2.length} trades (broad) | PnL net of fees: $${pnl2.toFixed(6)}`);
            return { pnl: pnl2, trades: data2.length };
        }
        const pnl = netPnl(data);
        console.log(`[PnL] ${data.length} trades | PnL net of fees: $${pnl.toFixed(6)}`);
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

// ─── TP / SL CALCULATION ─────────────────────────────────────────────────────
// User spec 2026-07-09: "predict $3 to $5 price moves, enter with taker and tp
// as maker. sl at $10 price move." TP fixed $4 (env TP_MIN_USD), SL fixed $10
// (env SL_FIXED_USD) — the SL is BACK after 3 days of no-SL, bounding a loss at
// ~$13.30/unit incl. fees vs the unbounded rides that previously ate the account.
// Disclosed math at these settings: win nets ~+$2.35/unit after the taker entry
// fee, stop-out costs ~−$13.30/unit → one loss ≈ 5.7 wins, breakeven WR ≈ 85%.
// User was shown this and chose the wide-stop shape deliberately (noise room).
function calcTpDistance(_atr5m: number): number {
    const fixedUsd = Number(process.env.TP_MIN_USD ?? 4.00);
    const floor    = Math.max(fixedUsd, _cfg.tpMinTicks * _cfg.tick);
    return tickRound(floor);
}

// SL is either a fixed $ move (SL_FIXED_USD) or a % of margin (SL_ROI_PCT), the
// latter added for the 2026-07-12 dual-bot spec ("stop losses should be -15%").
// SL_ROI_PCT wins when set, since it's leverage-aware:
//   slDist = entry × (roiPct/100) / leverage
// At 50x, -15% of margin = a ~$1.24 price move on gold — see the MAE warning in
// multiSymbol.ts: that distance sits INSIDE gold's normal noise (median adverse
// excursion $2.97), so it stops out ~73% of trades. Kept because the user chose
// it with the data in hand; the structural fix would be lower leverage.
export function calcSlDistance(entry: number): number {
    const floor  = _cfg.slMinTicks * _cfg.tick;
    const roiPct = Number(process.env.SL_ROI_PCT || 0);
    if (roiPct > 0) {
        const raw = entry * (roiPct / 100) / STRATEGY.LEVERAGE;
        return tickRound(Math.max(raw, floor));
    }
    // `|| 10` (not `??`) so an empty-string override falls back instead of Number('')===0.
    const fixedUsd = Number(process.env.SL_FIXED_USD || 10.00);
    return tickRound(Math.max(fixedUsd, floor));
}

/** True when entries are taker MARKET orders; false = maker GTX chase-to-fill. */
export const isEntryTaker = (): boolean => (process.env.ENTRY_TAKER ?? 'true') === 'true';

// ─── MAIN EXECUTION ENGINE ────────────────────────────────────────────────────
// Order flow (user spec, 2026-07-09):
//   1. MARKET entry   → TAKER, fills instantly in the signal's direction (no chase,
//                       no adverse-selection: a passive limit gets filled exactly
//                       when the market moves against it — user called this out)
//   2. GTX limit TP   → post-only maker (0 fee), fixed $4 price move
//   3. Algo STOP_MARKET SL → $10 price move; taker fee only when it fires. Caps a
//                       loss at ~32% of margin at 100x instead of liquidation.
//   Time-stop (90min) remains as the hygiene backstop behind both.
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
        //
        // BUG FIXED 2026-07-06: privatePost never throws on a Binance error response
        // (fetch doesn't throw on 4xx/5xx, and res.json() parses fine either way) — so
        // this try/catch was structurally incapable of ever catching a real rejection.
        // Live audit found the account sitting on CROSS margin (not isolated) with an
        // open, unprotected position, because a -4047 ("cannot change margin type with
        // open orders") was being silently discarded exactly like the harmless -4046
        // ("already isolated") case. With no SL now in place, an un-isolated position
        // exposes the WHOLE wallet to liquidation, not just this trade's margin — this
        // must be loud, not swallowed.
        const marginRes = await privatePost('/fapi/v1/marginType', { symbol: STRATEGY.SYMBOL, marginType: process.env.MARGIN_TYPE ?? 'ISOLATED' });
        if (marginRes?.code && marginRes.code !== -4046) {
            console.error(`[Margin] ⚠️ Failed to set ISOLATED margin: ${JSON.stringify(marginRes)} — position will be CROSS (whole wallet at risk)`);
            await sendAlert(`⚠️ ${STRATEGY.SYMBOL} could not set ISOLATED margin (${marginRes.msg}) — this trade will be on CROSS margin, exposing the full wallet.`);
        }

        // Set leverage
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        // ── ENTRY: taker MARKET or maker chase-to-fill (env ENTRY_TAKER) ─────────
        // ENTRY_TAKER=true  → MARKET order: instant fill, ~0.04% fee every trade.
        // ENTRY_TAKER=false → GTX post-only, re-quoted at the live touch for a
        //   bounded budget: 0 fee, but it only fills when price comes TO us (the
        //   adverse-selection the user flagged), and it can miss entirely.
        // The 2026-07-12 dual-bot spec is maker on both bots.
        const ENTRY_TAKER = (process.env.ENTRY_TAKER ?? 'true') === 'true';
        const estPrice = isBuy ? liveAsk : liveBid;
        const size     = calcSize(estPrice);
        const fillStart = Date.now();
        let actualEntry = 0;

        if (ENTRY_TAKER) {
            console.log(`[Entry] 🟢 ${STRATEGY.SYMBOL} ${direction.toUpperCase()} (TAKER/MARKET) | size=${size} | bid=$${liveBid.toFixed(_cfg.priceDp)} ask=$${liveAsk.toFixed(_cfg.priceDp)}`);
            const order = await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL, side, type: 'MARKET', quantity: size.toFixed(_cfg.qtyDp),
            });
            if (!order?.orderId) {
                if (order?.code === -2019) {
                    return { success: false, outcome: 'skipped', message: `MARGIN_INSUFFICIENT: ${JSON.stringify(order)}` };
                }
                return { success: false, outcome: 'skipped', message: `TAKER entry rejected: ${JSON.stringify(order)}` };
            }
            actualEntry = Number(order.avgPrice) || 0;
            for (let i = 0; i < 5 && !actualEntry; i++) {
                await new Promise(r => setTimeout(r, 300));
                const check = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: order.orderId });
                if (check.status === 'FILLED') actualEntry = Number(check.avgPrice);
            }
            if (!actualEntry) {
                return { success: false, outcome: 'error', message: `Market entry placed (orderId=${order.orderId}) but avgPrice never resolved.` };
            }
        } else {
            // MAKER chase-to-fill: re-quote GTX at the live touch until filled or
            // the time budget runs out. Never crosses, so it's always maker (0 fee).
            console.log(`[Entry] 🟢 ${STRATEGY.SYMBOL} ${direction.toUpperCase()} (MAKER/GTX) | size=${size} | bid=$${liveBid.toFixed(_cfg.priceDp)} ask=$${liveAsk.toFixed(_cfg.priceDp)}`);

            const quoteAndWait = async (price: number): Promise<{ filled: boolean; avgPrice?: number; rejectedCode?: number }> => {
                const order = await privatePost('/fapi/v1/order', {
                    symbol: STRATEGY.SYMBOL, side, type: 'LIMIT', timeInForce: 'GTX',
                    price: price.toFixed(_cfg.priceDp), quantity: size.toFixed(_cfg.qtyDp),
                });
                if (!order?.orderId) return { filled: false, rejectedCode: order?.code };
                const waitMs = Number(process.env.ENTRY_CHASE_POLL_MS ?? 1_500);
                const start  = Date.now();
                while (Date.now() - start < waitMs) {
                    await new Promise(r => setTimeout(r, STRATEGY.FILL_POLL_MS));
                    const check = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: order.orderId });
                    if (check.status === 'FILLED') return { filled: true, avgPrice: Number(check.avgPrice ?? price) };
                    if (check.status === 'CANCELED' || check.status === 'EXPIRED') break;
                }
                // Fill-race-safe cancel: re-check before AND after cancelling.
                const pre = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: order.orderId }).catch(() => null);
                if (pre?.status === 'FILLED') return { filled: true, avgPrice: Number(pre.avgPrice ?? price) };
                await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: order.orderId }).catch(() => {});
                const post = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: order.orderId }).catch(() => null);
                if (post?.status === 'FILLED') return { filled: true, avgPrice: Number(post.avgPrice ?? price) };
                return { filled: false };
            };

            const chaseTotalMs = Number(process.env.ENTRY_CHASE_TOTAL_MS ?? 20_000);
            let requotes = 0;
            let result = await quoteAndWait(tickRound(isBuy ? liveBid : liveAsk));
            if (result.filled) actualEntry = result.avgPrice ?? 0;
            if (!actualEntry && result.rejectedCode === -2019) {
                return { success: false, outcome: 'skipped', message: `MARGIN_INSUFFICIENT: ${JSON.stringify(result)}` };
            }
            while (!actualEntry && Date.now() - fillStart < chaseTotalMs) {
                requotes++;
                const bt = await fetch(`${BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
                const touch = tickRound(isBuy ? Number(bt.bidPrice) : Number(bt.askPrice));
                result = await quoteAndWait(touch);
                if (result.filled) actualEntry = result.avgPrice ?? touch;
                if (!actualEntry && result.rejectedCode === -2019) {
                    return { success: false, outcome: 'skipped', message: `MARGIN_INSUFFICIENT: ${JSON.stringify(result)}` };
                }
            }
            if (!actualEntry) {
                return { success: false, outcome: 'skipped', message: `Maker entry not filled after ${requotes} requotes over ${((Date.now() - fillStart) / 1000).toFixed(0)}s.` };
            }
            if (requotes > 0) console.log(`[Entry] ✅ Maker filled after ${requotes} requote(s)`);
        }
        const fillMs = Date.now() - fillStart;

        // ── Calculate TP (maker) and SL (stop-market; fixed-$ or %-of-margin) ────
        const takerFeeRate = await getTakerFeeRate();
        const feePerUnit = takerFeeRate * actualEntry;
        const tpDist  = calcTpDistance(signal.atr5m);
        const slDist  = calcSlDistance(actualEntry);
        let   tpPrice = tickRound(isBuy ? actualEntry + tpDist : actualEntry - tpDist);
        const slPrice = tickRound(isBuy ? actualEntry - slDist : actualEntry + slDist);

        console.log(`[Filled] ✅ ${direction.toUpperCase()} @ $${actualEntry.toFixed(_cfg.priceDp)} | size=${size} | TP=$${tpPrice.toFixed(_cfg.priceDp)} (+$${tpDist.toFixed(_cfg.priceDp)}) | SL=$${slPrice.toFixed(_cfg.priceDp)} (-$${slDist.toFixed(_cfg.priceDp)}) | entry fee≈$${feePerUnit.toFixed(4)}/unit | fillTime=${fillMs}ms`);

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

        // ── 3. SL — Algo CONDITIONAL STOP_MARKET at $10 (caps the loss) ──────────
        // Guaranteed-fill stop; taker fee only when it fires. Placed via the Algo
        // endpoint (plain STOP on /fapi/v1/order is rejected -4120, see memory).
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
            // Can't protect the position — cancel TP and flatten rather than carry
            // an unbounded ride; the $10 cap is the point of this configuration.
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
            `✅ ${STRATEGY.SYMBOL} ${direction.toUpperCase()} @ $${actualEntry.toFixed(_cfg.priceDp)} (TAKER)\n` +
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
