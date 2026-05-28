import ccxt from 'ccxt';
import type { GeneratedSignal } from './signals.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── STRATEGY CONFIG ──────────────────────────────────────────────────────────

const STRATEGY = {
    SYMBOL: 'BTC/USDC:USDC',
    LEVERAGE: 40,

    // TP: dynamic from signal ($50–$80)
    // SL: $300 adverse move — survivable on $13.89 balance
    SL_PRICE_MOVE: 300,

    // Hyperliquid maker fee per leg: 0.015%
    MAKER_FEE: 0.00015,

    /**
     * MAKER ENTRY OFFSET
     * To guarantee PostOnly (maker) fill we place the entry INSIDE the book:
     *   Long  → limit price = market_price - ENTRY_OFFSET  (sits below best ask)
     *   Short → limit price = market_price + ENTRY_OFFSET  (sits above best bid)
     *
     * $3 offset = ~0.004% on $73k BTC. Small enough not to miss trades,
     * large enough to never cross the spread on a slow tick.
     */
    ENTRY_OFFSET: 3,

    // Fill window: 90 seconds. If not filled, cancel and recycle.
    // Prevents sitting dead as the market moves away.
    FILL_CHECK_INTERVAL_MS: 3_000,   // poll every 3s
    FILL_MAX_ATTEMPTS: 30,           // 30 × 3s = 90s total window

    /**
     * MAX HOLD TIME: 10 minutes (600 000ms)
     * After this, cancel everything and close position at market.
     * Addresses the "6-hour sitting trade" problem.
     */
    MAX_HOLD_MS: 10 * 60 * 1000,    // 10 minutes

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
    // Offset INTO the book so the order rests and never crosses
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
    const btcVolume = positionValue / price;
    return Math.max(0.001, parseFloat(btcVolume.toFixed(4)));
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
            STRATEGY.SYMBOL,
            'market',
            closeSide,
            contractSize,
            undefined,
            { reduceOnly: true }
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
    const side   = isBuy ? 'buy' : 'sell';
    const label  = isBuy ? 'LONG 📈' : 'SHORT 📉';

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] ${label} | Market: $${market_price.toFixed(2)} | Regime: ${regime}`);
    console.log(`[Execute] Reason: ${reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── STEP 1: NO EXISTING POSITION ─────────────────────────────────
        const existingPos = await getOpenPosition(STRATEGY.SYMBOL);
        if (existingPos) {
            console.log(`[Execute] 🛑 Position already open. Waiting for resolution.`);
            return { success: false, outcome: 'skipped', message: 'Position already active' };
        }

        // ── STEP 2: BALANCE CHECK ─────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC`);

        if (balance < STRATEGY.MIN_BALANCE) {
            console.log(`[Execute] ❌ Balance $${balance.toFixed(4)} below minimum $${STRATEGY.MIN_BALANCE}`);
            return { success: false, outcome: 'skipped', message: `Balance too low: $${balance.toFixed(4)}` };
        }

        // ── STEP 3: CALCULATE PRICES & SIZES ─────────────────────────────
        const entryPrice     = makerEntryPrice(market_price, tradeDirection);
        const tpPrice        = calcTPPrice(entryPrice, tradeDirection, target_move);
        const slPrice        = calcSLPrice(entryPrice, tradeDirection);
        const contractSize   = calcContractSize(balance, entryPrice);
        const positionValue  = contractSize * entryPrice;
        const grossProfit    = contractSize * target_move;
        const fees           = positionValue * STRATEGY.MAKER_FEE * 2;  // entry maker + exit maker
        const netProfit      = grossProfit - fees;

        console.log(`[Execute] Entry (maker):  $${entryPrice.toFixed(2)}  (offset -${STRATEGY.ENTRY_OFFSET} from $${market_price.toFixed(2)})`);
        console.log(`[Execute] TP (maker):     $${tpPrice.toFixed(2)}  (+$${target_move} move)`);
        console.log(`[Execute] SL (trigger):   $${slPrice.toFixed(2)}  (-$${STRATEGY.SL_PRICE_MOVE} move)`);
        console.log(`[Execute] Size:           ${contractSize} BTC ($${positionValue.toFixed(2)} notional at ${STRATEGY.LEVERAGE}x)`);
        console.log(`[Execute] Expected net:   $${netProfit.toFixed(4)}  (gross $${grossProfit.toFixed(4)} − fees $${fees.toFixed(4)})`);

        // ── STEP 4: PLACE MAKER ENTRY ORDER (PostOnly) ────────────────────
        let entryOrder: any;
        let usedLinkedOrders = false;

        try {
            entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL,
                'limit',
                side,
                contractSize,
                entryPrice,
                {
                    timeInForce: 'PostOnly',    // Rejected by exchange if it would cross — never taker
                    takeProfitPrice: tpPrice,
                    takeProfitType: 'limit',
                    stopLossPrice: slPrice,
                    stopLossType: 'market',
                    reduceOnly: false,
                }
            );
            usedLinkedOrders = true;
            console.log(`[Execute] ✅ Maker entry placed with linked TP/SL`);
        } catch {
            // If linked orders aren't supported, plain PostOnly entry
            console.log(`[Execute] Linked TP/SL unsupported. Placing plain maker entry...`);
            entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL,
                'limit',
                side,
                contractSize,
                entryPrice,
                { timeInForce: 'PostOnly' }
            );
        }

        const entryOrderId = getCleanOrderId(entryOrder);
        console.log(`[Execute] Entry order ID: ${entryOrderId}`);

        // ── STEP 5: WAIT FOR FILL (90s window) ───────────────────────────
        console.log(`[Execute] Waiting for maker fill (max ${STRATEGY.FILL_MAX_ATTEMPTS * STRATEGY.FILL_CHECK_INTERVAL_MS / 1000}s)...`);

        let filled = false;
        for (let i = 0; i < STRATEGY.FILL_MAX_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, STRATEGY.FILL_CHECK_INTERVAL_MS));

            const pos = await getOpenPosition(STRATEGY.SYMBOL);
            if (pos) {
                filled = true;
                console.log(`[Execute] ✅ Filled at check ${i + 1}`);
                break;
            }

            if ((i + 1) % 10 === 0) {
                console.log(`[Execute] Still waiting... ${((i + 1) * STRATEGY.FILL_CHECK_INTERVAL_MS / 1000).toFixed(0)}s elapsed`);
            }
        }

        // ── STEP 6: CANCEL IF NOT FILLED ─────────────────────────────────
        if (!filled) {
            console.log(`[Execute] ⏱️ No fill after ${STRATEGY.FILL_MAX_ATTEMPTS * STRATEGY.FILL_CHECK_INTERVAL_MS / 1000}s. Cancelling.`);
            try {
                await exchange.cancelOrder(entryOrderId, STRATEGY.SYMBOL);
            } catch {
                await exchange.cancelAllOrders(STRATEGY.SYMBOL);
            }
            return { success: false, outcome: 'cancelled', message: 'Entry not filled within 90s' };
        }

        // ── STEP 7: MANUAL TP / SL (if linked orders weren't used) ───────
        let tpOrderId = '';
        let slOrderId = '';

        if (!usedLinkedOrders) {
            console.log(`[Execute] Placing maker TP @ $${tpPrice.toFixed(2)}...`);
            try {
                const tpOrder = await exchange.createOrder(
                    STRATEGY.SYMBOL,
                    'limit',
                    isBuy ? 'sell' : 'buy',
                    contractSize,
                    tpPrice,
                    {
                        timeInForce: 'PostOnly',   // TP is also maker
                        reduceOnly: true,
                    }
                );
                tpOrderId = getCleanOrderId(tpOrder);
                console.log(`[Execute] TP placed: ${tpOrderId}`);
            } catch (e: any) {
                console.error(`[Execute] TP placement failed: ${e.message}`);
            }

            console.log(`[Execute] Placing market SL trigger @ $${slPrice.toFixed(2)}...`);
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
                console.log(`[Execute] SL placed: ${slOrderId}`);
            } catch (e: any) {
                console.error(`[Execute] SL placement failed: ${e.message}`);
            }
        }

        // ── STEP 8: MONITOR WITH 10-MINUTE HARD TIMEOUT ───────────────────
        console.log(`[Execute] Monitoring (max ${STRATEGY.MAX_HOLD_MS / 60000} min)...`);

        let resolved = false;
        let outcome: TradeResult['outcome'] = 'error';
        let cycles = 0;
        const holdStart = Date.now();

        while (!resolved) {
            await new Promise(r => setTimeout(r, STRATEGY.MONITOR_INTERVAL_MS));
            cycles++;

            // ── TIMEOUT CHECK ──────────────────────────────────────────
            const elapsed = Date.now() - holdStart;
            if (elapsed >= STRATEGY.MAX_HOLD_MS) {
                console.warn(`[Execute] ⏰ 10-min hold limit reached (${(elapsed / 1000).toFixed(0)}s). Force-closing.`);
                // Cancel bracket orders first
                try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
                await forceClosePosition(tradeDirection, contractSize);
                outcome = 'timeout_exit';
                resolved = true;
                break;
            }

            try {
                const pos = await getOpenPosition(STRATEGY.SYMBOL);

                if (!pos) {
                    // Determine which order closed the position
                    if (tpOrderId) {
                        try {
                            const tpCheck = await exchange.fetchOrder(tpOrderId, STRATEGY.SYMBOL);
                            if (tpCheck.status === 'closed') {
                                console.log(`\n[Execute] 🎯 TAKE PROFIT HIT @ $${tpPrice.toFixed(2)} | Net: +$${netProfit.toFixed(4)}`);
                                outcome = 'tp_hit';
                                resolved = true;
                                break;
                            }
                        } catch { /* linked order — not queryable */ }
                    }

                    if (slOrderId && !resolved) {
                        try {
                            const slCheck = await exchange.fetchOrder(slOrderId, STRATEGY.SYMBOL);
                            if (slCheck.status === 'closed') {
                                const loss = contractSize * STRATEGY.SL_PRICE_MOVE;
                                console.log(`\n[Execute] 🛑 STOP LOSS HIT @ $${slPrice.toFixed(2)} | Loss: -$${loss.toFixed(4)}`);
                                outcome = 'sl_hit';
                                resolved = true;
                                break;
                            }
                        } catch { /* ok */ }
                    }

                    if (!resolved) {
                        // Position gone without matching a known order — treat as TP
                        console.log(`[Execute] Position closed (linked order or manual).`);
                        outcome = 'tp_hit';
                        resolved = true;
                    }
                }

                if (cycles % 30 === 0) {
                    const secs = (elapsed / 1000).toFixed(0);
                    console.log(`[Execute] Still open... ${secs}s | TP=$${tpPrice.toFixed(2)} SL=$${slPrice.toFixed(2)}`);
                }

            } catch (e: any) {
                console.warn(`[Execute] Monitor lag: ${e.message}`);
            }
        }

        // ── STEP 9: CLEANUP ───────────────────────────────────────────────
        try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* already settled */ }

        const result: TradeResult = {
            success:     outcome === 'tp_hit',
            outcome,
            grossProfit: outcome === 'tp_hit' ? grossProfit : undefined,
            netProfit:   outcome === 'tp_hit' ? netProfit   : undefined,
            fees,
            entryPrice,
            exitPrice:   outcome === 'tp_hit' ? tpPrice : slPrice,
        };

        console.log(`[Execute] ✅ Cycle complete. Outcome: ${outcome.toUpperCase()}`);
        console.log(`${'─'.repeat(65)}\n`);

        return result;

    } catch (error: any) {
        console.error(`[Execute] ❌ Critical error:`, error.message || error);
        return { success: false, outcome: 'error', message: error.message };
    }
}
