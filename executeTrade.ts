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
    FILL_MAX_TRIES:   5,               // Cancel after 5s if unfilled
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

async function hasOpenPosition(): Promise<boolean> {
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

function calcSize(balance: number, price: number): number {
    const pos = balance * STRATEGY.LEVERAGE;
    return Math.max(0.001, parseFloat((pos / price).toFixed(4)));
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
        const MAKER_OFFSET = 2.00; // $1 inside from mid — adjustable
        const rawPrice = signal.market_price;
        const entry = parseFloat(
            (isBuy
                ? rawPrice - MAKER_OFFSET   // Long: place below current price
                : rawPrice + MAKER_OFFSET   // Short: place above current price
            ).toFixed(2)
        );
        const tpPrice     = parseFloat((isBuy ? entry + STRATEGY.TP_MOVE : entry - STRATEGY.TP_MOVE).toFixed(2));
        const slPrice     = parseFloat((isBuy ? entry - STRATEGY.SL_MOVE : entry + STRATEGY.SL_MOVE).toFixed(2));
        const size        = calcSize(balance, entry);
        const posVal      = size * entry;
        const grossProfit = size * STRATEGY.TP_MOVE;
        const fees        = posVal * STRATEGY.MAKER_FEE * 2;
        const netProfit   = grossProfit - fees;

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

        // ── 5. POSTONLY LIMIT ENTRY ───────────────────────────────────────
        // PostOnly = ALO = guaranteed maker fee 0.0144%
        // If the order would immediately match (taker), exchange rejects it.
        // We cancel and recycle — this protects maker status.
        console.log(`[Execute] PostOnly limit entry @ $${entry.toFixed(2)}...`);
        let entryOrder: any;
        try {
            entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', side, size, entry,
                { timeInForce: 'PostOnly' }
            );
        } catch (e: any) {
            // PostOnly rejected = price moved, order would have been taker
            console.log(`[Execute] PostOnly rejected (price moved) — recycling.`);
            return { success: false, outcome: 'cancelled', message: 'PostOnly rejected — not maker' };
        }

        const entryId = extractId(entryOrder);
        console.log(`[Execute] Entry order: ${entryId}`);

        // ── 6. FILL POLL (max 5s) ─────────────────────────────────────────
        let filled = false;
        for (let i = 1; i <= STRATEGY.FILL_MAX_TRIES; i++) {
            await new Promise<void>(r => setTimeout(r, STRATEGY.FILL_INTERVAL_MS));
            if (await hasOpenPosition()) { filled = true; console.log(`[Execute] ✅ Filled (${i}s)`); break; }
            console.log(`[Execute] Waiting fill ${i}/${STRATEGY.FILL_MAX_TRIES}...`);
        }

        // ── 7. CANCEL IF UNFILLED ─────────────────────────────────────────
        if (!filled) {
            console.log(`[Execute] ⏱️ Not filled in 5s. Cancelling and recycling.`);
            try { await exchange.cancelOrder(entryId, STRATEGY.SYMBOL); }
            catch { try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ignore */ } }
            return { success: false, outcome: 'cancelled', message: 'Not filled within 5s' };
        }

        // ── 8. ON-CHAIN TP — reduceOnly limit ────────────────────────────
        // No while-loop. TP lives on Hyperliquid's order book permanently.
        // Next cycle detects open position and skips re-entry automatically.
        console.log(`[Execute] Placing TP limit @ $${tpPrice.toFixed(2)}...`);
        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, tpPrice,
                { reduceOnly: true }
            );
            console.log(`[Execute] ✅ TP on-chain: ${extractId(tpOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
        }

        // ── 9. ON-CHAIN SL — reduceOnly market trigger ────────────────────
        console.log(`[Execute] Placing SL trigger @ $${slPrice.toFixed(2)}...`);
        try {
            const slOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'market', closeSide, size, undefined,
                { reduceOnly: true, triggerPrice: slPrice, stopLoss: true }
            );
            console.log(`[Execute] ✅ SL on-chain: ${extractId(slOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] SL failed (non-fatal): ${e.message}`);
        }

        // ── 10. RETURN — no monitoring loop ───────────────────────────────
        // TP and SL are live on Hyperliquid. Bot cycles back in 60-90s.
        // hasOpenPosition() blocks re-entry until one fires.
        console.log(`[Execute] ✅ Trade live. TP/SL on-chain. Returning to scheduler.`);
        console.log(`${'─'.repeat(65)}\n`);

        return { success: true, outcome: 'orders_placed', entryPrice: entry, tpPrice, slPrice, netProfit, fees };

    } catch (e: any) {
        console.error(`[Execute] ❌ Critical: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
