import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
const STRATEGY = {
    SYMBOL:     MARKET_SYMBOL,

    // Entry: 1 tick inside bid/ask — posts as maker, fills on next micro-oscillation.
    ENTRY_TICK: 0.05,

    // TP: dynamic — clamp(atr5m * TP_ATR_MULT, TP_MIN, TP_MAX)
    TP_ATR_MULT:  0.10,
    TP_MIN:       0.05,   // floor: never less than $0.05
    TP_MAX:       1.00,   // ceiling: never more than $1.00

    // SL: dynamic — clamp(atr5m * ATR_SL_MULT, SL_MIN, no ceiling)
    ATR_SL_MULT:      1.50,
    SL_MIN:           0.50,  // never closer than $0.50
    SL_BACKUP_EXTRA:  1.20,  // backup stop $1.20 past primary

    // ── Two-stage exit ────────────────────────────────────────────────────────
    // Phase 1 — TP1: full target resting limit, lives for TP1_TIMEOUT_MS (90s).
    // Phase 2 — TP2: if TP1 times out, cancel it and place a rescue limit at
    //           entry ± TP2_OFFSET ($0.10). Maker order, near-breakeven capture.
    //           Lives for TP2_TIMEOUT_MS (30s).
    // Phase 3 — Scratch: if TP2 also times out, market exit. Fee ~$0.008 at
    //           current sizes. Hard cap: 120s total trade lifetime.
    TP1_TIMEOUT_MS:   90_000,
    TP2_OFFSET:       0.10,
    TP2_TIMEOUT_MS:   30_000,
    SCRATCH_TIMEOUT_MS: 130_000,  // hard backstop — 90 + 30 + 10s buffer

    GOLD_TICK:    0.01,
    MIN_QTY:      0.001,
    QTY_STEP:     0.001,
    MIN_NOTIONAL: 5.0,

    LEVERAGE:      Number(process.env.BOT_LEVERAGE ?? 100),
    MAKER_FEE:     Number(process.env.MAKER_FEE_PCT ?? 0.0),
    TAKER_FEE:     0.0002,
    FILL_TIMEOUT:  60_000,
    MAX_SIGNAL_DRIFT: 2.00,
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
    netProfit?:   number;
    fees?:        number;
    message?:     string;
    fillTimeMs?:  number;
}

export interface ActiveTrade {
    entryPrice:    number;
    tpPrice:       number;
    slPrice:       number;
    slBackupPrice: number;
    side:          'long' | 'short';
    size:          number;
    margin:        number;
    posVal:        number;
    leverage:      number;
    openedAt:      number;
    tpOrderId?:    number;
    slAlgoId?:     number;
    slBackupId?:   number;
    // Two-stage exit tracking
    tp2Phase:      boolean;    // true once we switched to TP2 rescue limit
    tp2StartedAt?: number;     // when TP2 was placed
    tp2OrderId?:   number;     // order id of the rescue limit
    tp2Price?:     number;     // price of the rescue limit
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

// ─── ALERTING ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   ?? '';

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
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
const API_KEY     = IS_TESTNET ? (process.env.BINANCE_BOT_API    ?? '') : (process.env.BINANCE_API_KEY    ?? '');
const API_SECRET  = IS_TESTNET ? (process.env.BINANCE_BOT_SECRET ?? '') : (process.env.BINANCE_API_SECRET ?? '');

function signedUrl(path: string, params: Record<string, string | number> = {}): string {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const query   = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(query).digest('hex');
    return `${BASE_URL}${path}?${query}&signature=${sig}`;
}

async function privateGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), {
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

async function privatePost(path: string, params: Record<string, string | number> = {}): Promise<any> {
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
        const data = await privateGet('/fapi/v1/userTrades', {
            symbol:    STRATEGY.SYMBOL,
            startTime: sinceMs,
            limit:     50,
        });
        if (!Array.isArray(data) || !data.length) return null;
        const pnl = data.reduce((s: number, t: any) => s + Number(t.realizedPnl ?? 0), 0);
        return { pnl, trades: data.length };
    } catch (e: any) {
        console.error(`[PnL] Verification failed: ${e.message}`);
        return null;
    }
}

export async function cancelAllOrders(slAlgoId?: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL });
        console.log('[Cleanup] Regular orders cancelled.');
    } catch (e: any) {
        console.error(`[Cleanup] Regular order cancel failed: ${e.message}`);
    }
    if (slAlgoId && slAlgoId > 0) {
        try {
            await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: slAlgoId });
            console.log(`[Cleanup] Algo SL cancelled: id=${slAlgoId}`);
        } catch (e: any) {
            console.error(`[Cleanup] Algo SL cancel failed (id=${slAlgoId}): ${e.message}`);
        }
    }
    try {
        const openAlgos = await privateGet('/fapi/v1/algoOrders/openOrders', { symbol: STRATEGY.SYMBOL });
        if (Array.isArray(openAlgos?.orders)) {
            for (const o of openAlgos.orders) {
                try {
                    await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: o.algoId });
                    console.log(`[Cleanup] Orphan algo order cancelled: id=${o.algoId}`);
                } catch { /* no-op */ }
            }
        }
    } catch { /* non-critical */ }
}

export async function cancelAlgoOrder(algoId: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId });
    } catch { /* no-op if already gone */ }
}

export async function triggerEmergencyClose(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[EMERGENCY] 🛑 Market ${closeSide} ${size} XAU | ${reason}`);
    await cancelAllOrders();
    try {
        await privatePost('/fapi/v1/order', {
            symbol:     STRATEGY.SYMBOL,
            side:       closeSide,
            type:       'MARKET',
            quantity:   size,
            reduceOnly: 'true',
        });
        clearActiveTrade();
    } catch (e: any) {
        console.error(`[EMERGENCY] Close FAILED: ${e.message}`);
        await sendAlert(`🚨 EMERGENCY CLOSE FAILED on ${STRATEGY.SYMBOL} ${size} XAU. CHECK NOW. ${e.message}`);
    }
}

// ─── TP2 RESCUE LIMIT ─────────────────────────────────────────────────────────
// Called by checkPositionHealth() in main.ts when TP1 times out.
// Resting GTC limit, reduceOnly. Returns orderId.
export async function placeReduceOnlyLimit(
    side:     string,
    price:    number,
    quantity: number,
): Promise<number> {
    const res = await privatePost('/fapi/v1/order', {
        symbol:      STRATEGY.SYMBOL,
        side,
        type:        'LIMIT',
        timeInForce: 'GTC',
        price:       price.toFixed(2),
        quantity:    quantity.toFixed(3),
        reduceOnly:  'true',
    });
    if (!res?.orderId) throw new Error(`TP2 order rejected: ${JSON.stringify(res)}`);
    return res.orderId as number;
}

// ─── SIZING + PRICING ─────────────────────────────────────────────────────────
function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

function qtyFloor(qty: number): number {
    const steps = Math.floor(qty / STRATEGY.QTY_STEP);
    return Math.max(STRATEGY.MIN_QTY, steps * STRATEGY.QTY_STEP);
}

export function calcSize(tradingBalance: number, price: number): number {
    const notional = tradingBalance * STRATEGY.LEVERAGE;
    const raw      = notional / price;
    let   size     = qtyFloor(raw);
    while (size * price < STRATEGY.MIN_NOTIONAL) {
        size = Math.round((size + STRATEGY.QTY_STEP) * 1000) / 1000;
    }
    return size;
}

function calcSlDistance(atr5m: number): number {
    return Math.max(STRATEGY.SL_MIN, atr5m * STRATEGY.ATR_SL_MULT);
}

function calcTpMove(atr5m: number): number {
    return Math.min(STRATEGY.TP_MAX, Math.max(STRATEGY.TP_MIN, atr5m * STRATEGY.TP_ATR_MULT));
}

// ─── MAIN EXECUTION ENGINE ────────────────────────────────────────────────────
export async function executeBinanceTrade(
    signal:         GeneratedSignal,
    tradingBalance: number,
): Promise<TradeResult> {
    if (signal.direction === 'neutral') return { success: false, outcome: 'skipped' };

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'BUY'  : 'SELL';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const leverage  = STRATEGY.LEVERAGE;

    try {
        // Double-entry protection
        if (_activeTrade || await hasOpenPosition()) {
            return { success: false, outcome: 'skipped', message: 'Position already open.' };
        }

        const livePrice = signal.market_price;
        const liveBid   = signal.bid;
        const liveAsk   = signal.ask;

        if (Math.abs(livePrice - signal.market_price) > STRATEGY.MAX_SIGNAL_DRIFT) {
            return { success: false, outcome: 'skipped', message: 'Price drifted since signal.' };
        }

        if (tradingBalance <= 0) {
            return { success: false, outcome: 'skipped', message: 'Trading balance is zero.' };
        }

        // Set leverage
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        const tpMove     = calcTpMove(signal.atr5m);
        const entryPrice = tickRound(
            isBuy ? liveBid - STRATEGY.ENTRY_TICK : liveAsk + STRATEGY.ENTRY_TICK
        );
        console.log(`[Entry] bid=$${liveBid.toFixed(2)} ask=$${liveAsk.toFixed(2)} entry=$${entryPrice.toFixed(2)} TP=$${tpMove.toFixed(2)} ATR=$${signal.atr5m.toFixed(2)}`);

        const size   = calcSize(tradingBalance, entryPrice);
        const margin = tradingBalance;

        // 1. GTX maker entry order
        const entryOrder = await privatePost('/fapi/v1/order', {
            symbol:      STRATEGY.SYMBOL,
            side,
            type:        'LIMIT',
            timeInForce: 'GTX',
            price:       entryPrice.toFixed(2),
            quantity:    size.toFixed(3),
        });

        if (!entryOrder?.orderId) {
            return { success: false, outcome: 'error', message: `GTX order rejected: ${JSON.stringify(entryOrder)}` };
        }

        // 2. Poll for fill
        const fillStart = Date.now();
        let   filled    = false;
        let   actualEntry = entryPrice;
        while (Date.now() - fillStart < STRATEGY.FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, 1_000));
            const check = await privateGet('/fapi/v1/order', {
                symbol:  STRATEGY.SYMBOL,
                orderId: entryOrder.orderId,
            });
            if (check.status === 'FILLED') {
                filled      = true;
                actualEntry = Number(check.avgPrice ?? entryPrice);
                break;
            }
            if (check.status === 'CANCELED' || check.status === 'EXPIRED') break;
        }

        if (!filled) {
            await privateDelete('/fapi/v1/order', {
                symbol:  STRATEGY.SYMBOL,
                orderId: entryOrder.orderId,
            }).catch(() => {});
            return { success: false, outcome: 'skipped', message: 'Entry GTX not filled — skipping cycle.' };
        }

        // 3. Compute TP / SL prices
        const tpPrice       = tickRound(isBuy ? actualEntry + tpMove : actualEntry - tpMove);
        const slDistance    = calcSlDistance(signal.atr5m);
        const slPrice       = tickRound(isBuy ? actualEntry - slDistance           : actualEntry + slDistance);
        const slBackupPrice = tickRound(isBuy ? slPrice     - STRATEGY.SL_BACKUP_EXTRA : slPrice + STRATEGY.SL_BACKUP_EXTRA);

        console.log(`[Execution] ✅ ${direction.toUpperCase()} filled @ $${actualEntry.toFixed(2)} | Size: ${size} XAU`);
        console.log(`[Execution] 🎯 TP: $${tpPrice.toFixed(2)} | 🛑 SL: $${slPrice.toFixed(2)} | Backup: $${slBackupPrice.toFixed(2)}`);

        // 4. TP1 resting limit
        let tpOrderId = 0;
        try {
            const tpOrder = await privatePost('/fapi/v1/order', {
                symbol:      STRATEGY.SYMBOL,
                side:        closeSide,
                type:        'LIMIT',
                timeInForce: 'GTC',
                price:       tpPrice.toFixed(2),
                quantity:    size.toFixed(3),
                reduceOnly:  'true',
            });
            tpOrderId = tpOrder.orderId ?? 0;
        } catch (e: any) {
            console.error(`[TP] TP order failed: ${e.message}`);
        }

        // 5. Primary SL — algo conditional stop on mark price
        let slAlgoId = 0;
        try {
            const slOrder = await privatePost('/fapi/v1/algoOrder', {
                symbol:       STRATEGY.SYMBOL,
                side:         closeSide,
                algoType:     'CONDITIONAL',
                type:         'STOP_MARKET',
                quantity:     size.toFixed(3),
                triggerPrice: slPrice.toFixed(2),
                workingType:  'MARK_PRICE',
                reduceOnly:   'true',
            });
            slAlgoId = slOrder.algoId ?? 0;
            console.log(`[SL] Primary SL: algo id=${slAlgoId}`);
        } catch (e: any) {
            console.error(`[SL] Primary SL failed: ${e.message}`);
        }

        // 6. Backup SL — regular stop market past primary
        let slBackupId = 0;
        try {
            const backupOrder = await privatePost('/fapi/v1/order', {
                symbol:      STRATEGY.SYMBOL,
                side:        closeSide,
                type:        'STOP_MARKET',
                stopPrice:   slBackupPrice.toFixed(2),
                quantity:    size.toFixed(3),
                workingType: 'MARK_PRICE',
                reduceOnly:  'true',
            });
            slBackupId = backupOrder.orderId ?? 0;
            console.log(`[SL] Backup SL: order id=${slBackupId}`);
        } catch (e: any) {
            console.error(`[SL] Backup SL failed: ${e.message}`);
        }

        if (!slAlgoId && !slBackupId) {
            console.error('[SL] Both SL orders failed — emergency closing immediately.');
            await sendAlert(`🚨 Both SL orders failed on ${STRATEGY.SYMBOL} ${direction}. Emergency closing.`);
            await triggerEmergencyClose(direction, size, 'SL placement total failure');
            return { success: false, outcome: 'error', message: 'SL placement failed, emergency closed.' };
        }

        // Lock active trade state
        _activeTrade = {
            entryPrice:    actualEntry,
            tpPrice,
            slPrice,
            slBackupPrice,
            side:          direction,
            size,
            margin,
            posVal:        size * actualEntry,
            leverage,
            openedAt:      Date.now(),
            tpOrderId,
            slAlgoId,
            slBackupId,
            tp2Phase:      false,
        };

        const grossEstimate = size * tpMove;
        return {
            success:     true,
            outcome:     'orders_placed',
            entryPrice:  actualEntry,
            tpPrice,
            slPrice,
            grossProfit: grossEstimate,
            netProfit:   grossEstimate,
            fees:        0,
            fillTimeMs:  Date.now() - fillStart,
        };

    } catch (e: any) {
        return { success: false, outcome: 'error', message: e.message };
    }
}
