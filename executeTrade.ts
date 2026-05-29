import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
// Gold (XAU/USDC) on Hyperliquid — 25x leverage, taker market entry.
// TP: $6.00 price move. SL: scaled by balance tier.
// Taker fee: 0.0432% per side = 0.0864% round-trip.
// Net profit at $6 TP on 0.01oz @ $4500: ~$0.027 after fees.

const STRATEGY = {
    SYMBOL:        MARKET_SYMBOL,
    LEVERAGE:      25,
    TP_MOVE:       6.00,            // $6.00 TP — required to clear taker fees + profit
    TAKER_FEE:     0.000432,        // 0.0432% per side (Hyperliquid taker)
    MIN_BALANCE:   1.50,

    // ── SCALED SL THRESHOLDS ──────────────────────────────────────────────
    MICRO_THRESHOLD:   20,          // < $20 → loose SL (2%)
    CAPITAL_THRESHOLD: 200,         // ≥ $200 → tight SL (0.5%)

    LOOSE_SL_PCT:  0.02,            // 2% — ~$90 move on $4500 gold
    MID_SL_PCT:    0.01,            // 1%
    TIGHT_SL_PCT:  0.005,           // 0.5%

    GOLD_TICK:     0.01,
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

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

function calcSize(balance: number, price: number): number {
    const usable  = balance * 0.95;
    const posVal  = usable * STRATEGY.LEVERAGE;
    const raw     = posVal / price;
    const floored = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

function calcScaledSL(
    entryPrice: number,
    balance: number,
    isBuy: boolean
): { slPrice: number; slType: 'loose' | 'mid' | 'tight'; slPct: number } {

    let slPct: number;
    let slType: 'loose' | 'mid' | 'tight';

    if (balance < STRATEGY.MICRO_THRESHOLD) {
        slPct  = STRATEGY.LOOSE_SL_PCT;
        slType = 'loose';
    } else if (balance < STRATEGY.CAPITAL_THRESHOLD) {
        slPct  = STRATEGY.MID_SL_PCT;
        slType = 'mid';
    } else {
        slPct  = STRATEGY.TIGHT_SL_PCT;
        slType = 'tight';
    }

    const slMove  = entryPrice * slPct;
    const slPrice = isBuy
        ? tickRound(entryPrice - slMove)
        : tickRound(entryPrice + slMove);

    const size      = calcSize(balance, entryPrice);
    const dollarRisk = size * (entryPrice * slPct) / STRATEGY.LEVERAGE;
    console.log(`[Execute] SL: ${slType.toUpperCase()} | ${(slPct*100).toFixed(2)}% | ~$${dollarRisk.toFixed(4)} risk`);

    return { slPrice, slType, slPct };
}

// ─── TAKER MARKET ENTRY ───────────────────────────────────────────────────────
// Single market order — fills instantly at best available price.
// No chase loop, no post-only rejection, no wasted cycles.

async function placeTakerEntry(
    side: 'buy' | 'sell',
    size: number,
): Promise<{ filled: boolean; fillPrice: number }> {
    console.log(`[Execute] Taker MARKET ${side.toUpperCase()} | size=${size} oz`);
    try {
        const order = await exchange.createOrder(
            STRATEGY.SYMBOL, 'market', side, size, undefined,
            { reduceOnly: false }
        );
        // Hyperliquid returns fill price in average or price field
        const fillPrice = Number(order.average ?? order.price ?? 0);
        if (!fillPrice) {
            // Market orders on HL sometimes need a short poll for fill confirmation
            await new Promise(r => setTimeout(r, 1500));
            try {
                const fetched = await exchange.fetchOrder(extractId(order), STRATEGY.SYMBOL);
                const fp = Number(fetched.average ?? fetched.price ?? 0);
                if (fp) {
                    console.log(`[Execute] ✅ Taker fill confirmed @ $${fp.toFixed(2)}`);
                    return { filled: true, fillPrice: fp };
                }
            } catch { /* use order price as fallback */ }
        }
        console.log(`[Execute] ✅ Taker fill @ $${fillPrice.toFixed(2)}`);
        return { filled: true, fillPrice };
    } catch (e: any) {
        console.error(`[Execute] ❌ Taker entry failed: ${e.message}`);
        return { filled: false, fillPrice: 0 };
    }
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
        const posVal = size * signal.market_price;
        console.log(`[Execute] Size: ${size} oz | Position: $${posVal.toFixed(2)} | Balance: $${balance.toFixed(4)}`);

        // ── 5. TAKER MARKET ENTRY ──────────────────────────────────────────
        const { filled, fillPrice } = await placeTakerEntry(side, size);

        if (!filled || !fillPrice) {
            return { success: false, outcome: 'cancelled', message: 'Taker entry failed' };
        }

        // ── 6. TP & SL PRICES ─────────────────────────────────────────────
        const tpPrice = tickRound(isBuy
            ? fillPrice + STRATEGY.TP_MOVE
            : fillPrice - STRATEGY.TP_MOVE
        );

        const { slPrice, slType, slPct } = calcScaledSL(fillPrice, balance, isBuy);

        const grossProfit = size * STRATEGY.TP_MOVE;
        const fees        = posVal * STRATEGY.TAKER_FEE * 2;   // entry taker + exit taker
        const netProfit   = grossProfit - fees;

        console.log(`[Execute] Fill=$${fillPrice.toFixed(2)} | TP=$${tpPrice.toFixed(2)} | SL=$${slPrice.toFixed(2)} (${slType})`);
        console.log(`[Execute] Gross=$${grossProfit.toFixed(4)} | Fees=$${fees.toFixed(4)} | Net=$${netProfit.toFixed(4)}`);

        // ── 7. TAKE PROFIT — limit reduceOnly ─────────────────────────────
        console.log(`[Execute] Placing TP limit @ $${tpPrice.toFixed(2)}...`);
        try {
            const tpOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, tpPrice,
                { timeInForce: 'Gtc', reduceOnly: true }
            );
            console.log(`[Execute] ✅ TP placed: ${extractId(tpOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
        }

        // ── 8. STOP LOSS — stop-limit reduceOnly ──────────────────────────
        console.log(`[Execute] Placing SL @ $${slPrice.toFixed(2)} [${slType}]...`);
        try {
            const slLimitPrice = tickRound(isBuy
                ? slPrice - 0.50
                : slPrice + 0.50
            );
            const slOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'limit', closeSide, size, slLimitPrice,
                { triggerPrice: slPrice, reduceOnly: true }
            );
            console.log(`[Execute] ✅ SL placed: ${extractId(slOrder)}`);
        } catch (e: any) {
            console.error(`[Execute] SL failed (non-fatal): ${e.message}`);
        }

        console.log(`[Execute] ✅ Trade live. TP=$${tpPrice.toFixed(2)} SL=$${slPrice.toFixed(2)} (${slType}).`);
        console.log(`${'─'.repeat(65)}\n`);

        return {
            success: true, outcome: 'orders_placed',
            entryPrice: fillPrice, tpPrice, slPrice, slType,
            netProfit, fees,
        };

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}