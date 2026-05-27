import ccxt from 'ccxt';
import type { GeneratedSignal } from './signals.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── STRATEGY CONFIG ─────────────────────────────────────────────────────────

const STRATEGY = {
    // Asset
    SYMBOL: 'BTC/USDC:USDC',

    // Capital & leverage
    LEVERAGE: 40,

    // TP: $50 BTC move
    // At 40x on $10 balance: position = $400
    // BTC controlled = $400 / $81,000 = 0.004938 BTC
    // Profit = 0.004938 * $50 = $0.2469 gross
    TP_PRICE_MOVE: 50,             // Absolute $50 move

    // SL: $300 adverse BTC move
    // Loss = 0.004938 * $300 = $1.48 — survivable at $10 balance
    SL_PRICE_MOVE: 300,            // Absolute $300 move

    // Hyperliquid fees: 0.015% maker both legs
    // Round trip = 0.030% = $400 * 0.030% = $0.12
    MAKER_FEE: 0.00015,            // 0.015% per leg

    // Execution timing — Hyperliquid sub-second block times
    FILL_CHECK_INTERVAL_MS: 1000,  // Check fill every 1 second
    FILL_MAX_ATTEMPTS: 5,          // Cancel after 5 seconds if unfilled

    // Post-fill monitoring
    MONITOR_INTERVAL_MS: 2000,     // Check TP/SL every 2 seconds

    // Minimum balance to trade
    MIN_BALANCE: 2.0,
};

// ─── EXCHANGE INIT ────────────────────────────────────────────────────────────

/**
 * Hyperliquid CCXT Configuration:
 * - apiKey: Your MAIN L1 Web3 wallet address (0x...) — public, identifies your account
 * - secret: Private key of your AGENT wallet (trading-only restricted key, never your main wallet key)
 * - walletAddress: Same as apiKey — required explicitly by CCXT Hyperliquid class
 *
 * NEVER use your main wallet private key as secret.
 * Create a dedicated agent wallet in Hyperliquid dashboard → API Keys → Create Agent
 */
const exchange = new ccxt.hyperliquid({
    apiKey: process.env.HYPERLIQUID_WALLET_ADDRESS || '',      // Main wallet 0x address
    secret: process.env.HYPERLIQUID_API_SECRET || '',   // Agent wallet private key
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    options: {
        defaultType: 'swap',
        recvWindow: 10000,
    },
    timeout: 15000,    // 15s timeout — Tokyo VPS to Hyperliquid should be 2-3ms
    enableRateLimit: true,
});

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TradeResult {
    success: boolean;
    outcome: 'tp_hit' | 'sl_hit' | 'cancelled' | 'error' | 'skipped';
    grossProfit?: number;
    netProfit?: number;
    fees?: number;
    entryPrice?: number;
    exitPrice?: number;
    message?: string;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function calcTPPrice(entry: number, direction: 'long' | 'short'): number {
    return direction === 'long'
        ? entry + STRATEGY.TP_PRICE_MOVE
        : entry - STRATEGY.TP_PRICE_MOVE;
}

function calcSLPrice(entry: number, direction: 'long' | 'short'): number {
    return direction === 'long'
        ? entry - STRATEGY.SL_PRICE_MOVE
        : entry + STRATEGY.SL_PRICE_MOVE;
}

function calcContractSize(balance: number, price: number): number {
    const positionValue = balance * STRATEGY.LEVERAGE;
    // Hyperliquid BTC contract size = 1 BTC
    // Volume in BTC = positionValue / price
    const btcVolume = positionValue / price;
    // Round to 4 decimal places (Hyperliquid minimum precision)
    return Math.max(0.001, parseFloat(btcVolume.toFixed(4)));
}

async function getAvailableBalance(): Promise<number> {
    try {
        // Explicitly pass the 'user' parameter pointing to your main funding wallet
        const balance = await exchange.fetchBalance({ 
            'user': process.env.HYPERLIQUID_WALLET_ADDRESS 
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
        const active = positions.find((p: any) =>
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

// ─── MAIN EXECUTION ───────────────────────────────────────────────────────────

export async function executeHyperliquidTrade(signal: GeneratedSignal): Promise<TradeResult> {
    const { direction, market_price, reasoning, regime } = signal;
    // Guard: neutral should never reach here — narrow type
    if (direction === 'neutral') {
        return { success: false, outcome: 'skipped', message: 'Neutral signal' };
    }
    const tradeDirection = direction as 'long' | 'short';
    const isBuy = tradeDirection === 'long';
    const side = isBuy ? 'buy' : 'sell';
    const label = isBuy ? 'LONG 📈' : 'SHORT 📉';

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] ${label} | Price: $${market_price.toFixed(2)} | Regime: ${regime}`);
    console.log(`[Execute] Reason: ${reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── STEP 1: CHECK EXISTING POSITION ──────────────────────────────
        const existingPos = await getOpenPosition(STRATEGY.SYMBOL);
        if (existingPos) {
            console.log(`[Execute] 🛑 Position already open. Waiting for resolution.`);
            return { success: false, outcome: 'skipped', message: 'Position already active' };
        }

        // ── STEP 2: GET BALANCE ───────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC`);

        if (balance < STRATEGY.MIN_BALANCE) {
            console.log(`[Execute] ❌ Balance $${balance.toFixed(4)} below minimum $${STRATEGY.MIN_BALANCE}`);
            return { success: false, outcome: 'skipped', message: `Balance too low: $${balance.toFixed(4)}` };
        }

        // ── STEP 3: CALCULATE SIZES AND PRICES ───────────────────────────
        const entryPrice = market_price;
        const tpPrice = calcTPPrice(entryPrice, tradeDirection);
        const slPrice = calcSLPrice(entryPrice, tradeDirection);
        const contractSize = calcContractSize(balance, entryPrice);
        const positionValue = contractSize * entryPrice;
        const grossProfit = contractSize * STRATEGY.TP_PRICE_MOVE;
        const fees = positionValue * STRATEGY.MAKER_FEE * 2; // entry + exit
        const netProfit = grossProfit - fees;
        const grossLoss = contractSize * STRATEGY.SL_PRICE_MOVE;

        console.log(`[Execute] Entry:     $${entryPrice.toFixed(2)}`);
        console.log(`[Execute] TP:        $${tpPrice.toFixed(2)} (+$${STRATEGY.TP_PRICE_MOVE} move)`);
        console.log(`[Execute] SL:        $${slPrice.toFixed(2)} (-$${STRATEGY.SL_PRICE_MOVE} move)`);
        console.log(`[Execute] Size:      ${contractSize} BTC ($${positionValue.toFixed(2)} position at ${STRATEGY.LEVERAGE}x)`);
        console.log(`[Execute] Expected:  Gross $${grossProfit.toFixed(4)} | Fees $${fees.toFixed(4)} | Net $${netProfit.toFixed(4)}`);
        console.log(`[Execute] Max loss:  $${grossLoss.toFixed(4)}`);

        // ── STEP 4: SET LEVERAGE ──────────────────────────────────────────
        console.log(`[Execute] Setting ${STRATEGY.LEVERAGE}x leverage...`);
        try {
            await exchange.setLeverage(STRATEGY.LEVERAGE, STRATEGY.SYMBOL, {
                marginMode: 'isolated',
            });
        } catch (leverageError: any) {
            const msg = leverageError.message || '';
            // Hyperliquid sometimes throws if leverage is already set correctly
            if (msg.includes('already') || msg.includes('same') || msg.includes('6007')) {
                console.log(`[Execute] Leverage already set. Continuing.`);
            } else {
                console.warn(`[Execute] Leverage warning: ${msg}`);
            }
        }

        // ── STEP 5: PLACE LIMIT ENTRY WITH LINKED TP AND SL ──────────────
        /**
         * Hyperliquid supports linked TP/SL orders attached to the entry order
         * via the params object. This is the cleanest approach:
         * - Entry: PostOnly limit (0.015% maker fee)
         * - TP: Linked limit reduceOnly (0.015% maker fee)
         * - SL: Linked market trigger reduceOnly (fills at market)
         *
         * If Hyperliquid CCXT doesn't support linked orders natively,
         * we fall back to placing TP/SL as separate orders after fill.
         */

        console.log(`[Execute] Placing PostOnly limit entry @ $${entryPrice.toFixed(2)}...`);

        let entryOrder: any;
        let usedLinkedOrders = false;

        try {
            // Attempt linked TP/SL in entry payload (native Hyperliquid)
            entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL,
                'limit',
                side,
                contractSize,
                entryPrice,
                {
                    timeInForce: 'PostOnly',
                    // Linked TP
                    takeProfitPrice: tpPrice,
                    takeProfitType: 'limit',
                    // Linked SL
                    stopLossPrice: slPrice,
                    stopLossType: 'market',
                    reduceOnly: false,
                }
            );
            usedLinkedOrders = true;
            console.log(`[Execute] ✅ Entry placed with linked TP/SL`);
        } catch {
            // Fallback: plain entry, manual TP/SL after fill
            console.log(`[Execute] Linked orders not supported. Placing plain entry...`);
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

        // ── STEP 6: MONITOR FILL ──────────────────────────────────────────
        console.log(`[Execute] Waiting for fill (max ${STRATEGY.FILL_MAX_ATTEMPTS}s)...`);

        let filled = false;
        for (let i = 0; i < STRATEGY.FILL_MAX_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, STRATEGY.FILL_CHECK_INTERVAL_MS));

            const pos = await getOpenPosition(STRATEGY.SYMBOL);
            if (pos) {
                filled = true;
                console.log(`[Execute] ✅ Filled at attempt ${i + 1}`);
                break;
            }
            console.log(`[Execute] Waiting... ${i + 1}/${STRATEGY.FILL_MAX_ATTEMPTS}`);
        }

        // ── STEP 7: CANCEL IF NOT FILLED ─────────────────────────────────
        if (!filled) {
            console.log(`[Execute] ⏱️ Not filled in ${STRATEGY.FILL_MAX_ATTEMPTS}s. Cancelling...`);
            try {
                await exchange.cancelOrder(entryOrderId, STRATEGY.SYMBOL);
            } catch {
                await exchange.cancelAllOrders(STRATEGY.SYMBOL);
            }
            console.log(`[Execute] Order cancelled. Market moved. Recycling to next cycle.`);
            return { success: false, outcome: 'cancelled', message: 'Entry not filled within 5s' };
        }

        // ── STEP 8: PLACE SEPARATE TP/SL IF LINKED ORDERS FAILED ─────────
        let tpOrderId = '';
        let slOrderId = '';

        if (!usedLinkedOrders) {
            console.log(`[Execute] Placing separate TP @ $${tpPrice.toFixed(2)}...`);
            try {
                const tpOrder = await exchange.createOrder(
                    STRATEGY.SYMBOL,
                    'limit',
                    isBuy ? 'sell' : 'buy',
                    contractSize,
                    tpPrice,
                    { reduceOnly: true }
                );
                tpOrderId = getCleanOrderId(tpOrder);
                console.log(`[Execute] TP placed: ${tpOrderId}`);
            } catch (e: any) {
                console.error(`[Execute] TP placement failed: ${e.message}`);
            }

            console.log(`[Execute] Placing SL trigger @ $${slPrice.toFixed(2)}...`);
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

        // ── STEP 9: MONITOR UNTIL RESOLUTION ─────────────────────────────
        console.log(`[Execute] Monitoring position for resolution...`);
        let resolved = false;
        let outcome: TradeResult['outcome'] = 'error';
        let cycles = 0;

        while (!resolved) {
            await new Promise(r => setTimeout(r, STRATEGY.MONITOR_INTERVAL_MS));
            cycles++;

            try {
                // Check if position closed (TP or SL hit)
                const pos = await getOpenPosition(STRATEGY.SYMBOL);

                if (!pos) {
                    // Position gone — check if TP or SL closed it
                    if (tpOrderId) {
                        try {
                            const tpCheck = await exchange.fetchOrder(tpOrderId, STRATEGY.SYMBOL);
                            if (tpCheck.status === 'closed') {
                                console.log(`\n[Execute] 🎯 TAKE PROFIT HIT @ $${tpPrice.toFixed(2)}`);
                                console.log(`[Execute] Net profit: +$${netProfit.toFixed(4)}`);
                                outcome = 'tp_hit';
                                resolved = true;
                                break;
                            }
                        } catch { /* order may not exist if linked */ }
                    }

                    if (slOrderId && !resolved) {
                        try {
                            const slCheck = await exchange.fetchOrder(slOrderId, STRATEGY.SYMBOL);
                            if (slCheck.status === 'closed') {
                                const loss = contractSize * STRATEGY.SL_PRICE_MOVE;
                                console.log(`\n[Execute] 🛑 STOP LOSS HIT @ $${slPrice.toFixed(2)}`);
                                console.log(`[Execute] Loss: -$${loss.toFixed(4)}`);
                                outcome = 'sl_hit';
                                resolved = true;
                                break;
                            }
                        } catch { /* order may not exist */ }
                    }

                    // Position closed but can't determine which order — assume TP
                    if (!resolved) {
                        console.log(`[Execute] Position closed externally.`);
                        outcome = 'tp_hit';
                        resolved = true;
                    }
                }

                // Log every 30 cycles (~1 minute)
                if (cycles % 30 === 0) {
                    console.log(`[Execute] Still open... ${(cycles * STRATEGY.MONITOR_INTERVAL_MS / 1000).toFixed(0)}s elapsed`);
                }

            } catch (e: any) {
                console.warn(`[Execute] Monitor lag: ${e.message}`);
            }
        }

        // ── STEP 10: CLEANUP ──────────────────────────────────────────────
        console.log(`[Execute] Cleaning up bracket orders...`);
        try {
            await exchange.cancelAllOrders(STRATEGY.SYMBOL);
        } catch { /* already settled */ }

        const result: TradeResult = {
            success: outcome === 'tp_hit',
            outcome,
            grossProfit: outcome === 'tp_hit' ? grossProfit : undefined,
            netProfit: outcome === 'tp_hit' ? netProfit : undefined,
            fees,
            entryPrice,
            exitPrice: outcome === 'tp_hit' ? tpPrice : slPrice,
        };

        console.log(`[Execute] ✅ Cycle complete. Outcome: ${outcome.toUpperCase()}`);
        console.log(`${'─'.repeat(65)}\n`);

        return result;

    } catch (error: any) {
        console.error(`[Execute] ❌ Critical error:`, error.message || error);
        return { success: false, outcome: 'error', message: error.message };
    }
}
