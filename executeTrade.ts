import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── ENVIRONMENT TOGGLE ───────────────────────────────────────────────────────
// Single toggle: ENVIRONMENT=demo → demo account, 50x max, $50 margin per trade
//               ENVIRONMENT=live → live account, 100x, full balance sizing
// Everything else follows automatically — no other changes needed to go live.
export const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
export const IS_DEMO     = ENVIRONMENT !== 'live';

const BASE_URL   = IS_DEMO ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
const API_KEY    = IS_DEMO ? (process.env.BINANCE_BOT_API    ?? '') : (process.env.BINANCE_API_KEY    ?? '');
const API_SECRET = IS_DEMO ? (process.env.BINANCE_BOT_SECRET ?? '') : (process.env.BINANCE_API_SECRET ?? '');

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
// Demo constraints: max 50x leverage, max $5000 position notional.
// We use $50 margin × 50x = $2500 notional per trade — well within limits.
// At $4000/XAU that's 0.625 XAU per trade.
//
// Live: $50 margin × 100x = $5000 notional. Same margin amount, double leverage.
// Switching live→demo or back: change ENVIRONMENT only.
// ─── PER-SYMBOL PRECISION ─────────────────────────────────────────────────────
// Different symbols require different tick sizes and quantity precision.
// Injected by multiSymbol.ts via env; falls back to XAUUSDT defaults for
// single-symbol runs.
//
//  XAUUSDT : tick=0.01  qtyStep=0.001  minQty=0.001  slMin=0.50
//  ETHUSDT : tick=0.01  qtyStep=0.001  minQty=0.001  slMin=1.00
//  DOGEUSDT: tick=0.0001 qtyStep=1     minQty=1      slMin=0.002
function getSymbolPrecision(symbol: string): {
    tick: number; qtyStep: number; minQty: number; slMin: number;
    tp2Offset: number; slBackupExtra: number;
} {
    const s = symbol.toUpperCase();
    if (s === 'DOGEUSDT') return { tick: 0.00001, qtyStep: 1,     minQty: 1,     slMin: 0.002, tp2Offset: 0.0002, slBackupExtra: 0.001  };
    if (s === 'ETHUSDT')  return { tick: 0.01,    qtyStep: 0.001, minQty: 0.001, slMin: 1.00,  tp2Offset: 0.10,   slBackupExtra: 0.50   };
    // Default: XAUUSDT
    return                       { tick: 0.01,    qtyStep: 0.001, minQty: 0.001, slMin: 0.50,  tp2Offset: 0.10,   slBackupExtra: 1.20   };
}

const _precision = getSymbolPrecision(MARKET_SYMBOL);

const STRATEGY = {
    SYMBOL: MARKET_SYMBOL,

    // Margin per trade — overridden per-symbol by multiSymbol.ts via MARGIN_PER_TRADE env.
    // Single-symbol runs fall back to $50.
    MARGIN_PER_TRADE: Number(process.env.MARGIN_PER_TRADE ?? 50),

    // Leverage: 10x demo / 100x live
    get LEVERAGE() {
        const raw = Number(process.env.BOT_LEVERAGE ?? (IS_DEMO ? 10 : 100));
        return IS_DEMO ? Math.min(raw, 10) : raw;
    },

    ENTRY_TICK: Number(process.env.ENTRY_TICK ?? _precision.tick),

    // TP: dynamic — clamp(atr5m × TP_ATR_MULT, TP_MIN, TP_MAX)
    TP_ATR_MULT: Number(process.env.TP_ATR_MULT ?? 0.10),
    TP_MIN:      Number(process.env.TP_MIN      ?? _precision.tick * 5),
    TP_MAX:      Number(process.env.TP_MAX      ?? 1.00),

    ATR_SL_MULT:     Number(process.env.ATR_SL_MULT ?? 2.00),
    SL_MIN:          _precision.slMin,
    SL_BACKUP_EXTRA: _precision.slBackupExtra,

    TP1_TIMEOUT_MS:    90_000,
    TP2_OFFSET:        _precision.tp2Offset,
    TP2_TIMEOUT_MS:    30_000,
    SCRATCH_TIMEOUT_MS: 130_000,

    PRICE_TICK:   _precision.tick,
    MIN_QTY:      _precision.minQty,
    QTY_STEP:     _precision.qtyStep,
    MIN_NOTIONAL: 5.0,
    TAKER_FEE:    0.0002,
    FILL_TIMEOUT: 60_000,
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
    } catch (e: any) {
        console.error(`[Cleanup] Regular order cancel failed: ${e.message}`);
    }
    if (slAlgoId && slAlgoId > 0) {
        try {
            await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: slAlgoId });
        } catch { /* no-op */ }
    }
    try {
        const openAlgos = await privateGet('/fapi/v1/algoOrders/openOrders', { symbol: STRATEGY.SYMBOL });
        if (Array.isArray(openAlgos?.orders)) {
            for (const o of openAlgos.orders) {
                try {
                    await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: o.algoId });
                } catch { /* no-op */ }
            }
        }
    } catch { /* non-critical */ }
}

export async function cancelAlgoOrder(algoId: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId });
    } catch { /* no-op */ }
}

export async function triggerEmergencyClose(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[EMERGENCY] 🛑 Closing ${closeSide} ${size} ${STRATEGY.SYMBOL} | ${reason}`);
    await cancelAllOrders();

    // Attempt 1: tight limit order at current bid/ask — maker fee (free), no spread cost.
    // Give it 5 seconds. If it doesn't fill, fall back to market.
    try {
        const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${STRATEGY.SYMBOL}`)
            .then(r => r.json()) as any;
        const limitPrice = closeSide === 'SELL'
            ? Number(ticker.bidPrice)   // sell at best bid — fills immediately as taker but avoids wide spread
            : Number(ticker.askPrice);  // buy at best ask

        const limitOrder = await privatePost('/fapi/v1/order', {
            symbol:      STRATEGY.SYMBOL,
            side:        closeSide,
            type:        'LIMIT',
            timeInForce: 'GTC',
            price:       limitPrice.toFixed(2),
            quantity:    size.toFixed(3),
            reduceOnly:  'true',
        });

        if (limitOrder?.orderId) {
            // Poll 5s for fill
            const start = Date.now();
            while (Date.now() - start < 5_000) {
                await new Promise(r => setTimeout(r, 500));
                const check = await privateGet('/fapi/v1/order', {
                    symbol: STRATEGY.SYMBOL, orderId: limitOrder.orderId,
                });
                if (check.status === 'FILLED') {
                    console.log(`[EMERGENCY] ✅ Limit close filled @ $${limitPrice.toFixed(2)} (maker — no taker fee)`);
                    clearActiveTrade();
                    return;
                }
            }
            // Didn't fill in 5s — cancel and fall through to market
            await privateDelete('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL, orderId: limitOrder.orderId,
            }).catch(() => {});
            console.log(`[EMERGENCY] Limit close timed out — falling back to market order`);
        }
    } catch (e: any) {
        console.error(`[EMERGENCY] Limit close attempt failed: ${e.message} — falling back to market`);
    }

    // Attempt 2: market order — guaranteed fill, pays taker fee (~$1.00 at $5000 notional)
    try {
        await privatePost('/fapi/v1/order', {
            symbol:     STRATEGY.SYMBOL,
            side:       closeSide,
            type:       'MARKET',
            quantity:   size,
            reduceOnly: 'true',
        });
        console.log(`[EMERGENCY] ✅ Market close executed (taker fee applies)`);
        clearActiveTrade();
    } catch (e: any) {
        console.error(`[EMERGENCY] Market close FAILED: ${e.message}`);
        await sendAlert(`🚨 EMERGENCY CLOSE FAILED on ${STRATEGY.SYMBOL} ${size} XAU. CHECK NOW. ${e.message}`);
    }
}

// ─── TP2 RESCUE LIMIT ─────────────────────────────────────────────────────────
export async function placeReduceOnlyLimit(side: string, price: number, quantity: number): Promise<number> {
    const priceDp = STRATEGY.PRICE_TICK < 0.01 ? 5 : 2;
    const qtyDp   = STRATEGY.QTY_STEP   < 1    ? 3 : 0;
    const res = await privatePost('/fapi/v1/order', {
        symbol:      STRATEGY.SYMBOL,
        side,
        type:        'LIMIT',
        timeInForce: 'GTC',
        price:       price.toFixed(priceDp),
        quantity:    quantity.toFixed(qtyDp),
        reduceOnly:  'true',
    });
    if (!res?.orderId) throw new Error(`TP2 order rejected: ${JSON.stringify(res)}`);
    return res.orderId as number;
}

// ─── SIZING ───────────────────────────────────────────────────────────────────
// Fixed $50 margin per trade. Notional = $50 × leverage.
// Demo: $50 × 50 = $2500 notional. At $4000/XAU → 0.625 XAU.
// Live:  $50 × 100 = $5000 notional. At $4000/XAU → 1.25 XAU.
// Max position check: notional never exceeds $5000 (demo exchange limit).
function tickRound(price: number): number {
    const tick = STRATEGY.PRICE_TICK;
    return Math.round(price / tick) * tick;
}

function qtyFloor(qty: number): number {
    const steps = Math.floor(qty / STRATEGY.QTY_STEP);
    return Math.max(STRATEGY.MIN_QTY, steps * STRATEGY.QTY_STEP);
}

export function calcSize(price: number): number {
    const leverage  = STRATEGY.LEVERAGE;
    const margin    = STRATEGY.MARGIN_PER_TRADE;
    const notional  = margin * leverage;
    // Hard cap: demo exchange rejects large positions. At 10x, $50 margin = $500 notional.
    const cappedNotional = IS_DEMO ? Math.min(notional, 500) : notional;
    const raw  = cappedNotional / price;
    let   size = qtyFloor(raw);
    while (size * price < STRATEGY.MIN_NOTIONAL) {
        size = Math.round((size + STRATEGY.QTY_STEP) * 1000) / 1000;
    }
    console.log(`[Size] ${IS_DEMO ? 'DEMO' : 'LIVE'} | ${STRATEGY.SYMBOL} | margin=$${margin} leverage=${leverage}x notional=$${(size*price).toFixed(2)} size=${size}`);
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
    _tradingBalance: number,   // kept for API compatibility — sizing now uses fixed margin
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

        // Set leverage on exchange
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        const tpMove     = calcTpMove(signal.atr5m);
        const entryPrice = tickRound(
            isBuy ? liveBid - STRATEGY.ENTRY_TICK : liveAsk + STRATEGY.ENTRY_TICK
        );
        const size = calcSize(entryPrice);

        const priceDp = STRATEGY.PRICE_TICK < 0.01 ? 5 : 2;
        const qtyDp   = STRATEGY.QTY_STEP   < 1    ? 3 : 0;

        console.log(`[Entry] ${IS_DEMO ? '🟡 DEMO' : '🟢 LIVE'} | bid=$${liveBid.toFixed(priceDp)} ask=$${liveAsk.toFixed(priceDp)} entry=$${entryPrice.toFixed(priceDp)} TP=$${tpMove.toFixed(priceDp)} ATR=$${signal.atr5m.toFixed(priceDp)}`);

        // GTX maker entry
        const entryOrder = await privatePost('/fapi/v1/order', {
            symbol:      STRATEGY.SYMBOL,
            side,
            type:        'LIMIT',
            timeInForce: 'GTX',
            price:       entryPrice.toFixed(priceDp),
            quantity:    size.toFixed(qtyDp),
        });

        if (!entryOrder?.orderId) {
            const msg = JSON.stringify(entryOrder);
            if (entryOrder?.code === -2019) {
                // Margin insufficient — tell main.ts to pause this symbol
                return { success: false, outcome: 'skipped', message: `MARGIN_INSUFFICIENT: ${msg}` };
            }
            return { success: false, outcome: 'error', message: `GTX order rejected: ${msg}` };
        }

        // Poll for fill
        const fillStart  = Date.now();
        let   filled     = false;
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
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }).catch(() => {});
            return { success: false, outcome: 'skipped', message: 'Entry GTX not filled.' };
        }

        // TP / SL prices
        const tpPrice       = tickRound(isBuy ? actualEntry + tpMove : actualEntry - tpMove);
        const slDistance    = calcSlDistance(signal.atr5m);
        const slPrice       = tickRound(isBuy ? actualEntry - slDistance           : actualEntry + slDistance);
        const slBackupPrice = tickRound(isBuy ? slPrice     - STRATEGY.SL_BACKUP_EXTRA : slPrice + STRATEGY.SL_BACKUP_EXTRA);

        console.log(`[Execution] ✅ ${direction.toUpperCase()} filled @ $${actualEntry.toFixed(priceDp)} | ${size} ${STRATEGY.SYMBOL} | TP:$${tpPrice.toFixed(priceDp)} SL:$${slPrice.toFixed(priceDp)}`);

        // TP1 resting limit — MUST succeed. No TP = no exit = uncontrolled loss.
        let tpOrderId = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const tpOrder = await privatePost('/fapi/v1/order', {
                    symbol: STRATEGY.SYMBOL, side: closeSide, type: 'LIMIT',
                    timeInForce: 'GTC', price: tpPrice.toFixed(priceDp),
                    quantity: size.toFixed(qtyDp), reduceOnly: 'true',
                });
                if (tpOrder?.orderId) {
                    tpOrderId = tpOrder.orderId;
                    console.log(`[TP] ✅ Set @ $${tpPrice.toFixed(priceDp)} | orderId=${tpOrderId}`);
                    break;
                } else {
                    console.error(`[TP] ❌ Attempt ${attempt} rejected: ${JSON.stringify(tpOrder)}`);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e: any) {
                console.error(`[TP] ❌ Attempt ${attempt} threw: ${e.message}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
            }
        }
        if (!tpOrderId) {
            // TP failed 3 times — emergency close to prevent uncontrolled position
            console.error(`[TP] ❌ ALL ATTEMPTS FAILED — emergency closing position`);
            await sendAlert(`🚨 ${STRATEGY.SYMBOL} TP placement failed 3 times — emergency closing. Check position!`);
            await triggerEmergencyClose(direction, size, 'TP placement total failure');
            return { success: false, outcome: 'error', message: 'TP placement failed, emergency closed.' };
        }

        // Primary SL — algo conditional stop on mark price
        let slAlgoId = 0;
        try {
            const slOrder = await privatePost('/fapi/v1/algoOrder', {
                symbol: STRATEGY.SYMBOL, side: closeSide, algoType: 'CONDITIONAL',
                type: 'STOP_MARKET', quantity: size.toFixed(qtyDp),
                triggerPrice: slPrice.toFixed(priceDp), workingType: 'MARK_PRICE', reduceOnly: 'true',
            });
            if (slOrder?.algoId) {
                slAlgoId = slOrder.algoId;
                console.log(`[SL] ✅ Primary @ $${slPrice.toFixed(priceDp)} | algoId=${slAlgoId}`);
            } else {
                console.error(`[SL] ❌ Primary rejected: ${JSON.stringify(slOrder)}`);
            }
        } catch (e: any) { console.error(`[SL] Primary threw: ${e.message}`); }

        // Backup SL — regular stop market order
        let slBackupId = 0;
        try {
            const backupOrder = await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL, side: closeSide, type: 'STOP_MARKET',
                stopPrice: slBackupPrice.toFixed(priceDp), quantity: size.toFixed(qtyDp),
                workingType: 'MARK_PRICE', reduceOnly: 'true',
            });
            if (backupOrder?.orderId) {
                slBackupId = backupOrder.orderId;
                console.log(`[SL] ✅ Backup @ $${slBackupPrice.toFixed(priceDp)} | orderId=${slBackupId}`);
            } else {
                console.error(`[SL] ❌ Backup rejected: ${JSON.stringify(backupOrder)}`);
            }
        } catch (e: any) { console.error(`[SL] Backup threw: ${e.message}`); }

        if (!slAlgoId && !slBackupId) {
            await sendAlert(`🚨 Both SL orders failed. Emergency closing.`);
            await triggerEmergencyClose(direction, size, 'SL total failure');
            return { success: false, outcome: 'error', message: 'SL failed, emergency closed.' };
        }

        _activeTrade = {
            entryPrice:    actualEntry,
            tpPrice,
            slPrice,
            slBackupPrice,
            side:          direction,
            size,
            margin:        STRATEGY.MARGIN_PER_TRADE,
            posVal:        size * actualEntry,
            leverage,
            openedAt:      Date.now(),
            tpOrderId,
            slAlgoId,
            slBackupId,
            tp2Phase:      false,
        };

        return {
            success:     true,
            outcome:     'orders_placed',
            entryPrice:  actualEntry,
            tpPrice,
            slPrice,
            grossProfit: size * tpMove,
            netProfit:   size * tpMove,
            fees:        0,
            fillTimeMs:  Date.now() - fillStart,
        };

    } catch (e: any) {
        return { success: false, outcome: 'error', message: e.message };
    }
}
