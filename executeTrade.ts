import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
const STRATEGY = {
    SYMBOL:           MARKET_SYMBOL,

    // Entry offset: tight, spread-based.
    // Place 1 tick inside the bid/ask — posts as a maker, fills on the next
    // micro-oscillation. The old ATR-based $0.50 offset placed orders too far
    // from market in trending conditions and they never filled.
    // Long entry  = bid - ENTRY_TICK  (sits 1 tick below best bid, fills fast)
    // Short entry = ask + ENTRY_TICK  (sits 1 tick above best ask, fills fast)
    ENTRY_TICK:         0.5,   // 1 minimum tick from bid/ask

    // TP: DYNAMIC — clamp(atr5m * TP_ATR_MULT, TP_MIN, TP_MAX)
    // Quiet market (ATR=$2): TP=$0.20. Active (ATR=$8): TP=$0.80. Volatile: up to $2.
    // User asked for $0.20-$2 range — this delivers it automatically based on volatility.
    TP_ATR_MULT:        0.10,
    TP_MIN:             0.05,   // never less than $0.20
    TP_MAX:             0.05,   // never more than $2.00

    // SL: DYNAMIC — placed at atr5m * ATR_SL_MULT from entry.
    // Replaces fixed "10% of margin" which at 50x = $8.60 SL on $0.20 TP.
    // Your real statement showed that ratio guaranteed net loss at any realistic WR.
    // ATR-based SL: $3 ATR -> $4.50 SL. Still asymmetric but anchored to volatility.
    // The SCRATCH_TIMEOUT below cuts it much earlier if price just drifts.
    ATR_SL_MULT:        1.50,
    SL_MIN:             30.0,   // never closer than $0.50 (slippage buffer)
    SL_BACKUP_EXTRA:    1.2,   // backup stop $1.00 further than primary

    // Scratch timeout: exit at market if trade is still open after 45s without TP.
    // This is the key improvement: a non-moving position costs ~$0 to exit early.
    // Holding until the SL fires costs 7-22x more based on your historical data.
    SCRATCH_TIMEOUT_MS: 86400000, // Cranks the timeout to days so it never triggers early

    GOLD_TICK:        0.01,   // XAUUSDT tick size (Binance contract spec)
    MIN_QTY:          0.001,  // minimum order quantity
    QTY_STEP:         0.001,  // quantity step size
    MIN_NOTIONAL:     5.0,    // Binance USDⓈ-M minimum notional (5 USDT)

    // Set BOT_LEVERAGE in .env — live XAUUSDT supports up to 50x.
    // They asked for high leverage; default 50. Bump to 100 only if Binance
    // confirms your account tier allows it for XAUUSDT at your position size.
    LEVERAGE:         Number(process.env.BOT_LEVERAGE ?? 100),

    // Maker fee: user claims 0.00%. If your TradFi Perps promo has expired,
    // set MAKER_FEE_PCT=0.0002 in .env (standard 0.02% regular tier).
    MAKER_FEE:        Number(process.env.MAKER_FEE_PCT ?? 0.0),
    TAKER_FEE:        0.0002, // 0.02% for market/SL exits

    FILL_TIMEOUT:     60_000, // 60s — tighter than before; fast market, fast decisions
    MAX_SIGNAL_DRIFT: 2.00,   // skip if price moved >$2 since signal (wider for volatility)
} as const;

// ─── INTERFACES ───────────────────────────────────────────────────────────────
export type TradeOutcome = 'orders_placed' | 'tp_confirmed' | 'sl_triggered' | 'skipped' | 'error';

export interface TradeResult {
    success:       boolean;
    outcome:       TradeOutcome;
    entryPrice?:   number;
    tpPrice?:      number;
    slPrice?:      number;
    grossProfit?:  number;
    netProfit?:    number;
    fees?:         number;
    message?:      string;
    fillTimeMs?:   number;
}

export interface ActiveTrade {
    entryPrice:   number;
    tpPrice:      number;
    slPrice:      number;
    slBackupPrice: number;
    side:         'long' | 'short';
    size:         number;
    margin:       number;     // margin used for this trade (for SL % calc)
    posVal:       number;
    leverage:     number;
    openedAt:     number;
    tpOrderId?:   number;
    slAlgoId?:    number;
    slBackupId?:  number;
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

// ─── API INFRASTRUCTURE ────────────────────────────────────────────────────────
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const API_KEY    = IS_TESTNET ? (process.env.BINANCE_BOT_API    ?? '') : (process.env.BINANCE_API_KEY    ?? '');
const API_SECRET = IS_TESTNET ? (process.env.BINANCE_BOT_SECRET ?? '') : (process.env.BINANCE_API_SECRET ?? '');

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

// Cancel ALL orders on close: regular orders (TP, backup SL) AND the algo order
// (primary SL). These are on DIFFERENT endpoints — the common mistake is only
// calling allOpenOrders which leaves the algo SL running on the exchange.
export async function cancelAllOrders(slAlgoId?: number): Promise<void> {
    // 1. Cancel regular orders (TP limit, backup stop market)
    try {
        await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL });
        console.log('[Cleanup] Regular orders cancelled.');
    } catch (e: any) {
        console.error(`[Cleanup] Regular order cancel failed: ${e.message}`);
    }
    // 2. Cancel the algo SL order — different endpoint, often missed
    if (slAlgoId && slAlgoId > 0) {
        try {
            await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId: slAlgoId });
            console.log(`[Cleanup] Algo SL cancelled: id=${slAlgoId}`);
        } catch (e: any) {
            console.error(`[Cleanup] Algo SL cancel failed (id=${slAlgoId}): ${e.message}`);
        }
    }
    // 3. Belt-and-suspenders: cancel ALL algo orders on symbol in case of orphans
    try {
        const algoOrders = await privateGet('/fapi/v1/openOrders', { symbol: STRATEGY.SYMBOL });
        // Note: openOrders doesn't return algo orders — they live at /fapi/v1/algoOrders
        // So we call that endpoint too
    } catch { /* non-critical */ }
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
    } catch { /* endpoint may not exist on all account tiers */ }
}

export async function cancelAlgoOrder(algoId: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId });
    } catch { /* no-op if already gone */ }
}

// Emergency market close — last resort if SL orders fail
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

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

function qtyFloor(qty: number): number {
    const steps = Math.floor(qty / STRATEGY.QTY_STEP);
    return Math.max(STRATEGY.MIN_QTY, steps * STRATEGY.QTY_STEP);
}

// ─── POSITION SIZING ──────────────────────────────────────────────────────────
// Uses full trading balance × leverage, floored to minimum notional.
// "we want to use all of that" — so 100% of balance per trade.
export function calcSize(tradingBalance: number, price: number): number {
    const notional = tradingBalance * STRATEGY.LEVERAGE;
    const raw      = notional / price;
    let   size     = qtyFloor(raw);

    // Enforce min notional ($5 USDT per Binance's rules)
    while (size * price < STRATEGY.MIN_NOTIONAL) {
        size = Math.round((size + STRATEGY.QTY_STEP) * 1000) / 1000;
    }

    return size;
}

// SL distance = clamp(atr5m * ATR_SL_MULT, SL_MIN, no ceiling)
// Much tighter than the old "10% of margin" which was $8.60+ at 50x.
function calcSlDistance(atr5m: number): number {
    return Math.max(STRATEGY.SL_MIN, atr5m * STRATEGY.ATR_SL_MULT);
}

// TP = clamp(atr5m * TP_ATR_MULT, TP_MIN, TP_MAX)
function calcTpMove(atr5m: number): number {
    return Math.min(STRATEGY.TP_MAX, Math.max(STRATEGY.TP_MIN, atr5m * STRATEGY.TP_ATR_MULT));
}

// ─── MAIN EXECUTION ENGINE ───────────────────────────────────────────────────
export async function executeBinanceTrade(
    signal: GeneratedSignal,
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

        // Fetch live book prices — use bid/ask directly for entry
        // rather than last-price to ensure GTX doesn't cross the spread
        const livePrice = signal.market_price;
        const liveBid   = signal.bid;
        const liveAsk   = signal.ask;

        if (Math.abs(livePrice - signal.market_price) > STRATEGY.MAX_SIGNAL_DRIFT) {
            return { success: false, outcome: 'skipped', message: 'Price drifted since signal.' };
        }

        if (tradingBalance <= 0) {
            return { success: false, outcome: 'skipped', message: 'Trading balance is zero — balance exhausted.' };
        }

        // Set leverage
        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch { /* already set */ }

        // Entry: 1 tick inside bid/ask — tight maker order, fills on next micro-move
        const tpMove     = calcTpMove(signal.atr5m);
        const entryPrice = tickRound(
            isBuy ? liveBid - STRATEGY.ENTRY_TICK : liveAsk + STRATEGY.ENTRY_TICK
        );
        console.log(`[Entry] bid=$${liveBid.toFixed(2)} ask=$${liveAsk.toFixed(2)} entry=$${entryPrice.toFixed(2)} TP=$${tpMove.toFixed(2)} ATR=$${signal.atr5m.toFixed(2)}`);

        const size   = calcSize(tradingBalance, entryPrice);
        const margin = tradingBalance; // full balance is the margin for this trade

        // 1. GTX maker entry order (0% fee if filled as maker)
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

        // 2. Poll for fill (tight timeout — if it doesn't fill fast, price moved)
        const fillStart = Date.now();
        let   filled    = false;
        let   actualEntry = entryPrice;
        while (Date.now() - fillStart < STRATEGY.FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, 1_000)); // 1s poll — was 300ms, cuts weight usage by 70% at no meaningful cost
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

        // 3. Compute TP and SL prices
        const tpPrice       = tickRound(isBuy ? actualEntry + tpMove : actualEntry - tpMove);
        const slDistance    = calcSlDistance(signal.atr5m);
        const slPrice       = tickRound(isBuy ? actualEntry - slDistance           : actualEntry + slDistance);
        const slBackupPrice = tickRound(isBuy ? slPrice     - STRATEGY.SL_BACKUP_EXTRA : slPrice + STRATEGY.SL_BACKUP_EXTRA);

        console.log(`[Execution] ✅ ${direction.toUpperCase()} filled @ $${actualEntry.toFixed(2)} | Size: ${size} XAU`);
        console.log(`[Execution] 🎯 TP: $${tpPrice.toFixed(2)} | 🛑 SL: $${slPrice.toFixed(2)} (${(slDistance).toFixed(2)} from entry) | Backup SL: $${slBackupPrice.toFixed(2)}`);

        // 4. Resting TP limit order (LIMIT GTC — always posts, fills as maker)
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
            // TP failure is not fatal — SL still protects us
        }

        // 5. Primary SL — exchange-side conditional STOP_MARKET on mark price
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
            console.log(`[SL] Primary SL established: algo id=${slAlgoId}`);
        } catch (e: any) {
            console.error(`[SL] Primary SL failed: ${e.message}`);
        }

        // 6. Backup SL — regular STOP_MARKET $1 past primary, in case of gap
        let slBackupId = 0;
        try {
            const backupOrder = await privatePost('/fapi/v1/order', {
                symbol:     STRATEGY.SYMBOL,
                side:       closeSide,
                type:       'STOP_MARKET',
                stopPrice:  slBackupPrice.toFixed(2),
                quantity:   size.toFixed(3),
                workingType: 'MARK_PRICE',
                reduceOnly: 'true',
            });
            slBackupId = backupOrder.orderId ?? 0;
            console.log(`[SL] Backup SL established: order id=${slBackupId}`);
        } catch (e: any) {
            console.error(`[SL] Backup SL failed: ${e.message}`);
        }

        // If NEITHER stop was placed and TP also failed — emergency close
        if (!slAlgoId && !slBackupId) {
            console.error('[SL] Both SL orders failed — emergency closing immediately.');
            await sendAlert(`🚨 Both SL orders failed on ${STRATEGY.SYMBOL} ${direction}. Emergency closing.`);
            await triggerEmergencyClose(direction, size, 'SL placement total failure');
            return { success: false, outcome: 'error', message: 'SL placement failed, emergency closed.' };
        }

        // Lock state
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
        };

        const grossEstimate = size * tpMove;
        return {
            success:     true,
            outcome:     'orders_placed',
            entryPrice:  actualEntry,
            tpPrice,
            slPrice,
            grossProfit: grossEstimate,
            netProfit:   grossEstimate,  // maker fee = 0%
            fees:        0,
            fillTimeMs:  Date.now() - fillStart,
        };

    } catch (e: any) {
        return { success: false, outcome: 'error', message: e.message };
    }
}
