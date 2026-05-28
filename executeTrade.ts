import ccxt from 'ccxt';
import type { GeneratedSignal } from './signals.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── STRATEGY CONFIG ──────────────────────────────────────────────────────────

const STRATEGY = {
    SYMBOL: 'BTC/USDC:USDC',
    LEVERAGE: 40,

    // SL: $300 adverse BTC move
    SL_PRICE_MOVE: 300,

    // Hyperliquid maker fee: 0.015% per leg
    MAKER_FEE: 0.00015,

    /**
     * MAKER ENTRY OFFSET — place limit $3 INSIDE the book so PostOnly never crosses.
     *   Long  → entry = market_price - 3  (rests below current ask)
     *   Short → entry = market_price + 3  (rests above current bid)
     */
    ENTRY_OFFSET: 3,

    // Fill window: 90s (30 polls × 3s each)
    FILL_CHECK_INTERVAL_MS: 3_000,
    FILL_MAX_ATTEMPTS: 30,

    // Hard max hold time: 10 minutes, then force-close at market
    MAX_HOLD_MS: 10 * 60 * 1000,

    MONITOR_INTERVAL_MS: 2_000,
    MIN_BALANCE: 2.0,
};

// ─── EXCHANGE ─────────────────────────────────────────────────────────────────

const exchange = new ccxt.hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    secret:        process.env.HYPERLIQUID_API_SECRET || '',
    privateKey:    process.env.HYPERLIQUID_API_SECRET,
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    options: { defaultType: 'swap', recvWindow: 10000 },
    timeout: 15_000,
    enableRateLimit: true,
});

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TradeResult {
    success: boolean;
    outcome: 'tp_hit' | 'sl_hit' | 'timeout_exit' | 'cancelled' | 'error' | 'skipped';
    grossProfit?: number;
    netProfit?: number;
    fees?: number;
    entryPrice?: number;
    exitPrice?: number;
    message?: string;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function makerEntryPrice(marketPrice: number, direction: 'long' | 'short'): number {
    return direction === 'long'
        ? marketPrice - STRATEGY.ENTRY_OFFSET
        : marketPrice + STRATEGY.ENTRY_OFFSET;
}

function calcTPPrice(entry: number, direction: 'long' | 'short', move: number): number {
    return direction === 'long' ? entry + move : entry - move;
}

function calcSLPrice(entry: number, direction: 'long' | 'short'): number {
    return direction === 'long'
        ? entry - STRATEGY.SL_PRICE_MOVE
        : entry + STRATEGY.SL_PRICE_MOVE;
}

function calcContractSize(balance: number, price: number): number {
    const positionValue = balance * STRATEGY.LEVERAGE;
    return Math.max(0.001, parseFloat((positionValue / price).toFixed(4)));
}

async function getAvailableBalance(): Promise<number> {
    try {
        const balance = await exchange.fetchBalance({
            user: process.env.HYPERLIQUID_WALLET_ADDRESS,
        });
        const usdc = balance['USDC'] || balance['USD'];
        return parseFloat((usdc?.free || usdc?.total || 0).toString());
    } catch (e: any) {
        console.error(`[Execute] Balance fetch error: ${e.message}`);
        return 0;
    }
}

async function getOpenPosition(symbol: string): Promise<any | null> {
    try {
        const positions = await exchange.fetchPositions([symbol]);
        const active = positions.find(
            (p: any) =>
                p.symbol === symbol &&
                p.contracts !== undefined &&
                parseFloat(p.contracts.toString()) > 0
        );
        return active || null;
    } catch (e: any) {
        console.error(`[Execute] Position fetch error: ${e.message}`);
        return null;
    }
}

function getCleanOrderId(order: any): string {
    if (!order) return '';
    if (typeof order.id === 'string') return order.id;
    if (typeof order.id === 'number') return String(order.id);
    if (order.info?.oid) return String(order.info.oid);
    if (order.info?.orderId) return String(order.info.orderId);
    return JSON.stringify(order.id || '');
}

async function forceClosePosition(direction: 'long' | 'short', contractSize: number): Promise<void> {
    const closeSide = direction === 'long' ? 'sell' : 'buy';
    console.log(`[Execute] 🚨 Force-closing position (market ${closeSide})...`);
    try {
        await exchange.createOrder(
            STRATEGY.SYMBOL, 'market', closeSide, contractSize,
            undefined, { reduceOnly: true }
        );
        console.log(`[Execute] Force close submitted.`);
    } catch (e: any) {
        console.error(`[Execute] Force close failed: ${e.message}`);
    }
}

// ─── MAIN EXECUTION ───────────────────────────────────────────────────────────

export async function executeHyperliquidTrade(signal: GeneratedSignal): Promise<TradeResult> {
    const { direction, market_price, reasoning, regime, target_move } = signal;

    if (direction === 'neutral') {
        return { success: false, outcome: 'skipped', message: 'Neutral signal' };
    }

    const tradeDirection = direction as 'long' | 'short';
    const isBuy = tradeDirection === 'long';
    const side  = isBuy ? 'buy' : 'sell';
    const label = isBuy ? 'LONG 📈' : 'SHORT 📉';

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] ${label} | Market: $${market_price.toFixed(2)} | Regime: ${regime}`);
    console.log(`[Execute] Reason: ${reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── STEP 1: NO EXISTING POSITION ─────────────────────────────────
        const existingPos = await getOpenPosition(STRATEGY.SYMBOL);
        if (existingPos) {
            console.log(`[Execute] 🛑 Position already open. Skipping.`);
            return { success: false, outcome: 'skipped', message: 'Position already active' };
        }

        // ── STEP 2: BALANCE CHECK ─────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC`);
        if (balance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Balance too low: $${balance.toFixed(4)}` };
        }

        // ── STEP 3: CALCULATE PRICES & SIZES ─────────────────────────────
        const entryPrice    = makerEntryPrice(market_price, tradeDirection);
        const tpPrice       = calcTPPrice(entryPrice, tradeDirection, target_move);
        const slPrice       = calcSLPrice(entryPrice, tradeDirection);
        const contractSize  = calcContractSize(balance, entryPrice);
        const positionValue = contractSize * entryPrice;
        const grossProfit   = contractSize * target_move;
        const fees          = positionValue * STRATEGY.MAKER_FEE * 2; // both legs maker
        const netProfit     = grossProfit - fees;

        console.log(`[Execute] Entry (PostOnly): $${entryPrice.toFixed(2)}  (mkt $${market_price.toFixed(2)} − offset $${STRATEGY.ENTRY_OFFSET})`);
        console.log(`[Execute] TP (PostOnly):    $${tpPrice.toFixed(2)}  (+$${target_move.toFixed(2)} move)`);
        console.log(`[Execute] SL (market trig): $${slPrice.toFixed(2)}  (-$${STRATEGY.SL_PRICE_MOVE} move)`);
        console.log(`[Execute] Size: ${contractSize} BTC | Notional: $${positionValue.toFixed(2)} | Net: $${netProfit.toFixed(4)}`);

        // ── STEP 4: PLAIN PostOnly ENTRY — no linked TP/SL params ────────
        // Linked takeProfitPrice/stopLossPrice via CCXT produce inverted
        // trigger conditions on Hyperliquid. Always bracket manually after fill.
        let entryOrder: any;
        try {
            entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL,
                'limit',
                side,
                contractSize,
                entryPrice,
                { timeInForce: 'PostOnly' }   // pure maker — exchange rejects if it would cross
            );
        } catch (e: any) {
            console.error(`[Execute] Entry order failed: ${e.message}`);
            return { success: false, outcome: 'error', message: e.message };
        }

        const entryOrderId = getCleanOrderId(entryOrder);
        console.log(`[Execute] Entry order ID: ${entryOrderId}`);

        // ── STEP 5: WAIT FOR FILL (90s) ───────────────────────────────────
        console.log(`[Execute] Waiting for maker fill (max 90s)...`);
        let filled = false;

        for (let i = 0; i < STRATEGY.FILL_MAX_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, STRATEGY.FILL_CHECK_INTERVAL_MS));
            const pos = await getOpenPosition(STRATEGY.SYMBOL);
            if (pos) {
                filled = true;
                console.log(`[Execute] ✅ Position confirmed at check ${i + 1} (~${(i + 1) * 3}s)`);
                break;
            }
            if ((i + 1) % 5 === 0) {
                console.log(`[Execute] Waiting... ${(i + 1) * 3}s / 90s`);
            }
        }

        // ── STEP 6: CANCEL IF NOT FILLED ─────────────────────────────────
        if (!filled) {
            console.log(`[Execute] ⏱️ No fill after 90s. Cancelling entry.`);
            try { await exchange.cancelOrder(entryOrderId, STRATEGY.SYMBOL); }
            catch { await exchange.cancelAllOrders(STRATEGY.SYMBOL); }
            return { success: false, outcome: 'cancelled', message: 'Entry not filled within 90s' };
        }

        // ── STEP 7: PLACE TP AND SL AFTER CONFIRMED FILL ─────────────────
        // TP: PostOnly limit on the reduce side
        // SL: market trigger on the reduce side
        // Both placed AFTER fill so trigger conditions reflect actual position.
        let tpOrderId = '';
        let slOrderId = '';

        // TP — maker limit, reduce only
        console.log(`[Execute] Placing TP @ $${tpPrice.toFixed(2)} (PostOnly, reduceOnly)...`);
        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL,
                'limit',
                isBuy ? 'sell' : 'buy',
                contractSize,
                tpPrice,
                {
                    timeInForce: 'PostOnly',
                    reduceOnly: true,
                }
            );
            tpOrderId = getCleanOrderId(tpOrder);
            console.log(`[Execute] TP order ID: ${tpOrderId}`);
        } catch (e: any) {
            // TP failure is recoverable — SL will still protect capital
            console.error(`[Execute] TP placement failed: ${e.message}`);
        }

        // SL — market trigger (taker on SL is acceptable — it's emergency protection)
        console.log(`[Execute] Placing SL trigger @ $${slPrice.toFixed(2)} (market, reduceOnly)...`);
        try {
            const slOrder = await exchange.createOrder(
                STRATEGY.SYMBOL,
                'market',
                isBuy ? 'sell' : 'buy',
                contractSize,
                undefined,
                {
                    triggerPrice: slPrice,
                    reduceOnly: true,
                    stopLoss: true,
                }
            );
            slOrderId = getCleanOrderId(slOrder);
            console.log(`[Execute] SL order ID: ${slOrderId}`);
        } catch (e: any) {
            // SL failure is serious — log loudly
            console.error(`[Execute] ⚠️ SL PLACEMENT FAILED: ${e.message}. Position is unprotected.`);
        }

        // ── STEP 8: MONITOR WITH 10-MIN HARD TIMEOUT ─────────────────────
        console.log(`[Execute] Monitoring position (max 10 min)...`);
        let resolved = false;
        let outcome: TradeResult['outcome'] = 'error';
        const holdStart = Date.now();
        let cycles = 0;

        while (!resolved) {
            await new Promise(r => setTimeout(r, STRATEGY.MONITOR_INTERVAL_MS));
            cycles++;

            const elapsed = Date.now() - holdStart;

            // Hard timeout
            if (elapsed >= STRATEGY.MAX_HOLD_MS) {
                console.warn(`[Execute] ⏰ 10-min timeout. Force-closing position.`);
                try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
                await forceClosePosition(tradeDirection, contractSize);
                outcome = 'timeout_exit';
                resolved = true;
                break;
            }

            try {
                const pos = await getOpenPosition(STRATEGY.SYMBOL);

                if (!pos) {
                    // Position is gone — determine TP vs SL
                    let determinedOutcome = false;

                    if (tpOrderId) {
                        try {
                            const tpCheck = await exchange.fetchOrder(tpOrderId, STRATEGY.SYMBOL);
                            if (tpCheck.status === 'closed' || tpCheck.status === 'filled') {
                                console.log(`\n[Execute] 🎯 TP HIT @ $${tpPrice.toFixed(2)} | Net: +$${netProfit.toFixed(4)}`);
                                outcome = 'tp_hit';
                                determinedOutcome = true;
                            }
                        } catch { /* linked / already consumed */ }
                    }

                    if (!determinedOutcome && slOrderId) {
                        try {
                            const slCheck = await exchange.fetchOrder(slOrderId, STRATEGY.SYMBOL);
                            if (slCheck.status === 'closed' || slCheck.status === 'filled') {
                                const loss = contractSize * STRATEGY.SL_PRICE_MOVE;
                                console.log(`\n[Execute] 🛑 SL HIT @ $${slPrice.toFixed(2)} | Loss: -$${loss.toFixed(4)}`);
                                outcome = 'sl_hit';
                                determinedOutcome = true;
                            }
                        } catch { /* ok */ }
                    }

                    if (!determinedOutcome) {
                        // Can't determine which closed it — default tp_hit (conservative)
                        console.log(`[Execute] Position closed (order indeterminate — assuming TP).`);
                        outcome = 'tp_hit';
                    }

                    resolved = true;
                }

                if (cycles % 30 === 0) {
                    console.log(`[Execute] Open... ${(elapsed / 1000).toFixed(0)}s | TP $${tpPrice.toFixed(2)} | SL $${slPrice.toFixed(2)}`);
                }

            } catch (e: any) {
                console.warn(`[Execute] Monitor poll error: ${e.message}`);
            }
        }

        // ── STEP 9: CLEANUP ───────────────────────────────────────────────
        try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* settled */ }

        const result: TradeResult = {
            success:     outcome === 'tp_hit',
            outcome,
            grossProfit: outcome === 'tp_hit' ? grossProfit : undefined,
            netProfit:   outcome === 'tp_hit' ? netProfit   : undefined,
            fees,
            entryPrice,
            exitPrice:   outcome === 'tp_hit' ? tpPrice : slPrice,
        };

        console.log(`[Execute] Cycle complete. Outcome: ${outcome.toUpperCase()}`);
        console.log(`${'─'.repeat(65)}\n`);
        return result;

    } catch (error: any) {
        console.error(`[Execute] ❌ Critical error:`, error.message || error);
        return { success: false, outcome: 'error', message: error.message };
    }
}
