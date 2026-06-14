import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL, calcAtrRegime, safeLeverage } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
//
// Gold (XAUUSDT) on Binance USDⓈ-M Futures
//
// FEES (confirmed from live PNL records):
//   Maker: 0.0000%  — entry GTX limit + TP GTX limit (both resting, ALO confirmed)
//   Taker: 0.0450%  — SL market exit only
//
// KEY CHANGES FROM PRIOR VERSION:
//   ENTRY_OFFSET      : 0.30 → 0.15  (fills ~2× faster, same GTX safety margin)
//   ENTRY_FILL_TIMEOUT: 600s → 90s   (stale signals killed, freed cycles sooner)
//   MAX_SIGNAL_DRIFT  : 2.00 → 1.00  (signal is worthless if price moved $1+)

const STRATEGY = {
    SYMBOL:              MARKET_SYMBOL,
    TAKER_FEE:           0.00045,          // 0.045% taker — SL exits only
    MAKER_FEE:           0.0000,           // 0.000% maker — ALO confirmed from live data
    ENTRY_OFFSET:        0.15,             // $0.15 below/above market — reachable on $3 ATR, fills faster
    ENTRY_FILL_TIMEOUT:  90_000,           // 90 seconds — if unfilled, skip and free the cycle
    SL_MOVE:             2.00,             // $2.00 stop loss — breakeven at 80% win rate
    TARGET_TP:           0.50,             // $0.50 fixed TP
    MIN_BALANCE:         1.50,
    GOLD_TICK:           0.10,
    MAX_TRADING_BALANCE: 25_000,
    MAX_SIGNAL_DRIFT:    1.00,             // tightened: $0.50 TP means $1 drift = signal is worthless
    MIN_FEE_MULTIPLE:    1.0,
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome =
    | 'orders_placed'
    | 'tp_confirmed'
    | 'sl_triggered'
    | 'skipped'
    | 'error';

export interface TradeResult {
    success:      boolean;
    outcome:      TradeOutcome;
    entryPrice?:  number;
    tpPrice?:     number;
    slPrice?:     number;
    tpMove?:      number;
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

const API_KEY    = IS_DEMO
    ? (process.env.BINANCE_BOT_API    ?? '')
    : ENVIRONMENT === 'testnet'
        ? (process.env.BINANCE_BOT_API ?? process.env.BINANCE_API_KEY ?? '')
        : (process.env.BINANCE_API_KEY ?? '');

const API_SECRET = IS_DEMO
    ? (process.env.BINANCE_BOT_SECRET ?? '')
    : ENVIRONMENT === 'testnet'
        ? (process.env.BINANCE_BOT_SECRET ?? process.env.BINANCE_API_SECRET ?? '')
        : (process.env.BINANCE_API_SECRET ?? '');

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
    const res = await fetch(url, {
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

async function privatePost(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const body    = Object.entries(entries).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(
        Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&')
    ).digest('hex');
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

async function privateDelete(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = signedUrl(path, params);
    const res = await fetch(url, {
        method:  'DELETE',
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

console.log(`[Exchange] Binance USDM Futures | Mode: ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'}`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

export async function getAvailableBalance(): Promise<number> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const data = await privateGet('/fapi/v3/account');
            const bal  = Number(data?.availableBalance ?? data?.totalWalletBalance ?? 0);
            if (bal > 0) {
                console.log(`[Execute] Balance: $${bal.toFixed(4)}`);
                return bal;
            }
            console.warn(`[Execute] Balance returned 0 (attempt ${attempt}/3) — retrying...`);
            await new Promise(r => setTimeout(r, 1500));
        } catch (e: any) {
            console.warn(`[Execute] Balance error attempt ${attempt}/3: ${String(e.message).slice(0, 80)}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
        }
    }
    return 0;
}

export async function hasOpenPosition(): Promise<boolean> {
    try {
        const data = await privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL });
        return Array.isArray(data) && data.some((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0);
    } catch {
        return false;
    }
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
            fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`)
                .then(r => r.json()).catch(() => ({ price: '0' })),
        ]);
        const pos = Array.isArray(positions)
            ? positions.find((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0)
            : null;
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };

        const posAmt        = Number(pos.positionAmt ?? 0);
        const size          = Math.abs(posAmt);
        const entry         = Number(pos.entryPrice ?? 0);
        const side          = posAmt > 0 ? 'long' : 'short';
        const unrealisedPnl = Number(pos.unRealizedProfit ?? 0);
        const currentPrice  = Number((priceData as any).price ?? entry);
        return { exists: true, side, entryPrice: entry, size, unrealisedPnl, currentPrice };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };
    }
}

// ─── STOP LOSS ────────────────────────────────────────────────────────────────
// Uses MARKET reduceOnly — this is the correct endpoint for USDM Futures.
// STOP_MARKET conditional orders are routed via Algo Service on live Binance,
// but for our SL-by-monitoring pattern, a plain MARKET reduceOnly is correct
// and works on both demo-fapi and fapi.

export async function triggerStopLoss(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[Execute] 🛑 STOP LOSS (${reason}) — market ${closeSide} ${size}`);
    // Cancel all open orders first (including resting TP) before sending market close
    try { await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL }); } catch { /* ok */ }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await privatePost('/fapi/v1/order', {
                symbol:     STRATEGY.SYMBOL,
                side:       closeSide,
                type:       'MARKET',
                quantity:   size,
                reduceOnly: 'true',
            });
            console.log(`[Execute] ✅ SL market order submitted (attempt ${attempt}).`);
            clearActiveTrade();
            return;
        } catch (e: any) {
            console.error(`[Execute] SL attempt ${attempt} FAILED: ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1_500));
        }
    }
    console.error(`[Execute] ⚠️ All SL attempts failed — position may still be open!`);
}

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

export function calcSize(balance: number, price: number, sizePct: number, leverage: number): number {
    const cappedBalance = Math.min(balance, STRATEGY.MAX_TRADING_BALANCE);
    const usable        = cappedBalance * sizePct;
    const posVal        = usable * leverage;
    const raw           = posVal / price;
    const floored       = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

function passesFeeGate(size: number, tpMove: number, entryPrice: number): boolean {
    const posVal    = size * entryPrice;
    const makerFee  = posVal * STRATEGY.MAKER_FEE;
    const totalFees = makerFee * 2;
    const gross     = size * tpMove;
    const multiple  = totalFees > 0 ? gross / totalFees : 999;
    const passes    = multiple >= STRATEGY.MIN_FEE_MULTIPLE;
    console.log(`[Execute] Fee gate: gross=$${gross.toFixed(4)} fees=$${totalFees.toFixed(4)} multiple=${multiple.toFixed(1)}x → ${passes ? '✅ PASS' : '❌ FAIL'}`);
    return passes;
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
    const side      = isBuy ? 'buy'  : 'sell';
    const closeSide = isBuy ? 'sell' : 'buy';

    const tpMove   = STRATEGY.TARGET_TP;
    const leverage = signal.suggested_leverage ?? 40;
    const sizePct  = signal.session_size_pct   ?? 0.80;

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] XAUUSDT ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] TP=$${tpMove.toFixed(2)} | SL=$${STRATEGY.SL_MOVE.toFixed(2)} | Lev=${leverage}x | Size=${(sizePct * 100).toFixed(0)}%`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // 1. POSITION GUARD
        if (_activeTrade || await hasOpenPosition()) {
            console.log(`[Execute] 🛑 Position already open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // 2. BALANCE
        const effectiveBalance = virtualBalance && virtualBalance > 0
            ? virtualBalance
            : await getAvailableBalance();
        console.log(`[Execute] Effective balance: $${effectiveBalance.toFixed(4)}`);

        if (effectiveBalance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Low balance: $${effectiveBalance.toFixed(4)}` };
        }

        // 3. LEVERAGE
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
            console.log(`[Execute] Leverage set: ${leverage}x`);
        } catch (e: any) {
            console.log(`[Execute] Leverage note: ${String(e.message ?? '').slice(0, 60)} (continuing)`);
        }

        // 4. STALE SIGNAL CHECK — tightened to $1.00 drift limit
        let livePrice = signal.market_price;
        try {
            const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`)
                .then(r => r.json()) as any;
            livePrice = Number(ticker?.price ?? signal.market_price);
        } catch { /* use signal price */ }

        const drift = Math.abs(livePrice - signal.market_price);
        if (drift > STRATEGY.MAX_SIGNAL_DRIFT) {
            console.log(`[Execute] ⏩ Stale signal — drifted $${drift.toFixed(2)}. Skip.`);
            return { success: false, outcome: 'skipped', message: `Signal stale: $${drift.toFixed(2)} drift` };
        }

        // 5. SIZE
        const size   = calcSize(effectiveBalance, livePrice, sizePct, leverage);
        const posVal = size * livePrice;
        console.log(`[Execute] Size: ${size} XAU | Notional: ~$${posVal.toFixed(2)} | Margin: ~$${(posVal / leverage).toFixed(2)}`);

        // 6. FEE GATE
        if (!passesFeeGate(size, tpMove, livePrice)) {
            return { success: false, outcome: 'skipped', message: 'Fee gate: gross < fees' };
        }

        // 7. MAKER GTX ENTRY — $0.15 offset, 90s fill timeout
        const entryStart = Date.now();
        let fillPrice    = 0;
        let filledSize   = 0;
        let fillTimeMs   = 0;
        let entryOrder: any = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            let attemptPrice = livePrice;
            if (attempt > 1) {
                try {
                    const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`)
                        .then(r => r.json()) as any;
                    attemptPrice = Number(ticker?.price ?? livePrice);
                    console.log(`[Execute] GTX retry — refreshed price: $${attemptPrice.toFixed(2)}`);
                } catch { /* use livePrice */ }
                await new Promise(r => setTimeout(r, 1_000));
            }

            // $0.15 offset — half of original $0.30, fills ~2× faster on Gold's typical $3–5 ATR
            const entryPrice = tickRound(
                isBuy ? attemptPrice - STRATEGY.ENTRY_OFFSET : attemptPrice + STRATEGY.ENTRY_OFFSET
            );

            try {
                entryOrder = await privatePost('/fapi/v1/order', {
                    symbol:      STRATEGY.SYMBOL,
                    side:        side.toUpperCase(),
                    type:        'LIMIT',
                    timeInForce: 'GTX',
                    price:       entryPrice.toFixed(2),
                    quantity:    size,
                });
                console.log(`[Execute] ⏳ GTX ENTRY: ${size} XAU @ $${entryPrice.toFixed(2)} (id=${entryOrder.orderId}) attempt=${attempt}`);
                fillPrice = entryPrice;
                break;
            } catch (e: any) {
                const msg = String(e.message ?? '');
                if (msg.includes('-5022') && attempt < 2) {
                    console.log(`[Execute] ⚠️ GTX -5022 — retrying with fresh price...`);
                    continue;
                }
                console.error(`[Execute] Maker entry failed: ${e.message}`);
                return { success: false, outcome: 'error', message: `Maker entry failed: ${e.message}` };
            }
        }

        if (!entryOrder) {
            return { success: false, outcome: 'skipped', message: 'GTX entry rejected after retries' };
        }

        // 8. FILL POLLING — 90s timeout, 500ms polling interval
        let entryStatus: any = entryOrder;
        let executedQty = Number(entryOrder.executedQty ?? 0);
        let avgPrice    = Number(entryOrder.avgPrice ?? 0);

        while (Date.now() - entryStart < STRATEGY.ENTRY_FILL_TIMEOUT && executedQty < size) {
            await new Promise(r => setTimeout(r, 500));
            entryStatus = await privateGet('/fapi/v1/order', {
                symbol:  STRATEGY.SYMBOL,
                orderId: entryOrder.orderId,
            });
            executedQty = Number(entryStatus.executedQty ?? executedQty);
            avgPrice    = Number(entryStatus.avgPrice ?? avgPrice);
            if (entryStatus.status === 'FILLED' || executedQty >= size) break;
        }

        if (executedQty <= 0) {
            try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ignore */ }
            console.log(`[Execute] ❌ Not filled in ${STRATEGY.ENTRY_FILL_TIMEOUT / 1000}s — skipping.`);
            return { success: false, outcome: 'skipped', message: 'Maker entry not filled in 90s' };
        }

        filledSize = executedQty;
        fillPrice  = avgPrice > 0 ? avgPrice : fillPrice;
        fillTimeMs = Date.now() - entryStart;

        if (filledSize < size) {
            console.log(`[Execute] ⚠️ Partial fill: ${filledSize.toFixed(2)}/${size.toFixed(2)} XAU — cancelling remainder...`);
            try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ignore */ }
        }

        console.log(`[Execute] ✅ FILLED: ${filledSize.toFixed(2)} XAU @ $${fillPrice.toFixed(2)} (${fillTimeMs}ms)`);

        // 9. MAKER GTX TP — resting limit, guaranteed maker
        const tpPrice = tickRound(isBuy ? fillPrice + tpMove : fillPrice - tpMove);
        const slPrice = tickRound(isBuy ? fillPrice - STRATEGY.SL_MOVE : fillPrice + STRATEGY.SL_MOVE);

        const makerFee  = filledSize * fillPrice * STRATEGY.MAKER_FEE;
        const totalFees = makerFee * 2;
        const gross     = filledSize * tpMove;
        const net       = gross - totalFees;

        console.log(`[Execute] TP=$${tpPrice.toFixed(2)} | SL=$${slPrice.toFixed(2)} | Gross=$${gross.toFixed(4)} | Net=$${net.toFixed(4)}`);

        try {
            const tpOrder = await privatePost('/fapi/v1/order', {
                symbol:      STRATEGY.SYMBOL,
                side:        closeSide.toUpperCase(),
                type:        'LIMIT',
                timeInForce: 'GTX',
                price:       tpPrice.toFixed(2),
                quantity:    filledSize,
                reduceOnly:  'true',
            });
            console.log(`[Execute] ✅ TP placed: id=${tpOrder.orderId}`);
        } catch (e: any) {
            console.error(`[Execute] TP order failed: ${e.message} — SL monitor in main.ts will protect.`);
        }

        _activeTrade = {
            entryPrice: fillPrice, tpPrice, slPrice, tpMove,
            side: direction, size: filledSize, posVal: filledSize * fillPrice, leverage,
            openedAt: Date.now(),
        };

        console.log(`[Execute] ✅ Trade live — main.ts monitors SL@$${slPrice.toFixed(2)} TP@$${tpPrice.toFixed(2)}`);
        console.log(`${'─'.repeat(65)}\n`);

        return {
            success: true, outcome: 'orders_placed',
            entryPrice: fillPrice, tpPrice, slPrice, tpMove, leverage, sizePct,
            grossProfit: gross, netProfit: net, fees: totalFees, fillTimeMs,
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
