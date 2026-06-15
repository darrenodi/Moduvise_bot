import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL, calcAtrRegime, safeLeverage } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
//
// XAUUSDT USDM Futures — noise scalping
//
// FEES (confirmed from live PNL records — 0% maker verified):
//   Maker: 0.0000%  entry GTX + TP GTX (resting ALO orders)
//   Taker: 0.0450%  SL market exit only
//
// TP:  $1.00  fixed
// SL:  $3.00  fixed  → breakeven win rate = 75%  (observed ~87%, margin = 12pp)
// ENTRY OFFSET: $0.20 from live price
//   - Far enough: never crosses the book → guaranteed GTX/maker
//   - Close enough: fills within ~60s on Gold's typical $3–5 per 5m ATR
//   - Smaller offset (e.g. $0.10) risks -5022 rejection in fast moves
//   - Larger offset (e.g. $0.30) costs 30% of TP before trade even starts
// SIZE: 100% of available balance every trade

const STRATEGY = {
    SYMBOL:              MARKET_SYMBOL,
    TAKER_FEE:           0.00045,
    MAKER_FEE:           0.0000,
    ENTRY_OFFSET:        0.20,          // $0.20 — safe GTX zone, fills fast on $3+ ATR
    ENTRY_FILL_TIMEOUT:  90_000,        // 90s — if price hasn't moved $0.20 toward us, signal stale
    TP_MOVE:             2.30,          // $1.00 TP
    SL_MOVE:             4.80,          // $3.00 SL → breakeven 75%
    MIN_BALANCE:         1.50,
    GOLD_TICK:           0.10,
    MAX_TRADING_BALANCE: 25_000,
    MAX_SIGNAL_DRIFT:    1.50,          // skip if price moved >$1.50 since signal generated
    LEVERAGE:            40,
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome = 'orders_placed' | 'tp_confirmed' | 'sl_triggered' | 'skipped' | 'error';

export interface TradeResult {
    success:      boolean;
    outcome:      TradeOutcome;
    entryPrice?:  number;
    tpPrice?:     number;
    slPrice?:     number;
    tpMove?:      number;
    slMove?:      number;
    leverage?:    number;
    sizePct?:     number;
    grossProfit?: number;
    netProfit?:   number;
    fees?:        number;
    message?:     string;
    fillTimeMs?:  number;
}

export interface ActiveTrade {
    entryPrice: number;
    tpPrice:    number;
    slPrice:    number;
    tpMove:     number;
    slMove:     number;
    side:       'long' | 'short';
    size:       number;
    posVal:     number;
    leverage:   number;
    openedAt:   number;
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

// ─── EXCHANGE ─────────────────────────────────────────────────────────────────

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const IS_DEMO     = ENVIRONMENT === 'demo';

const API_KEY = IS_DEMO
    ? (process.env.BINANCE_BOT_API ?? '')
    : ENVIRONMENT === 'testnet'
        ? (process.env.BINANCE_BOT_API ?? process.env.BINANCE_API_KEY ?? '')
        : (process.env.BINANCE_API_KEY ?? '');

const API_SECRET = IS_DEMO
    ? (process.env.BINANCE_BOT_SECRET ?? '')
    : ENVIRONMENT === 'testnet'
        ? (process.env.BINANCE_BOT_SECRET ?? process.env.BINANCE_API_SECRET ?? '')
        : (process.env.BINANCE_API_SECRET ?? '');

const BASE_URL = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

import { createHmac } from 'crypto';

function signedUrl(path: string, params: Record<string, string | number> = {}): string {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const query   = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(query).digest('hex');
    return `${BASE_URL}${path}?${query}&signature=${sig}`;
}

async function privateGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = signedUrl(path, params);
    const res = await fetch(url, { headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

async function privatePost(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const body    = Object.entries(entries).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sig     = createHmac('sha256', API_SECRET)
        .update(Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&'))
        .digest('hex');
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body + `&signature=${sig}`,
        signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
}

async function privateDelete(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = signedUrl(path, params);
    const res = await fetch(url, { method: 'DELETE', headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

console.log(`[Exchange] Mode: ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'}`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

export async function getAvailableBalance(): Promise<number> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const data = await privateGet('/fapi/v3/account');
            const bal  = Number(data?.availableBalance ?? data?.totalWalletBalance ?? 0);
            if (bal > 0) { console.log(`[Execute] Balance: $${bal.toFixed(4)}`); return bal; }
            console.warn(`[Execute] Balance=0 attempt ${attempt}/3`);
            await new Promise(r => setTimeout(r, 1500));
        } catch (e: any) {
            console.warn(`[Execute] Balance error ${attempt}/3: ${String(e.message).slice(0, 60)}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
        }
    }
    return 0;
}

export async function hasOpenPosition(): Promise<boolean> {
    try {
        const data = await privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL });
        return Array.isArray(data) && data.some((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0);
    } catch { return false; }
}

export async function getOpenPositionDetails(): Promise<{
    exists:        boolean;
    side:          'long' | 'short' | null;
    entryPrice:    number;
    size:          number;
    unrealisedPnl: number;
    currentPrice:  number;
}> {
    try {
        const [positions, priceData] = await Promise.all([
            privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL }),
            fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()).catch(() => ({ price: '0' })),
        ]);
        const pos = Array.isArray(positions)
            ? positions.find((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0) : null;
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };
        const posAmt = Number(pos.positionAmt ?? 0);
        return {
            exists:        true,
            side:          posAmt > 0 ? 'long' : 'short',
            entryPrice:    Number(pos.entryPrice ?? 0),
            size:          Math.abs(posAmt),
            unrealisedPnl: Number(pos.unRealizedProfit ?? 0),
            currentPrice:  Number((priceData as any).price ?? 0),
        };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };
    }
}

export async function triggerStopLoss(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[Execute] 🛑 SL (${reason}) — market ${closeSide} ${size}`);
    try { await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL }); } catch { /* ok */ }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL, side: closeSide, type: 'MARKET',
                quantity: size, reduceOnly: 'true',
            });
            console.log(`[Execute] ✅ SL submitted (attempt ${attempt})`);
            clearActiveTrade();
            return;
        } catch (e: any) {
            console.error(`[Execute] SL attempt ${attempt} failed: ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1_500));
        }
    }
    console.error(`[Execute] ⚠️ All SL attempts failed — check position manually!`);
}

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

// ─── SIZE: 100% of balance ─────────────────────────────────────────────────
// Uses full available balance every trade.
// No session percentage reduction — user requirement: always 100%.

export function calcSize(balance: number, price: number): number {
    const cappedBalance = Math.min(balance, STRATEGY.MAX_TRADING_BALANCE);
    const posVal        = cappedBalance * STRATEGY.LEVERAGE;
    const raw           = posVal / price;
    const floored       = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

// ─── MAIN EXECUTION ───────────────────────────────────────────────────────────

export async function executeBinanceTrade(
    signal:          GeneratedSignal,
    virtualBalance?: number,
): Promise<TradeResult> {

    if (signal.direction === 'neutral') {
        return { success: false, outcome: 'skipped', message: 'Neutral signal' };
    }

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'BUY'  : 'SELL';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const leverage  = signal.suggested_leverage ?? STRATEGY.LEVERAGE;

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] XAUUSDT ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] TP=+$${STRATEGY.TP_MOVE} | SL=-$${STRATEGY.SL_MOVE} | Lev=${leverage}x | 100% balance`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // 1. GUARD — no double positions
        if (_activeTrade || await hasOpenPosition()) {
            console.log(`[Execute] Position already open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // 2. BALANCE
        const effectiveBalance = virtualBalance && virtualBalance > 0
            ? virtualBalance : await getAvailableBalance();
        console.log(`[Execute] Balance: $${effectiveBalance.toFixed(4)}`);

        if (effectiveBalance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Balance too low: $${effectiveBalance.toFixed(4)}` };
        }

        // 3. LEVERAGE
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
            console.log(`[Execute] Leverage: ${leverage}x`);
        } catch (e: any) {
            console.log(`[Execute] Leverage note: ${String(e.message ?? '').slice(0, 60)}`);
        }

        // 4. STALE SIGNAL CHECK
        let livePrice = signal.market_price;
        try {
            const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
            livePrice = Number(ticker?.price ?? signal.market_price);
        } catch { /* use signal price */ }

        const drift = Math.abs(livePrice - signal.market_price);
        if (drift > STRATEGY.MAX_SIGNAL_DRIFT) {
            console.log(`[Execute] Stale signal — $${drift.toFixed(2)} drift. Skip.`);
            return { success: false, outcome: 'skipped', message: `Signal stale: $${drift.toFixed(2)} drift` };
        }

        // 5. SIZE — 100% of balance
        const size   = calcSize(effectiveBalance, livePrice);
        const posVal = size * livePrice;
        const margin = posVal / leverage;
        console.log(`[Execute] Size: ${size} XAU | Notional: $${posVal.toFixed(2)} | Margin: $${margin.toFixed(2)}`);

        // 6. GTX ENTRY — $0.20 offset from live price
        // This is the critical parameter. $0.20 on XAUUSDT:
        //   - Sits below current bid (long) or above current ask (short)
        //   - Never crosses → guaranteed GTX (post-only) acceptance
        //   - $3–5 ATR per 5m means price reaches $0.20 offset in ~20–60s
        const entryStart = Date.now();
        let entryOrder: any = null;
        let fillPrice  = 0;

        for (let attempt = 1; attempt <= 2; attempt++) {
            let attemptPrice = livePrice;
            if (attempt > 1) {
                try {
                    const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
                    attemptPrice = Number(ticker?.price ?? livePrice);
                    console.log(`[Execute] GTX retry — fresh price: $${attemptPrice.toFixed(2)}`);
                } catch { /* use livePrice */ }
                await new Promise(r => setTimeout(r, 1_000));
            }

            const entryPrice = tickRound(isBuy
                ? attemptPrice - STRATEGY.ENTRY_OFFSET
                : attemptPrice + STRATEGY.ENTRY_OFFSET);

            try {
                entryOrder = await privatePost('/fapi/v1/order', {
                    symbol:      STRATEGY.SYMBOL,
                    side,
                    type:        'LIMIT',
                    timeInForce: 'GTX',
                    price:       entryPrice.toFixed(2),
                    quantity:    size,
                });
                console.log(`[Execute] ⏳ GTX entry: ${size} XAU @ $${entryPrice.toFixed(2)} (id=${entryOrder.orderId})`);
                fillPrice = entryPrice;
                break;
            } catch (e: any) {
                const msg = String(e.message ?? '');
                if (msg.includes('-5022') && attempt < 2) {
                    console.log(`[Execute] -5022 would cross book — retrying with fresh price`);
                    continue;
                }
                console.error(`[Execute] Entry failed: ${e.message}`);
                return { success: false, outcome: 'error', message: `Entry failed: ${e.message}` };
            }
        }

        if (!entryOrder) {
            return { success: false, outcome: 'skipped', message: 'GTX rejected after retries' };
        }

        // 7. FILL POLL — 500ms intervals, 90s timeout
        let executedQty = Number(entryOrder.executedQty ?? 0);
        let avgPrice    = Number(entryOrder.avgPrice ?? 0);

        while (Date.now() - entryStart < STRATEGY.ENTRY_FILL_TIMEOUT && executedQty < size) {
            await new Promise(r => setTimeout(r, 500));
            const status = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId });
            executedQty  = Number(status.executedQty ?? executedQty);
            avgPrice     = Number(status.avgPrice ?? avgPrice);
            if (status.status === 'FILLED' || executedQty >= size) break;
        }

        if (executedQty <= 0) {
            try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ok */ }
            console.log(`[Execute] Not filled in 90s — skipping.`);
            return { success: false, outcome: 'skipped', message: 'Not filled in 90s' };
        }

        const filledSize = executedQty;
        fillPrice        = avgPrice > 0 ? avgPrice : fillPrice;
        const fillTimeMs = Date.now() - entryStart;

        if (filledSize < size) {
            console.log(`[Execute] Partial fill: ${filledSize.toFixed(2)}/${size.toFixed(2)} — cancelling rest`);
            try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ok */ }
        }

        console.log(`[Execute] ✅ Filled: ${filledSize.toFixed(2)} XAU @ $${fillPrice.toFixed(2)} in ${fillTimeMs}ms`);

        // 8. GTX TP — resting maker limit, $1.00 above/below fill
        const tpPrice    = tickRound(isBuy ? fillPrice + STRATEGY.TP_MOVE : fillPrice - STRATEGY.TP_MOVE);
        const slPrice    = tickRound(isBuy ? fillPrice - STRATEGY.SL_MOVE : fillPrice + STRATEGY.SL_MOVE);
        const gross      = filledSize * STRATEGY.TP_MOVE;
        const takerFeeOnSl = filledSize * fillPrice * STRATEGY.TAKER_FEE; // SL exit cost (worst case)
        const net        = gross; // entry and TP are 0% maker; taker fee only on SL

        console.log(`[Execute] TP=$${tpPrice.toFixed(2)} (+$${STRATEGY.TP_MOVE}) | SL=$${slPrice.toFixed(2)} (-$${STRATEGY.SL_MOVE})`);
        console.log(`[Execute] Gross=$${gross.toFixed(4)} | Net=$${net.toFixed(4)} (SL taker cost=$${takerFeeOnSl.toFixed(4)})`);

        try {
            const tpOrder = await privatePost('/fapi/v1/order', {
                symbol:      STRATEGY.SYMBOL,
                side:        closeSide,
                type:        'LIMIT',
                timeInForce: 'GTX',
                price:       tpPrice.toFixed(2),
                quantity:    filledSize,
                reduceOnly:  'true',
            });
            console.log(`[Execute] ✅ TP placed: id=${tpOrder.orderId}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message} — SL monitor will protect.`);
        }
        // 👇 THE UPDATED SL BLOCK 👇
        try {
            const slOrder = await privatePost('/fapi/v1/algoOrder', {
                algoType:      'CONDITIONAL',
                symbol:        STRATEGY.SYMBOL,
                side:          closeSide,
                type:          'STOP_MARKET',
                triggerPrice:  slPrice.toFixed(2),
                closePosition: 'true'
            });
            // Note: The Algo endpoint returns 'algoId' instead of 'orderId'
            console.log(`[Execute] ✅ SL placed: algoId=${slOrder.algoId}`);
        } catch (e: any) {
            console.error(`[Execute] SL failed: ${e.message} — SL monitor will protect.`);
        }
        // 👆 -------------------- 👆

        _activeTrade = {
            entryPrice: fillPrice, tpPrice, slPrice,
            tpMove: STRATEGY.TP_MOVE, slMove: STRATEGY.SL_MOVE,
            side: direction, size: filledSize, posVal: filledSize * fillPrice,
            leverage, openedAt: Date.now(),
        };

        console.log(`[Execute] ✅ Trade live — monitoring SL@$${slPrice.toFixed(2)} TP@$${tpPrice.toFixed(2)}`);
        console.log(`${'─'.repeat(65)}\n`);

        return {
            success: true, outcome: 'orders_placed',
            entryPrice: fillPrice, tpPrice, slPrice,
            tpMove: STRATEGY.TP_MOVE, slMove: STRATEGY.SL_MOVE,
            leverage, sizePct: 1.00,
            grossProfit: gross, netProfit: net, fees: 0, fillTimeMs,
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}