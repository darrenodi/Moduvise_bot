import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL, calcAtrRegime, safeLeverage } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
//
// Gold (XAUUSDT) on Binance USDⓈ-M Futures — dynamic leverage + dynamic TP.
//
// FEES (XAUUSDT Perp):
//   Maker: 0.0000%  (Binance zero maker fee / maker rebate environment)
//   Taker: 0.0450%  (market stop-loss exit)
//
// MODEL: Maker/Maker
//   ENTRY:  Maker limit at offset → resting on book, zero maker fee
//   TP:     GTC Maker limit → resting on book
//   SL:     Market Taker → monitored by main  0.0450%
//
// GATE: gross profit > fees × multiple — prevents fee-eating micro trades.
//
// ARCHITECTURE: decoupled — returns immediately after maker entry + TP placed.
// main.ts monitors SL every cycle independently.

const STRATEGY = {
    SYMBOL:              MARKET_SYMBOL,
    TAKER_FEE:           0.0005,            // 0.05% — taker fee for stop-loss exits (market order)
    MAKER_FEE:           0.0000,            // 0.00% — Binance zero maker fee (ALO confirmed)
    ENTRY_OFFSET:        0.10,              // GTX resting entry: 1 tick inside market — fills on any $0.10 dip
    ENTRY_FILL_TIMEOUT:  60_000,            // 60s fill window — Asia session moves slowly
    SL_MOVE:             10.00,             // fixed stop-loss distance: wide stop, tight TP (1:20 R:R)
    TARGET_TP:           0.50,              // fixed $0.50 TP per trade (all regimes)
    MIN_BALANCE:         1.50,
    GOLD_TICK:           0.10,
    MAX_TRADING_BALANCE: 25_000,            // $25K margin cap → $1M notional at 40x
    MAX_SIGNAL_DRIFT:    2.00,              // tighter: $0.50 TP = stale signal kills entire profit
    MIN_FEE_MULTIPLE:    1.0,               // fee gate: maker=0% so always passes; taker SL only on exit
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

// ─── ACTIVE TRADE STATE ───────────────────────────────────────────────────────

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
//
// demo.binance.com uses its own endpoint — NOT testnet.binancefuture.com
// Testnet keys (from demo.binance.com) → BINANCE_BOT_API / BINANCE_BOT_SECRET
// Live keys (from binance.com)         → BINANCE_API_KEY / BINANCE_API_SECRET

// ENVIRONMENT options:
//   'demo'    → demo.binance.com (your current setup — keys from demo.binance.com/api-management)
//   'testnet' → testnet.binancefuture.com (separate portal, separate keys)
//   'live'    → binance.com (real money)

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

// demo.binance.com REST base: https://testnet.binancefuture.com (same underlying infra)
// Keys from demo.binance.com ARE accepted at testnet.binancefuture.com fapi endpoints
// ccxt does not properly support demo-fapi.binance.com URL overrides.
// All PRIVATE calls (balance, orders, positions) use raw fetch + HMAC signing.
// ccxt is kept only for PUBLIC market data (tickers, OHLCV, order book).

const BASE_URL = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

// Public-only ccxt instance — no auth needed, safe to point at demo
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

// ── Raw signed fetch (bypasses ccxt for private endpoints) ────────────────────
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

console.log(`[Exchange] Binance USDM Futures | Mode: ${IS_TESTNET ? '🧪 TESTNET (demo.binance.com keys)' : '🔴 MAINNET'}`);

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
            // Got 0 — may be a transient demo API glitch, retry
            console.warn(`[Execute] Balance returned 0 (attempt ${attempt}/3) — retrying...`);
            await new Promise(r => setTimeout(r, 1500));
        } catch (e: any) {
            console.warn(`[Execute] Balance error attempt ${attempt}/3: ${String(e.message).slice(0, 80)}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
        }
    }
    // All retries failed — return last known virtual balance if available
    console.error(`[Execute] Balance unavailable after 3 attempts — using 0`);
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

// ─── SL TRIGGER ───────────────────────────────────────────────────────────────

export async function triggerStopLoss(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[Execute] 🛑 STOP LOSS (${reason}) — market ${closeSide} ${size}`);
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
            console.log(`[Execute] SL submitted (attempt ${attempt}).`);
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

// ─── DYNAMIC SIZE CALCULATION ─────────────────────────────────────────────────
// Binance XAUUSDT quantity is in XAU (troy oz).
// Min order size: 0.01 XAU.

export function calcSize(balance: number, price: number, sizePct: number, leverage: number): number {
    const cappedBalance = Math.min(balance, STRATEGY.MAX_TRADING_BALANCE);
    const usable        = cappedBalance * sizePct;
    const posVal        = usable * leverage;
    const raw           = posVal / price;
    const floored       = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

// ─── FEE GATE ─────────────────────────────────────────────────────────────────

function passesFeeGate(size: number, tpMove: number, entryPrice: number): boolean {
    const posVal     = size * entryPrice;
    const makerFee   = posVal * STRATEGY.MAKER_FEE;
    const totalFees  = makerFee * 2; // entry + TP
    const gross      = size * tpMove;
    const multiple   = totalFees > 0 ? gross / totalFees : 999;
    const passes     = multiple >= STRATEGY.MIN_FEE_MULTIPLE;

    console.log(`[Execute] Fee gate: gross=$${gross.toFixed(4)} fees=$${totalFees.toFixed(4)} multiple=${multiple.toFixed(1)}x (need ${STRATEGY.MIN_FEE_MULTIPLE}x) → ${passes ? '✅ PASS' : '❌ FAIL'}`);
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

    const tpMove   = STRATEGY.TARGET_TP;   // always $0.50 — ALO maker-maker strategy
    const leverage = signal.suggested_leverage ?? 20;
    const sizePct  = signal.session_size_pct   ?? 0.80;

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] XAUUSDT ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] TP=$${tpMove.toFixed(2)} | SL=$${STRATEGY.SL_MOVE.toFixed(2)} | Lev=${leverage}x | Size=${(sizePct * 100).toFixed(0)}% | ${IS_TESTNET ? '🧪 TESTNET' : '🔴 LIVE'}`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── 1. POSITION GUARD ─────────────────────────────────────────────
        if (_activeTrade || await hasOpenPosition()) {
            console.log(`[Execute] 🛑 Position already open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // ── 2. BALANCE ────────────────────────────────────────────────────
        // Use virtualBalance passed from main.ts (already fetched this cycle).
        // Only re-fetch from exchange if not provided.
        const effectiveBalance = virtualBalance && virtualBalance > 0
            ? virtualBalance
            : await getAvailableBalance();
        console.log(`[Execute] Effective balance: $${effectiveBalance.toFixed(4)}`);
        if (effectiveBalance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Low balance: $${effectiveBalance.toFixed(4)}` };
        }

        // ── 3. LEVERAGE — set dynamically per trade ────────────────────────
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
            console.log(`[Execute] Leverage set: ${leverage}x`);
        } catch (e: any) {
            // Demo account may not support leverage API — non-blocking
            console.log(`[Execute] Leverage note: ${String(e.message ?? '').slice(0, 60)} (continuing)`);
        }

        // ── 4. MARGIN MODE — cross (demo default, isolated not required) ──
        // Skipped: demo-fapi does not support marginType API (-1109)

        // ── 5. STALE SIGNAL CHECK ─────────────────────────────────────────
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

        // ── 6. SIZE ───────────────────────────────────────────────────────
        const size   = calcSize(effectiveBalance, livePrice, sizePct, leverage);
        const posVal = size * livePrice;
        console.log(`[Execute] Size: ${size} XAU | Notional: ~$${posVal.toFixed(2)} | Margin: ~$${(posVal / leverage).toFixed(2)}`);

        // ── 7. FEE GATE ───────────────────────────────────────────────────
        if (!passesFeeGate(size, tpMove, livePrice)) {
            return { success: false, outcome: 'skipped', message: 'Fee gate: gross < maker fees' };
        }

        // ── 8. MAKER LIMIT ENTRY ─────────────────────────────────────────
        const entryStart  = Date.now();
        const entryPrice  = tickRound(isBuy ? livePrice - STRATEGY.ENTRY_OFFSET : livePrice + STRATEGY.ENTRY_OFFSET);
        let fillPrice     = entryPrice;
        let filledSize    = 0;
        let fillTimeMs    = 0;

        try {
            const entryOrder = await privatePost('/fapi/v1/order', {
                symbol:      STRATEGY.SYMBOL,
                side:        side.toUpperCase(),
                type:        'LIMIT',
                timeInForce: 'GTX',        // GTX = Good Till Crossing = Post-Only/ALO on USDM Futures
                price:       entryPrice.toFixed(2),
                quantity:    size,
            });

            console.log(`[Execute] ⏳ MAKER ENTRY submitted: ${size} XAU @ $${entryPrice.toFixed(2)} (orderId=${entryOrder.orderId})`);

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
                console.log(`[Execute] ❌ Maker entry not filled in ${STRATEGY.ENTRY_FILL_TIMEOUT / 1000}s — skipping.`);
                return { success: false, outcome: 'skipped', message: 'Maker entry not filled' };
            }

            filledSize = executedQty;
            fillPrice  = avgPrice > 0 ? avgPrice : entryPrice;
            fillTimeMs = Date.now() - entryStart;

            if (filledSize < size) {
                console.log(`[Execute] ⚠️ Partial maker fill: ${filledSize.toFixed(2)}/${size.toFixed(2)} XAU — cancelling remainder...`);
                try { await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId }); } catch { /* ignore */ }
            }

            console.log(`[Execute] ✅ MAKER ENTRY filled: ${filledSize.toFixed(2)} XAU @ $${fillPrice.toFixed(2)} (${fillTimeMs}ms)`);

            // ── 9. MAKER GTC LIMIT TP — resting on book ───────────────────
            const tpPrice = tickRound(isBuy ? fillPrice + tpMove : fillPrice - tpMove);
            const slPrice = tickRound(isBuy ? fillPrice - STRATEGY.SL_MOVE : fillPrice + STRATEGY.SL_MOVE);

            const makerFee  = filledSize * fillPrice * STRATEGY.MAKER_FEE;
            const totalFees = makerFee * 2;
            const gross     = filledSize * tpMove;
            const net       = gross - totalFees;

            console.log(`[Execute] TP=$${tpPrice.toFixed(2)} (+$${tpMove.toFixed(2)}) | SL=$${slPrice.toFixed(2)} (-$${STRATEGY.SL_MOVE.toFixed(2)}) | R:R 1:20 (risk $10 for $0.50) | MAKER-MAKER ALO`);
            console.log(`[Execute] Gross=$${gross.toFixed(4)} | Fees=M:$${makerFee.toFixed(4)}+M:$${makerFee.toFixed(4)}=$${totalFees.toFixed(4)} | Net=$${net.toFixed(4)}`);

            try {
                const tpOrder = await privatePost('/fapi/v1/order', {
                    symbol:      STRATEGY.SYMBOL,
                    side:        closeSide.toUpperCase(),
                    type:        'LIMIT',
                    timeInForce: 'GTX',        // GTX = Post-Only/ALO on USDM Futures — maker fee guaranteed
                    price:       tpPrice.toFixed(2),
                    quantity:    filledSize,
                    reduceOnly:  'true',
                });
                console.log(`[Execute] ✅ MAKER TP placed: orderId=${tpOrder.orderId}`);
            } catch (e: any) {
                console.error(`[Execute] TP order failed: ${e.message} — SL in main.ts will protect.`);
            }

            _activeTrade = {
                entryPrice: fillPrice, tpPrice, slPrice, tpMove,
                side: direction, size: filledSize, posVal: filledSize * fillPrice, leverage,
                openedAt: Date.now(),
            };

            console.log(`[Execute] ✅ Decoupled — main.ts monitors SL@$${slPrice.toFixed(2)} TP@$${tpPrice.toFixed(2)}`);
            console.log(`${'─'.repeat(65)}\n`);

            return {
                success: true, outcome: 'orders_placed',
                entryPrice: fillPrice, tpPrice, slPrice, tpMove, leverage, sizePct,
                grossProfit: gross, netProfit: net, fees: totalFees, fillTimeMs,
            };

        } catch (e: any) {
            console.error(`[Execute] Maker entry failed: ${e.message}`);
            return { success: false, outcome: 'error', message: `Maker entry failed: ${e.message}` };
        }

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
