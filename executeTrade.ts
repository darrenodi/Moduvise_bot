import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
// Gold (XAU/USDC) on Hyperliquid — 25x leverage, maker-only entries.
// TP: $2.00 price move from fill. SL: scaled by actual margin dollar risk.

const STRATEGY = {
    SYMBOL:        MARKET_SYMBOL,   // 'GOLD/USDC:USDC'
    LEVERAGE:      25,
    TP_MOVE:       2.00,            // $2.00 TP (fixed)
    MAKER_FEE:     0.000144,        // 0.0144% maker fee
    MIN_BALANCE:   1.50,            // Min $1.50 USDC to attempt a trade

    // ── POST-ONLY ENTRY PARAMS ────────────────────────────────────────────
    // We want to sit in the book as maker. We place at best bid (long) or
    // best ask (short). If unfilled within FILL_MAX_TRIES × FILL_INTERVAL_MS,
    // we chase by re-quoting closer to mid-price, up to MAX_CHASE_STEPS times.
    FILL_INTERVAL_MS: 800,
    FILL_MAX_TRIES:   10,           // 8 seconds per quote before re-pricing
    MAX_CHASE_STEPS:  5,            // Max times we re-quote to chase fill
    CHASE_STEP_USD:   0.10,         // Move limit price $0.10 toward mid each chase

    // ── SCALED SL THRESHOLDS ──────────────────────────────────────────────
    // Micro risk (margin * SL% loss < MICRO_THRESHOLD): loose SL at 50% of liq distance.
    // Capitalized risk (≥ CAPITAL_THRESHOLD): tight SL to protect capital.
    MICRO_THRESHOLD:   20,          // < $20 margin at risk → loose SL
    CAPITAL_THRESHOLD: 200,         // ≥ $200 margin at risk → tight SL

    // Loose SL: 50% of liquidation distance (liq = 4% at 25x, so loose SL = 2% move)
    LOOSE_SL_PCT:   0.02,
    // Tight SL: 0.5% price move — aggressive capital protection for large positions
    TIGHT_SL_PCT:   0.005,
    // Mid SL: 1% for balances between micro and capital thresholds
    MID_SL_PCT:     0.01,

    GOLD_TICK:      0.01,           // Gold price precision: $0.01
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome = 'orders_placed' | 'cancelled' | 'skipped' | 'error';

export interface TradeResult {
    success:     boolean;
    outcome:     TradeOutcome;
    entryPrice?: number;
    tpPrice?:    number;
    slPrice?:    number;
    slType?:     'loose' | 'mid' | 'tight';
    netProfit?:  number;
    fees?:       number;
    message?:    string;
}

// ─── EXCHANGE ────────────────────────────────────────────────────────────────

const exchange = new (ccxt as any).hyperliquid({
    apiKey:          process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    privateKey:      process.env.HYPERLIQUID_API_SECRET     ?? '',
    walletAddress:   process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    timeout:         15_000,
    enableRateLimit: true,
    options:         { defaultType: 'swap' },
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

export async function getAvailableBalance(): Promise<number> {
    try {
        const bal  = await exchange.fetchBalance({ type: 'swap', user: process.env.HYPERLIQUID_WALLET_ADDRESS });
        const usdc = bal['USDC'] ?? bal['USD'];
        return Number(usdc?.free ?? usdc?.total ?? 0);
    } catch (e: any) {
        console.error(`[Execute] Balance error: ${e.message}`);
        return 0;
    }
}

export async function hasOpenPosition(): Promise<boolean> {
    try {
        const positions = await exchange.fetchPositions([STRATEGY.SYMBOL]);
        return positions.some((p: any) =>
            Number(p.info?.holdVol ?? p.info?.positionAmt ?? p.contracts ?? 0) > 0
        );
    } catch (e: any) {
        console.error(`[Execute] Position check error: ${e.message}`);
        return false;
    }
}

function extractId(order: any): string {
    if (!order) return '';
    if (typeof order.id === 'string') return order.id;
    if (typeof order.id === 'number') return String(order.id);
    return String(order.info?.oid ?? order.info?.orderId ?? '');
}

/** Round to Gold tick size ($0.01). */
function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

/**
 * Calculate position size in Gold oz.
 * Uses 95% of balance to leave a buffer for margin + fees.
 */
function calcSize(balance: number, price: number): number {
    const usable  = balance * 0.95;
    const posVal  = usable * STRATEGY.LEVERAGE;
    const raw     = posVal / price;
    // Floor to 2 decimal places (Gold minimum lot is typically 0.01 oz on HL)
    const floored = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

/**
 * Determine SL price using scaled dollar-risk logic.
 * 
 * The dollar risk is the margin allocated × the SL percentage.
 * - Micro (< $20 margin):    loose SL = 50% of liq distance (2% move)
 * - Mid   ($20–$200 margin): mid SL   = 1% move
 * - Capital (≥ $200 margin): tight SL = 0.5% move (capital preservation mode)
 */
function calcScaledSL(
    entryPrice: number,
    balance: number,
    isBuy: boolean
): { slPrice: number; slType: 'loose' | 'mid' | 'tight'; slPct: number } {

    let slPct: number;
    let slType: 'loose' | 'mid' | 'tight';

    if (balance < STRATEGY.MICRO_THRESHOLD) {
        slPct  = STRATEGY.LOOSE_SL_PCT;  // 2% — loose, pocket change
        slType = 'loose';
    } else if (balance < STRATEGY.CAPITAL_THRESHOLD) {
        slPct  = STRATEGY.MID_SL_PCT;    // 1% — balanced
        slType = 'mid';
    } else {
        slPct  = STRATEGY.TIGHT_SL_PCT;  // 0.5% — tight, capital preservation
        slType = 'tight';
    }

    const slMove = entryPrice * slPct;
    const slPrice = isBuy
        ? tickRound(entryPrice - slMove)
        : tickRound(entryPrice + slMove);

    const dollarRiskPerOz = entryPrice * slPct;
    const size = calcSize(balance, entryPrice);
    const dollarRisk = size * dollarRiskPerOz / STRATEGY.LEVERAGE;

    console.log(`[Execute] SL type: ${slType.toUpperCase()} | SL%: ${(slPct * 100).toFixed(2)}% | Est. $ risk: $${dollarRisk.toFixed(4)}`);

    return { slPrice, slType, slPct };
}

// ─── POST-ONLY ENTRY WITH FILL CHASING ───────────────────────────────────────
/**
 * Place a Post-Only (maker) limit order and poll for fill.
 * If unfilled within FILL_MAX_TRIES × FILL_INTERVAL_MS, re-quote
 * CHASE_STEP_USD closer to the opposite best price.
 * Returns { filled: true, orderId, fillPrice } or { filled: false }.
 *
 * Strategy:
 *   LONG:  start at bestBid → chase up toward bestAsk (never crossing it)
 *   SHORT: start at bestAsk → chase down toward bestBid (never crossing it)
 */
async function placePostOnlyEntry(
    side: 'buy' | 'sell',
    size: number,
    isBuy: boolean,
    initialBid: number,
    initialAsk: number
): Promise<{ filled: boolean; orderId: string; fillPrice: number }> {

    let currentPrice = isBuy ? initialBid : initialAsk;
    let chaseStep = 0;
    let lastOrderId = '';

    for (chaseStep = 0; chaseStep <= STRATEGY.MAX_CHASE_STEPS; chaseStep++) {
        currentPrice = tickRound(currentPrice);

        // Safety: never cross the spread
        if (isBuy  && currentPrice >= initialAsk)  currentPrice = tickRound(initialAsk - STRATEGY.GOLD_TICK);
        if (!isBuy && currentPrice <= initialBid)  currentPrice = tickRound(initialBid + STRATEGY.GOLD_TICK);

        console.log(`[Execute] PostOnly ${side.toUpperCase()} @ $${currentPrice.toFixed(2)} (chase step ${chaseStep}/${STRATEGY.MAX_CHASE_STEPS})`);

        let orderId = '';
        try {
            const order = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', side, size, currentPrice,
                { timeInForce: 'Alo', postOnly: true }   // ALO = Add Liquidity Only = Post-Only
            );
            orderId = extractId(order);
            lastOrderId = orderId;
            console.log(`[Execute] ✅ PostOnly order placed: ${orderId}`);
        } catch (e: any) {
            console.warn(`[Execute] PostOnly place failed: ${e.message}`);
            // If crossed spread, back off and retry
            if (/would.?cross|taker|reject/i.test(e.message)) {
                currentPrice = isBuy
                    ? tickRound(currentPrice - STRATEGY.CHASE_STEP_USD)
                    : tickRound(currentPrice + STRATEGY.CHASE_STEP_USD);
            }
            continue;
        }

        // ── POLL FOR FILL ──────────────────────────────────────────────────
        for (let poll = 0; poll < STRATEGY.FILL_MAX_TRIES; poll++) {
            await new Promise(r => setTimeout(r, STRATEGY.FILL_INTERVAL_MS));
            try {
                const orderState = await exchange.fetchOrder(orderId, STRATEGY.SYMBOL);
                if (orderState.status === 'closed' || orderState.filled > 0) {
                    const fillPrice = Number(orderState.average ?? orderState.price ?? currentPrice);
                    console.log(`[Execute] ✅ Fill confirmed @ $${fillPrice.toFixed(2)}`);
                    return { filled: true, orderId, fillPrice };
                }
                if (orderState.status === 'canceled') break;
            } catch { /* order might not be indexed yet — keep polling */ }
        }

        // ── UNFILLED — cancel and chase ────────────────────────────────────
        console.log(`[Execute] Order unfilled after ${STRATEGY.FILL_MAX_TRIES * STRATEGY.FILL_INTERVAL_MS / 1000}s — cancelling and chasing`);
        try { await exchange.cancelOrder(orderId, STRATEGY.SYMBOL); } catch { /* already gone */ }

        // Chase: move price toward mid by CHASE_STEP_USD
        currentPrice = isBuy
            ? tickRound(currentPrice + STRATEGY.CHASE_STEP_USD)
            : tickRound(currentPrice - STRATEGY.CHASE_STEP_USD);
    }

    // All chase steps exhausted — give up
    console.log(`[Execute] ❌ Could not fill after ${STRATEGY.MAX_CHASE_STEPS} chase steps. Cancelling.`);
    if (lastOrderId) {
        try { await exchange.cancelOrder(lastOrderId, STRATEGY.SYMBOL); } catch { /* best effort */ }
    }
    return { filled: false, orderId: '', fillPrice: 0 };
}

// ─── MAIN EXECUTION ───────────────────────────────────────────────────────────

export async function executeHyperliquidTrade(signal: GeneratedSignal): Promise<TradeResult> {
    if (signal.direction === 'neutral') {
        return { success: false, outcome: 'skipped', message: 'Neutral signal' };
    }

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'buy'  : 'sell';
    const closeSide = isBuy ? 'sell' : 'buy';

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] GOLD ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── 1. POSITION GUARD ──────────────────────────────────────────────
        if (await hasOpenPosition()) {
            console.log(`[Execute] 🛑 Position already open. Skipping.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // ── 2. BALANCE CHECK ───────────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC`);
        if (balance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Low balance: $${balance.toFixed(4)} USDC` };
        }

        // ── 3. LIVE ORDER BOOK ─────────────────────────────────────────────
        const liveOb  = await exchange.fetchOrderBook(STRATEGY.SYMBOL, 10);
        const bestBid = tickRound(Number(liveOb.bids[0]?.[0] ?? signal.market_price));
        const bestAsk = tickRound(Number(liveOb.asks[0]?.[0] ?? signal.market_price));
        const spread  = bestAsk - bestBid;

        console.log(`[Execute] Live BBO: Bid $${bestBid.toFixed(2)} | Ask $${bestAsk.toFixed(2)} | Spread $${spread.toFixed(2)}`);

        // ── 4. LEVERAGE ────────────────────────────────────────────────────
        try {
            await exchange.setLeverage(STRATEGY.LEVERAGE, STRATEGY.SYMBOL, { marginMode: 'isolated' });
        } catch (e: any) {
            if (!/already|same|6007/i.test(e.message ?? '')) {
                console.warn(`[Execute] Leverage warn: ${e.message}`);
            }
        }

        // ── 5. CALCULATE SIZE ──────────────────────────────────────────────
        const refPrice = isBuy ? bestBid : bestAsk;
        const size     = calcSize(balance, refPrice);
        const posVal   = size * refPrice;

        console.log(`[Execute] Size: ${size} oz | Position: $${posVal.toFixed(2)} | Balance: $${balance.toFixed(4)}`);

        // ── 6. POST-ONLY ENTRY WITH FILL CHASING ──────────────────────────
        const { filled, fillPrice } = await placePostOnlyEntry(side, size, isBuy, bestBid, bestAsk);

        if (!filled) {
            console.log(`[Execute] ❌ Entry cancelled — could not fill post-only order.`);
            return { success: false, outcome: 'cancelled', message: 'PostOnly entry unfilled after chase exhaustion' };
        }

        // ── 7. TP & SCALED SL PRICES ───────────────────────────────────────
        const tpPrice = tickRound(isBuy
            ? fillPrice + STRATEGY.TP_MOVE
            : fillPrice - STRATEGY.TP_MOVE
        );

        const { slPrice, slType, slPct } = calcScaledSL(fillPrice, balance, isBuy);

        const grossProfit = size * STRATEGY.TP_MOVE;
        const fees        = posVal * STRATEGY.MAKER_FEE * 2;  // entry + exit (both maker)
        const netProfit   = grossProfit - fees;

        console.log(`[Execute] Fill=$${fillPrice.toFixed(2)} | TP=$${tpPrice.toFixed(2)} | SL=$${slPrice.toFixed(2)} (${slType})`);
        console.log(`[Execute] Gross/win=$${grossProfit.toFixed(4)} | Fees=$${fees.toFixed(4)} | Net=$${netProfit.toFixed(4)}`);

        // ── 8. TAKE PROFIT — reduceOnly limit (maker exit) ────────────────
        console.log(`[Execute] Placing TP limit @ $${tpPrice.toFixed(2)}...`);
        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, tpPrice,
                { timeInForce: 'Alo', reduceOnly: true }
            );
            console.log(`[Execute] ✅ TP on-chain: ${extractId(tpOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
        }

        // ── 9. STOP LOSS — stop-limit order ───────────────────────────────
        // SL limit placed $0.50 past trigger to ensure fill (Gold spread is tight)
        console.log(`[Execute] Placing SL trigger @ $${slPrice.toFixed(2)} [${slType}]...`);
        try {
            const slLimitPrice = tickRound(isBuy
                ? slPrice - 0.50
                : slPrice + 0.50
            );
            const slOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, slLimitPrice,
                { triggerPrice: slPrice, reduceOnly: true }
            );
            console.log(`[Execute] ✅ SL on-chain: ${extractId(slOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] SL failed (non-fatal): ${e.message}`);
        }

        // ── 10. DONE ───────────────────────────────────────────────────────
        console.log(`[Execute] ✅ Gold trade live. TP=$${tpPrice.toFixed(2)} SL=$${slPrice.toFixed(2)} (${slType}). Returning.`);
        console.log(`${'─'.repeat(65)}\n`);

        return {
            success: true, outcome: 'orders_placed',
            entryPrice: fillPrice, tpPrice, slPrice, slType,
            netProfit, fees,
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal execution error: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}