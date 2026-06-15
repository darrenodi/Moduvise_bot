import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL, safeLeverage } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
//
// XAUUSDT USDM Futures — bracket order architecture
//
// ENTRY:  GTX limit @ $0.20 from market  → 0.00% maker fee (confirmed live)
// TP:     GTX limit @ +$1.00             → 0.00% maker fee
// SL:     STOP_MARKET reduceOnly         → 0.045% taker fee (~$0.02 per trade)
//
// Both TP and SL are placed immediately after entry fills.
// The exchange enforces whichever triggers first and cancels the other.
// The bot no longer needs to poll price for SL — the exchange handles it
// in microseconds. This eliminates the SL blowthrough seen in live data
// ($6.71 and $6.01 adverse moves against a $3.00 configured SL).
//
// SL taker fee on 0.01 XAU @ $4300: $43 × 0.00045 = $0.019
// This is 0.6% of the $3.00 SL loss. Not worth avoiding via polling.
//
// TP:  $1.00  SL: $3.00  → breakeven win rate = 75.0%
// Observed win rate from live data: ~69% (below breakeven — see analysis)
// Target win rate needed before scaling: consistently above 78%

const STRATEGY = {
    SYMBOL:              MARKET_SYMBOL,
    TAKER_FEE:           0.00045,       // 0.045% — SL STOP_MARKET only
    MAKER_FEE:           0.0000,        // 0.000% — confirmed from live PNL records
    ENTRY_OFFSET:        0.20,          // $0.20 from market price
                                        // Safe GTX zone: never crosses book
                                        // Fills in ~20-60s on Gold $3-5 ATR/5m
                                        // $0.10 risks -5022 in fast moves
                                        // $0.30 costs 30% of TP before trade starts
    ENTRY_FILL_TIMEOUT:  90_000,        // 90s — stale if price hasn't moved $0.20
    TP_MOVE:             1.00,          // $1.00 take profit
    SL_MOVE:             3.00,          // $3.00 stop loss → breakeven at 75% WR
    MIN_BALANCE:         1.50,
    GOLD_TICK:           0.10,
    MAX_TRADING_BALANCE: 25_000,
    MAX_SIGNAL_DRIFT:    1.50,          // skip if price moved >$1.50 since signal
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
    tpOrderId?:   number;
    slOrderId?:   number;
    leverage?:    number;
    grossProfit?: number;
    netProfit?:   number;
    slFee?:       number;
    message?:     string;
    fillTimeMs?:  number;
}

export interface ActiveTrade {
    entryPrice: number;
    tpPrice:    number;
    slPrice:    number;
    tpOrderId:  number;
    slOrderId:  number;
    side:       'long' | 'short';
    size:       number;
    leverage:   number;
    openedAt:   number;
    grossProfit: number;
    netProfit:   number;
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────

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

export const BASE_URL = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

console.log(`[Exchange] Mode: ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'} | TP=$${STRATEGY.TP_MOVE} SL=$${STRATEGY.SL_MOVE} offset=$${STRATEGY.ENTRY_OFFSET}`);

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

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
        method:  'POST',
        headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body + `&signature=${sig}`,
        signal:  AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
}

export async function privateDelete(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = signedUrl(path, params);
    const res = await fetch(url, { method: 'DELETE', headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

// ─── ACCOUNT HELPERS ──────────────────────────────────────────────────────────

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
    exists: boolean; side: 'long' | 'short' | null;
    entryPrice: number; size: number; unrealisedPnl: number; currentPrice: number;
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
            exists: true, side: posAmt > 0 ? 'long' : 'short',
            entryPrice: Number(pos.entryPrice ?? 0), size: Math.abs(posAmt),
            unrealisedPnl: Number(pos.unRealizedProfit ?? 0),
            currentPrice: Number((priceData as any).price ?? 0),
        };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };
    }
}

// ─── CHECK IF EXCHANGE-SIDE ORDER IS STILL OPEN ───────────────────────────────
// Used by monitoring loop to detect if TP or SL was hit exchange-side

export async function getOrderStatus(orderId: number): Promise<string | null> {
    try {
        const data = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId });
        return String(data?.status ?? 'UNKNOWN');
    } catch { return null; }
}

// ─── EMERGENCY CLOSE ──────────────────────────────────────────────────────────
// Only called for orphan positions — normal SL is exchange-side STOP_MARKET

export async function emergencyClose(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[Execute] 🚨 EMERGENCY CLOSE (${reason}) — market ${closeSide} ${size}`);
    try { await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL }); } catch { /* ok */ }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL, side: closeSide, type: 'MARKET',
                quantity: size, reduceOnly: 'true',
            });
            console.log(`[Execute] ✅ Emergency close submitted (attempt ${attempt})`);
            clearActiveTrade();
            return;
        } catch (e: any) {
            console.error(`[Execute] Emergency close attempt ${attempt} failed: ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1_500));
        }
    }
    console.error(`[Execute] ⚠️ All emergency close attempts failed — check position manually!`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

// 100% of balance every trade, capped at MAX_TRADING_BALANCE
export function calcSize(balance: number, price: number): number {
    const capped  = Math.min(balance, STRATEGY.MAX_TRADING_BALANCE);
    const posVal  = capped * STRATEGY.LEVERAGE;
    const raw     = posVal / price;
    return Math.max(0.01, Math.floor(raw * 100) / 100);
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
    const entrySide = isBuy ? 'BUY'  : 'SELL';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const leverage  = signal.suggested_leverage ?? STRATEGY.LEVERAGE;

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] TP=+$${STRATEGY.TP_MOVE} (GTX maker) | SL=-$${STRATEGY.SL_MOVE} (STOP_MARKET taker) | ${leverage}x`);
    console.log(`[Execute] ${signal.reasoning.slice(0, 100)}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // 1. GUARD
        if (_activeTrade || await hasOpenPosition()) {
            console.log(`[Execute] Position already open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // 2. BALANCE
        const effectiveBalance = virtualBalance && virtualBalance > 0
            ? virtualBalance : await getAvailableBalance();
        if (effectiveBalance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Balance too low: $${effectiveBalance.toFixed(4)}` };
        }

        // 3. LEVERAGE
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch (e: any) {
            console.log(`[Execute] Leverage note: ${String(e.message ?? '').slice(0, 60)}`);
        }

        // 4. STALE CHECK
        let livePrice = signal.market_price;
        try {
            const t = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
            livePrice = Number(t?.price ?? signal.market_price);
        } catch { /* use signal price */ }

        const drift = Math.abs(livePrice - signal.market_price);
        if (drift > STRATEGY.MAX_SIGNAL_DRIFT) {
            console.log(`[Execute] Stale — $${drift.toFixed(2)} drift > $${STRATEGY.MAX_SIGNAL_DRIFT}. Skip.`);
            return { success: false, outcome: 'skipped', message: `Signal stale: $${drift.toFixed(2)} drift` };
        }

        // 5. SIZE — 100% of balance
        const size   = calcSize(effectiveBalance, livePrice);
        const posVal = size * livePrice;
        console.log(`[Execute] Size: ${size} XAU | Notional: $${posVal.toFixed(2)} | Margin: $${(posVal / leverage).toFixed(2)}`);

        // 6. GTX ENTRY — $0.20 offset
        const entryStart = Date.now();
        let entryOrder: any = null;
        let fillPrice = 0;

        for (let attempt = 1; attempt <= 2; attempt++) {
            let attemptPrice = livePrice;
            if (attempt > 1) {
                try {
                    const t = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
                    attemptPrice = Number(t?.price ?? livePrice);
                    console.log(`[Execute] Retry — fresh price: $${attemptPrice.toFixed(2)}`);
                } catch { /* use livePrice */ }
                await new Promise(r => setTimeout(r, 1_000));
            }

            const entryPrice = tickRound(isBuy
                ? attemptPrice - STRATEGY.ENTRY_OFFSET
                : attemptPrice + STRATEGY.ENTRY_OFFSET);

            try {
                entryOrder = await privatePost('/fapi/v1/order', {
                    symbol:      STRATEGY.SYMBOL,
                    side:        entrySide,
                    type:        'LIMIT',
                    timeInForce: 'GTX',
                    price:       entryPrice.toFixed(2),
                    quantity:    size,
                });
                console.log(`[Execute] ⏳ GTX entry: ${size} XAU @ $${entryPrice.toFixed(2)} id=${entryOrder.orderId}`);
                fillPrice = entryPrice;
                break;
            } catch (e: any) {
                if (String(e.message).includes('-5022') && attempt < 2) {
                    console.log(`[Execute] -5022 would cross book — retrying`);
                    continue;
                }
                return { success: false, outcome: 'error', message: `Entry failed: ${e.message}` };
            }
        }

        if (!entryOrder) return { success: false, outcome: 'skipped', message: 'GTX rejected' };

        // 7. FILL POLL — 500ms intervals, 90s timeout
        let executedQty = Number(entryOrder.executedQty ?? 0);
        let avgPrice    = Number(entryOrder.avgPrice ?? 0);

        while (Date.now() - entryStart < STRATEGY.ENTRY_FILL_TIMEOUT && executedQty < size) {
            await new Promise(r => setTimeout(r, 500));
            const st = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId });
            executedQty = Number(st.executedQty ?? executedQty);
            avgPrice    = Number(st.avgPrice ?? avgPrice);
            if (st.status === 'FILLED' || executedQty >= size) break;
        }

        if (executedQty <= 0) {
            try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ok */ }
            console.log(`[Execute] Not filled in 90s — skip.`);
            return { success: false, outcome: 'skipped', message: 'Not filled in 90s' };
        }

        const filledSize = executedQty;
        fillPrice        = avgPrice > 0 ? avgPrice : fillPrice;
        const fillTimeMs = Date.now() - entryStart;

        if (filledSize < size) {
            console.log(`[Execute] Partial fill: ${filledSize}/${size} XAU — cancelling remainder`);
            try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ok */ }
        }

        console.log(`[Execute] ✅ Filled: ${filledSize} XAU @ $${fillPrice.toFixed(2)} in ${fillTimeMs}ms`);

        // 8. BRACKET — TP (GTX maker) + SL (STOP_MARKET taker) placed simultaneously
        const tpPrice  = tickRound(isBuy ? fillPrice + STRATEGY.TP_MOVE  : fillPrice - STRATEGY.TP_MOVE);
        const slPrice  = tickRound(isBuy ? fillPrice - STRATEGY.SL_MOVE  : fillPrice + STRATEGY.SL_MOVE);
        const gross    = filledSize * STRATEGY.TP_MOVE;
        const slFee    = filledSize * fillPrice * STRATEGY.TAKER_FEE;    // worst case cost if SL hits
        const net      = gross;   // TP exit is maker 0% — no fee deduction on win

        console.log(`[Execute] Bracket: TP=$${tpPrice.toFixed(2)} | SL=$${slPrice.toFixed(2)} | Gross=$${gross.toFixed(4)} | SL cost if hit: $${slFee.toFixed(4)}`);

        let tpOrderId = 0;
        let slOrderId = 0;

        // TP — GTX resting limit (0% maker)
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
            tpOrderId = tpOrder.orderId;
            console.log(`[Execute] ✅ TP placed: id=${tpOrderId} @ $${tpPrice.toFixed(2)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
            // TP failure is non-fatal — SL will protect and monitoring will catch
        }

        // SL — STOP_MARKET (0.045% taker, ~$0.02 on 0.01 XAU)
        // Exchange enforces this in microseconds. No polling needed for SL protection.
        try {
            const slOrder = await privatePost('/fapi/v1/order', {
                symbol:      STRATEGY.SYMBOL,
                side:        closeSide,
                type:        'STOP_MARKET',
                stopPrice:   slPrice.toFixed(2),
                quantity:    filledSize,
                reduceOnly:  'true',
                workingType: 'MARK_PRICE',    // triggers on mark price, not last price
                                              // prevents wick-triggered false SL
            });
            slOrderId = slOrder.orderId;
            console.log(`[Execute] ✅ SL placed: id=${slOrderId} @ $${slPrice.toFixed(2)} (STOP_MARKET, mark price)`);
        } catch (e: any) {
            console.error(`[Execute] SL order failed: ${e.message} — monitoring loop is backup.`);
            // SL failure is logged but not fatal. Monitoring loop will catch via position check.
        }

        _activeTrade = {
            entryPrice: fillPrice, tpPrice, slPrice,
            tpOrderId, slOrderId,
            side: direction, size: filledSize,
            leverage, openedAt: Date.now(),
            grossProfit: gross, netProfit: net,
        };

        console.log(`[Execute] ✅ Bracket live — exchange enforces TP@$${tpPrice.toFixed(2)} and SL@$${slPrice.toFixed(2)}`);
        console.log(`${'─'.repeat(65)}\n`);

        return {
            success: true, outcome: 'orders_placed',
            entryPrice: fillPrice, tpPrice, slPrice,
            tpOrderId, slOrderId, leverage,
            grossProfit: gross, netProfit: net, slFee, fillTimeMs,
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}