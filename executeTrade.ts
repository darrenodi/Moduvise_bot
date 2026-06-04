import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
//
// Gold (GOLD/USDC:USDC) on Hyperliquid — 25x leverage.
//
// ENTRY:  PostOnly limit at best bid (long) or best ask (short) = MAKER 0.0144%
// TP:     PostOnly limit $2.00 above/below fill price = MAKER 0.0144%
// SL:     NONE — strategy relies on Gold ranging. Emergency handled in main.ts.
//
// Fee math on 0.01 oz @ $3300 ($33 position):
//   Maker entry:  $33 × 0.0144% = $0.0048
//   Maker TP:     $33 × 0.0144% = $0.0048
//   Total fees:   $0.0096
//   Gross ($2 TP): 0.01 × $2 = $0.020
//   Net per trade: ~$0.010
//
// "The best trader doesn't sit at a screen — he builds the machine and lets it run."

const STRATEGY = {
    SYMBOL:    MARKET_SYMBOL,   // 'XYZ-GOLD/USDC:USDC'
    LEVERAGE:  25,
    TP_MOVE:   2.00,            // $2.00 — clears fees with comfortable margin
    MAKER_FEE: 0.000144,        // 0.0144% PostOnly
    MIN_BALANCE: 1.50,
    GOLD_TICK: 0.10,            // $0.10 tick size

    // Maker fill window — how long to wait for the market to come to us
    FILL_INTERVAL_MS: 1_500,    // check every 1.5s (was 2s)
    FILL_MAX_TRIES:   40,       // 40 × 1.5s = 60s max

    // TP monitoring — check fast to free up balance for next trade ASAP
    TP_POLL_INTERVAL_MS: 2_000, // check every 2s (was 5s)
    TP_POLL_MAX_TRIES:   300,   // 300 × 2s = 10 minutes max

    // Entry price safety: if spread is too wide at moment of order, abort
    MAX_ENTRY_SPREAD: 0.50,
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome = 'orders_placed' | 'tp_confirmed' | 'cancelled' | 'skipped' | 'error';

export interface TradeResult {
    success:      boolean;
    outcome:      TradeOutcome;
    entryPrice?:  number;
    tpPrice?:     number;
    grossProfit?: number;
    netProfit?:   number;
    fees?:        number;
    tpConfirmed?: boolean;
    message?:     string;
    fillTimeMs?:  number;  // how long entry took
    tpTimeMs?:    number;  // how long TP took
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
}> {
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

// Emergency close — called from main.ts when adverse move breaches threshold
export async function emergencyClose(side: 'long' | 'short', size: number): Promise<void> {
    const closeSide = side === 'long' ? 'sell' : 'buy';
    console.log(`[Execute] 🚨 EMERGENCY CLOSE — market ${closeSide} ${size} oz`);
    try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
    try {
        await exchange.createOrder(
            STRATEGY.SYMBOL, 'market', closeSide, size, undefined,
            { reduceOnly: true }
        );
        console.log(`[Execute] Emergency close submitted.`);
    } catch (e: any) {
        console.error(`[Execute] Emergency close FAILED: ${e.message}`);
        // Retry once
        await new Promise(r => setTimeout(r, 2000));
        try {
            await exchange.createOrder(
                STRATEGY.SYMBOL, 'market', closeSide, size, undefined,
                { reduceOnly: true }
            );
            console.log(`[Execute] Emergency close retry succeeded.`);
        } catch (e2: any) {
            console.error(`[Execute] Emergency close retry also failed: ${e2.message}`);
        }
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
    // Use 98% of balance for position sizing
    const usable  = balance * 0.98;
    const posVal  = usable * STRATEGY.LEVERAGE;
    const raw     = posVal / price;
    // Floor to 2 decimal places — minimum Gold lot is 0.01 oz
    const floored = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

// ─── SMART ENTRY — READ THE TAPE ──────────────────────────────────────────────
// Before placing, re-check OB for spread and momentum alignment.
// If the market moved against us since signal → abort (stale signal protection).

async function placeMakerEntry(
    side: 'buy' | 'sell',
    size: number,
    isBuy: boolean,
    signalPrice: number,
): Promise<{ filled: boolean; fillPrice: number; orderId: string; fillTimeMs: number }> {

    const startTime = Date.now();

    // Refresh OB immediately before placing — signal may be seconds old
    let ob: any;
    try {
        ob = await exchange.fetchOrderBook(STRATEGY.SYMBOL, 10);
    } catch (e: any) {
        console.error(`[Execute] OB fetch failed: ${e.message}`);
        return { filled: false, fillPrice: 0, orderId: '', fillTimeMs: 0 };
    }

    const bestBid = Number(ob.bids[0]?.[0] ?? 0);
    const bestAsk = Number(ob.asks[0]?.[0] ?? 0);

    if (!bestBid || !bestAsk) {
        console.error(`[Execute] OB empty — cannot place maker entry`);
        return { filled: false, fillPrice: 0, orderId: '', fillTimeMs: 0 };
    }

    const spread = tickRound(bestAsk - bestBid);

    // ── Spread guard at execution time ─────────────────────────────────
    if (spread >= STRATEGY.MAX_ENTRY_SPREAD) {
        console.log(`[Execute] ⚠️ Spread $${spread.toFixed(2)} too wide at execution — abort.`);
        return { filled: false, fillPrice: 0, orderId: '', fillTimeMs: 0 };
    }

    // ── Stale signal guard ─────────────────────────────────────────────
    // If market has already moved > $3 past our signal price in the trade direction,
    // we're chasing — the TP is already partially eaten. Skip.
    const midPrice = (bestBid + bestAsk) / 2;
    const drift    = isBuy ? midPrice - signalPrice : signalPrice - midPrice;
    if (drift > 3.0) {
        console.log(`[Execute] ⏩ Stale signal — market drifted $${drift.toFixed(2)} since signal. Skip.`);
        return { filled: false, fillPrice: 0, orderId: '', fillTimeMs: 0 };
    }

    // Long: sit at best bid | Short: sit at best ask
    const entryPrice = tickRound(isBuy ? bestBid : bestAsk);

    console.log(`[Execute] OB: Bid $${bestBid.toFixed(2)} Ask $${bestAsk.toFixed(2)} Spread $${spread.toFixed(2)}`);
    console.log(`[Execute] PostOnly ${side.toUpperCase()} @ $${entryPrice.toFixed(2)} | size=${size} oz | drift=$${drift.toFixed(2)}`);

    let entryOrder: any;
    try {
        entryOrder = await exchange.createOrder(
            STRATEGY.SYMBOL, 'limit', side, size, entryPrice,
            { timeInForce: 'Alo' }  // Alo = PostOnly = always maker
        );
    } catch (e: any) {
        console.error(`[Execute] Maker entry rejected: ${e.message}`);
        return { filled: false, fillPrice: 0, orderId: '', fillTimeMs: 0 };
    }

    const orderId = extractId(entryOrder);
    console.log(`[Execute] Maker order: ${orderId} — waiting fill (max 60s)...`);

    // Poll for fill confirmation (position appears = filled)
    for (let i = 1; i <= STRATEGY.FILL_MAX_TRIES; i++) {
        await new Promise(r => setTimeout(r, STRATEGY.FILL_INTERVAL_MS));
        if (await hasOpenPosition()) {
            const fillTimeMs = Date.now() - startTime;
            console.log(`[Execute] ✅ Filled @ check ${i} (~${(fillTimeMs/1000).toFixed(1)}s)`);
            return { filled: true, fillPrice: entryPrice, orderId, fillTimeMs };
        }
        if (i % 10 === 0) console.log(`[Execute] Waiting... ${(i * STRATEGY.FILL_INTERVAL_MS / 1000).toFixed(0)}s`);
    }

    // Not filled in 60s — cancel and recycle
    console.log(`[Execute] ⏱️ No fill in 60s — cancelling.`);
    try {
        await exchange.cancelOrder(orderId, STRATEGY.SYMBOL);
    } catch {
        try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
    }
    return { filled: false, fillPrice: 0, orderId: '', fillTimeMs: 0 };
}

// ─── MAIN EXECUTION ───────────────────────────────────────────────────────────

export async function executeHyperliquidTrade(signal: GeneratedSignal, virtualBalance?: number): Promise<TradeResult> {
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
            console.log(`[Execute] 🛑 Position open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // ── 2. BALANCE ─────────────────────────────────────────────────────
        const balance          = await getAvailableBalance();
        const effectiveBalance = virtualBalance ?? balance;
        console.log(`[Execute] Balance: $${balance.toFixed(4)} USDC | Virtual: $${effectiveBalance.toFixed(4)}`);
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
        const size = calcSize(effectiveBalance, signal.market_price);
        console.log(`[Execute] Size: ${size} oz | Position: ~$${(size * signal.market_price).toFixed(2)}`);

        // ── 5. MAKER ENTRY ─────────────────────────────────────────────────
        const { filled, fillPrice, fillTimeMs } = await placeMakerEntry(side, size, isBuy, signal.market_price);

        if (!filled || !fillPrice) {
            return { success: false, outcome: 'cancelled', message: 'Maker entry not filled in 60s' };
        }

        // ── 6. TAKE PROFIT — PostOnly (guaranteed maker exit) ──────────────
        const tpPrice     = tickRound(isBuy ? fillPrice + STRATEGY.TP_MOVE : fillPrice - STRATEGY.TP_MOVE);
        const posVal      = size * fillPrice;
        const grossProfit = size * STRATEGY.TP_MOVE;
        const fees        = posVal * STRATEGY.MAKER_FEE * 2;   // entry + TP both maker
        const netProfit   = grossProfit - fees;

        console.log(`[Execute] Fill=$${fillPrice.toFixed(2)} TP=$${tpPrice.toFixed(2)} (+$${STRATEGY.TP_MOVE})`);
        console.log(`[Execute] Gross=$${grossProfit.toFixed(4)} Fees=$${fees.toFixed(4)} Net=$${netProfit.toFixed(4)}`);

        let tpOrderId = '';
        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, tpPrice,
                { timeInForce: 'Alo', reduceOnly: true }
            );
            tpOrderId = extractId(tpOrder);
            console.log(`[Execute] ✅ TP on-chain: ${tpOrderId}`);
        } catch (e: any) {
            console.error(`[Execute] TP order failed: ${e.message}`);
            // TP failed — set market close as fallback
        }

        // ── 7. POLL FOR TP CLOSURE ─────────────────────────────────────────
        // Check every 2s — faster than original 5s to free up capital sooner.
        console.log(`[Execute] 📡 Monitoring TP (max 10 min, poll 2s)...`);
        const tpStart   = Date.now();
        let tpConfirmed = false;

        for (let p = 1; p <= STRATEGY.TP_POLL_MAX_TRIES; p++) {
            await new Promise(r => setTimeout(r, STRATEGY.TP_POLL_INTERVAL_MS));
            if (!(await hasOpenPosition())) {
                tpConfirmed = true;
                const tpTimeMs = Date.now() - tpStart;
                console.log(`[Execute] 🎯 TP hit @ poll ${p} (~${(tpTimeMs/1000).toFixed(0)}s) | Net: $${netProfit.toFixed(4)}`);
                break;
            }
            if (p % 30 === 0) {
                console.log(`[Execute] Still open... ${(p * 2 / 60).toFixed(1)} min`);
            }
        }

        if (!tpConfirmed) {
            console.log(`[Execute] ⏰ 10-min poll timeout — TP order live on exchange.`);
        }

        const tpTimeMs = Date.now() - tpStart;
        console.log(`${'─'.repeat(65)}\n`);

        return {
            success:      true,
            outcome:      tpConfirmed ? 'tp_confirmed' : 'orders_placed',
            entryPrice:   fillPrice,
            tpPrice,
            grossProfit,
            netProfit,
            fees,
            tpConfirmed,
            fillTimeMs,
            tpTimeMs,
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
