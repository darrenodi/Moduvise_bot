import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
// Gold (GOLD/USDC:USDC) on Hyperliquid — 25x leverage.
//
// ENTRY:  PostOnly limit at best bid (long) or best ask (short) = MAKER 0.0144%
// TP:     PostOnly limit $5.00 above/below fill price = MAKER 0.0144%
// SL:     NONE — strategy relies on Gold ranging. Emergency handled in main.ts.
//
// Fee math on 0.01 oz @ $4500 ($45 position):
//   Maker entry:  $45 × 0.0144% = $0.0065
//   Maker TP:     $45 × 0.0144% = $0.0065
//   Total fees:   $0.013
//   Gross ($5 TP): 0.01 × $5 = $0.050
//   Net per trade: $0.037

const STRATEGY = {
    SYMBOL:           MARKET_SYMBOL,    // 'GOLD/USDC:USDC'
    LEVERAGE:         25,
    TP_MOVE:          2.00,             // $5.00 — clears fees with comfortable margin
    MAKER_FEE:        0.000144,         // 0.0144% PostOnly
    MIN_BALANCE:      1.50,
    GOLD_TICK:        0.10,             // $0.10 tick size

    // Maker fill window: 60 seconds. If not filled → cancel → next cycle.
    FILL_INTERVAL_MS: 2_000,
    FILL_MAX_TRIES:   30,               // 30 × 2s = 60s
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome = 'orders_placed' | 'cancelled' | 'skipped' | 'error';

export interface TradeResult {
    success:     boolean;
    outcome:     TradeOutcome;
    entryPrice?: number;
    tpPrice?:    number;
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
    } catch {
        return false;
    }
}

export async function getOpenPositionDetails(): Promise<{
    exists: boolean;
    side: 'long' | 'short' | null;
    entryPrice: number;
    size: number;
} > {
    try {
        const positions = await exchange.fetchPositions([STRATEGY.SYMBOL]);
        const pos = positions.find((p: any) =>
            Number(p.info?.holdVol ?? p.info?.positionAmt ?? p.contracts ?? 0) > 0
        );
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0 };

        const size  = Math.abs(Number(pos.contracts ?? pos.info?.szi ?? 0));
        const entry = Number(pos.entryPrice ?? pos.info?.entryPx ?? 0);
        const side  = Number(pos.contracts ?? pos.info?.szi ?? 0) > 0 ? 'long' : 'short';
        return { exists: true, side, entryPrice: entry, size };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0 };
    }
}

// Emergency close — called from main.ts when adverse move > $40
export async function emergencyClose(side: 'long' | 'short', size: number): Promise<void> {
    const closeSide = side === 'long' ? 'sell' : 'buy';
    console.log(`[Execute] 🚨 EMERGENCY CLOSE — market ${closeSide} ${size} oz`);
    try {
        await exchange.cancelAllOrders(STRATEGY.SYMBOL);
    } catch { /* ok */ }
    try {
        await exchange.createOrder(
            STRATEGY.SYMBOL, 'market', closeSide, size, undefined,
            { reduceOnly: true }
        );
        console.log(`[Execute] Emergency close submitted.`);
    } catch (e: any) {
        console.error(`[Execute] Emergency close failed: ${e.message}`);
    }
}

function extractId(order: any): string {
    if (!order) return '';
    if (typeof order.id === 'string') return order.id;
    if (typeof order.id === 'number') return String(order.id);
    return String(order.info?.oid ?? order.info?.orderId ?? '');
}

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

function calcSize(balance: number, price: number): number {
    // 95% of balance to leave margin buffer
    const usable  = balance * 0.95;
    const posVal  = usable * STRATEGY.LEVERAGE;
    const raw     = posVal / price;
    // Floor to 2 decimal places (minimum Gold lot = 0.01 oz)
    const floored = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

// ─── MAKER ENTRY ──────────────────────────────────────────────────────────────
// Place PostOnly limit at best bid (long) or best ask (short).
// Both positions sit on the order book — no spread crossing, guaranteed maker fee.
// 60 second fill window. Cancel and return 'cancelled' if unfilled.

async function placeMakerEntry(
    side: 'buy' | 'sell',
    size: number,
    isBuy: boolean,
): Promise<{ filled: boolean; fillPrice: number; orderId: string }> {

    // Refresh order book immediately before placing — signal may be seconds old
    const ob      = await exchange.fetchOrderBook(STRATEGY.SYMBOL, 5);
    const bestBid = Number(ob.bids[0]?.[0] ?? 0);
    const bestAsk = Number(ob.asks[0]?.[0] ?? 0);

    if (!bestBid || !bestAsk) {
        console.error(`[Execute] Order book unavailable — cannot place maker entry`);
        return { filled: false, fillPrice: 0, orderId: '' };
    }

    // Long: sit at best bid (price must come down to us)
    // Short: sit at best ask (price must come up to us)
    const entryPrice = tickRound(isBuy ? bestBid : bestAsk);
    const spread     = tickRound(bestAsk - bestBid);

    console.log(`[Execute] OB: Bid $${bestBid.toFixed(2)} Ask $${bestAsk.toFixed(2)} Spread $${spread.toFixed(2)}`);
    console.log(`[Execute] PostOnly ${side.toUpperCase()} @ $${entryPrice.toFixed(2)} | size=${size} oz`);

    let entryOrder: any;
    try {
        entryOrder = await exchange.createOrder(
            STRATEGY.SYMBOL, 'limit', side, size, entryPrice,
            { timeInForce: 'Alo' }  // Alo = PostOnly = always maker
        );
    } catch (e: any) {
        console.error(`[Execute] Maker entry rejected: ${e.message}`);
        return { filled: false, fillPrice: 0, orderId: '' };
    }

    const orderId = extractId(entryOrder);
    console.log(`[Execute] Maker order placed: ${orderId} — waiting for fill (max 60s)...`);

    // Poll for position (= fill confirmation)
    for (let i = 1; i <= STRATEGY.FILL_MAX_TRIES; i++) {
        await new Promise(r => setTimeout(r, STRATEGY.FILL_INTERVAL_MS));
        if (await hasOpenPosition()) {
            console.log(`[Execute] ✅ Maker filled at check ${i} (~${i * 2}s)`);
            return { filled: true, fillPrice: entryPrice, orderId };
        }
        if (i % 5 === 0) console.log(`[Execute] Waiting... ${i * 2}s / 60s`);
    }

    // Not filled in 60s — cancel and recycle
    console.log(`[Execute] ⏱️ No fill in 60s — cancelling.`);
    try {
        await exchange.cancelOrder(orderId, STRATEGY.SYMBOL);
    } catch {
        try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
    }
    return { filled: false, fillPrice: 0, orderId: '' };
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
    console.log(`[Execute] GOLD ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | ~$${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── 1. POSITION GUARD ──────────────────────────────────────────────
        if (await hasOpenPosition()) {
            console.log(`[Execute] 🛑 Position open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // ── 2. BALANCE ─────────────────────────────────────────────────────
        const balance = await getAvailableBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC`);
        if (balance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Low balance: $${balance.toFixed(4)}` };
        }

        // ── 3. LEVERAGE ────────────────────────────────────────────────────
        try {
            await exchange.setLeverage(STRATEGY.LEVERAGE, STRATEGY.SYMBOL, { marginMode: 'isolated' });
        } catch (e: any) {
            if (!/already|same|6007/i.test(e.message ?? '')) {
                console.warn(`[Execute] Leverage warn: ${e.message}`);
            }
        }

        // ── 4. SIZE ────────────────────────────────────────────────────────
        const size   = calcSize(balance, signal.market_price);
        console.log(`[Execute] Size: ${size} oz (~$${(size * signal.market_price).toFixed(2)} position)`);

        // ── 5. MAKER ENTRY ─────────────────────────────────────────────────
        const { filled, fillPrice } = await placeMakerEntry(side, size, isBuy);

        if (!filled || !fillPrice) {
            return { success: false, outcome: 'cancelled', message: 'Maker entry not filled in 60s' };
        }

        // ── 6. TAKE PROFIT — PostOnly limit (maker exit) ───────────────────
        const tpPrice     = tickRound(isBuy ? fillPrice + STRATEGY.TP_MOVE : fillPrice - STRATEGY.TP_MOVE);
        const posVal      = size * fillPrice;
        const grossProfit = size * STRATEGY.TP_MOVE;
        const fees        = posVal * STRATEGY.MAKER_FEE * 2;   // maker entry + maker TP
        const netProfit   = grossProfit - fees;

        console.log(`[Execute] Fill=$${fillPrice.toFixed(2)} | TP=$${tpPrice.toFixed(2)} (+$${STRATEGY.TP_MOVE})`);
        console.log(`[Execute] Gross=$${grossProfit.toFixed(4)} | Fees=$${fees.toFixed(4)} | Net=$${netProfit.toFixed(4)}`);
        console.log(`[Execute] NO SL — emergency exit at $40 adverse handled by main cycle.`);

        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, tpPrice,
                { timeInForce: 'Alo', reduceOnly: true }   // PostOnly = maker exit
            );
            console.log(`[Execute] ✅ TP on-chain: ${extractId(tpOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
        }

        console.log(`[Execute] ✅ Trade live. TP=$${tpPrice.toFixed(2)} | maker/maker`);
        console.log(`${'─'.repeat(65)}\n`);

        return { success: true, outcome: 'orders_placed', entryPrice: fillPrice, tpPrice, netProfit, fees };

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}