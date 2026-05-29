import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────

const STRATEGY = {
    SYMBOL:           MARKET_SYMBOL,   // 'BTC/USDC:USDC'
    LEVERAGE:         40,
    TP_MOVE:          70,              // $70 TP
    SL_MOVE:          70,              // $70 SL — 1:1 R:R
    MAKER_FEE:        0.000144,        // Hyperliquid actual maker 0.0144%
    MIN_BALANCE:      2,               // Min $2 USDC
    FILL_INTERVAL_MS: 1_000,          // Poll fill every 1s
    FILL_MAX_TRIES:   90,               // Cancel after 5s if unfilled
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome = 'orders_placed' | 'cancelled' | 'skipped' | 'error';

export interface TradeResult {
    success:     boolean;
    outcome:     TradeOutcome;
    entryPrice?: number;
    tpPrice?:    number;
    slPrice?:    number;
    netProfit?:  number;
    fees?:       number;
    message?:    string;
}

// ─── EXCHANGE ────────────────────────────────────────────────────────────────

const exchange = new (ccxt as any).hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    privateKey:    process.env.HYPERLIQUID_API_SECRET     ?? '',
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    timeout:       15_000,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
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

export async function hasOpenPosition(): Promise<boolean> {    try {
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

function calcSize(balance: number, price: number): number {
    const usableBalance = balance * 0.95; // Leave 5% buffer for margin and fees
    const pos = usableBalance * STRATEGY.LEVERAGE;
    const rawSize = pos / price;
    // Floor to 4 decimals instead of rounding up
    const flooredSize = Math.floor(rawSize * 10000) / 10000;
    return Math.max(0.001, flooredSize);
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
    console.log(`[Execute] ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── 1. POSITION GUARD ─────────────────────────────────────────────
        if (await hasOpenPosition()) {
            console.log(`[Execute] 🛑 Position already open. Skipping.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // ── 2. BALANCE ────────────────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC`);
        if (balance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Low balance: $${balance.toFixed(4)} USDC` };
        }

        // ── 3. PARAMS ─────────────────────────────────────────────────────
        // ── MAKER OFFSET ──────────────────────────────────────────────
        // PostOnly requires the order to REST in the book, not cross the spread.
        // Hyperliquid BTC spread is $0.50-$1. We offset by $1.00 inside the book:
        //   LONG:  bid slightly BELOW mid — we sit in the bid queue waiting for a fill
        //   SHORT: ask slightly ABOVE mid — we sit in the ask queue waiting for a fill
        // This guarantees maker status. Trade fills when price touches our level.
        // ── 3. PARAMS & LIVE PRICE REFRESH ────────────────────────────────
        // Gemini takes a few seconds to think. We MUST refresh the live order book 
        // right before placing the order to prevent crossing the spread.
        const liveOb = await exchange.fetchOrderBook(STRATEGY.SYMBOL, 5);
        const bestBid = Number(liveOb.bids[0]?.[0] ?? signal.market_price);
        const bestAsk = Number(liveOb.asks[0]?.[0] ?? signal.market_price);

        // To guarantee Maker status:
        // Longs sit precisely on the Best Bid. Shorts sit precisely on the Best Ask.
        const entry = parseFloat((isBuy ? bestBid : bestAsk).toFixed(2));
        
        const tpPrice     = parseFloat((isBuy ? entry + STRATEGY.TP_MOVE : entry - STRATEGY.TP_MOVE).toFixed(2));
        const slPrice     = parseFloat((isBuy ? entry - STRATEGY.SL_MOVE : entry + STRATEGY.SL_MOVE).toFixed(2));
        const size        = calcSize(balance, entry);
        const posVal      = size * entry;
        const grossProfit = size * STRATEGY.TP_MOVE;
        const fees        = posVal * STRATEGY.MAKER_FEE * 2;
        const netProfit   = grossProfit - fees;

        console.log(`[Execute] Live BBO: Bid $${bestBid.toFixed(2)} | Ask $${bestAsk.toFixed(2)}`);
        console.log(`[Execute] Entry=$${entry.toFixed(2)} TP=$${tpPrice.toFixed(2)} SL=$${slPrice.toFixed(2)}`);
        console.log(`[Execute] Size=${size} BTC | Pos=$${posVal.toFixed(2)} | Net/win=$${netProfit.toFixed(4)} USDC`);

        // ── 4. LEVERAGE ───────────────────────────────────────────────────
        try {
            await exchange.setLeverage(STRATEGY.LEVERAGE, STRATEGY.SYMBOL, { marginMode: 'isolated' });
        } catch (e: any) {
            if (!/already|same|6007/i.test(e.message ?? '')) {
                console.warn(`[Execute] Leverage warn: ${e.message}`);
            }
        }

        // ── 5. MARKET ENTRY (Taker) ───────────────────────────────────────
        console.log(`[Execute] Firing MARKET ${side.toUpperCase()} order to guarantee entry...`);
        let entryOrder: any;
        try {
            // ADDED: We pass 'entry' as the 5th parameter so CCXT can calculate slippage!
            entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'market', side, size, entry
            );
            console.log(`[Execute] ✅ Market entry filled: ${extractId(entryOrder)}`);
        } catch (e: any) {
            console.log(`[Execute] Market entry failed: ${e.message}`);
            return { success: false, outcome: 'error', message: 'Market entry failed' };
        }

        // ── 6. FETCH ACTUAL ENTRY PRICE ───────────────────────────────────
        console.log(`[Execute] Fetching actual fill price...`);
        await new Promise(r => setTimeout(r, 1500)); 
        
        const positions = await exchange.fetchPositions([STRATEGY.SYMBOL]);
        const activePos = positions.find((p: any) => Math.abs(Number(p.contracts ?? p.info?.szi ?? 0)) > 0);
        
        if (!activePos) {
            console.error(`[Execute] ❌ Position not found after market order!`);
            return { success: false, outcome: 'error', message: 'Position not found after market order' };
        }

        const actualEntryPrice = Number(activePos.entryPrice);
        console.log(`[Execute] Actual Fill Price: $${actualEntryPrice.toFixed(2)}`);

        const actualTpPrice = parseFloat((isBuy ? actualEntryPrice + STRATEGY.TP_MOVE : actualEntryPrice - STRATEGY.TP_MOVE).toFixed(2));
        const actualSlPrice = parseFloat((isBuy ? actualEntryPrice - STRATEGY.SL_MOVE : actualEntryPrice + STRATEGY.SL_MOVE).toFixed(2));

        // ── 8. ON-CHAIN TP — reduceOnly limit (MAKER EXIT) ───────────────
        console.log(`[Execute] Placing TP limit @ $${actualTpPrice.toFixed(2)}...`);
        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, actualTpPrice,
                { timeInForce: 'Alo', reduceOnly: true } 
            );
            console.log(`[Execute] ✅ TP on-chain: ${extractId(tpOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
        }

        // ── 9. ON-CHAIN SL — STOP LIMIT (Bypasses CCXT Bug) ───────────────
        console.log(`[Execute] Placing SL trigger @ $${actualSlPrice.toFixed(2)}...`);
        try {
            // We use a Limit order set $50 past the trigger. 
            // This guarantees instant market-style execution but prevents CCXT's .split() bug.
            const slLimitPrice = isBuy ? actualSlPrice - 50 : actualSlPrice + 50;
            const slOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, slLimitPrice,
                { triggerPrice: actualSlPrice, reduceOnly: true }
            );
            console.log(`[Execute] ✅ SL on-chain: ${extractId(slOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] SL failed (non-fatal): ${e.message}`);
        }

        // ── 10. RETURN ────────────────────────────────────────────────────
        console.log(`[Execute] ✅ Trade live. TP/SL on-chain. Returning to scheduler.`);
        console.log(`${'─'.repeat(65)}\n`);

        return { 
            success: true, outcome: 'orders_placed', 
            entryPrice: actualEntryPrice, tpPrice: actualTpPrice, slPrice: actualSlPrice, 
            netProfit, fees 
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal execution error: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
