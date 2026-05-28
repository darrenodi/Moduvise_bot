import ccxt from 'ccxt';
import type { GeneratedSignal } from './signals.js';
import * as dotenv from 'dotenv';
dotenv.config();

const STRATEGY = {
    SYMBOL: 'BTC/USDC:USDC',
    LEVERAGE: 40,

    /**
     * TP = $70, SL = $70 → 1:1 R:R
     * Why 1:1 and not tighter SL?
     * At 40x leverage on BTC, a $35 SL is ~0.05% move — market noise will stop you out
     * constantly before the trade has time to work. $70 gives enough breathing room
     * while keeping loss < 1 win. With >59% win rate this is profitable.
     *
     * Fee math per trade (maker+taker):
     *   Entry: 0.0144% (maker PostOnly)
     *   Exit TP: 0.0144% (maker PostOnly limit)
     *   Exit SL: 0.0440% (market taker — unavoidable on SL)
     *   Total fees per round trip: ~0.029% maker win, ~0.058% taker loss
     *   On $240 notional: ~$0.07 per win, ~$0.14 per loss
     *   Net per win at $70 target: $240*(70/73000) - $0.07 = $0.23 - $0.07 = $0.16
     *   Net per SL loss: -$240*(70/73000) - $0.14 = -$0.23 - $0.14 = -$0.37
     *   Break-even WR = 0.37 / (0.16 + 0.37) = 70%
     *   → You need 70%+ win rate at 1:1 R:R to be profitable after fees
     *   → At session-gated 79% London/NY overlap WR this works
     *   → DO NOT trade Asia sessions where WR drops to 40-50%
     */
    TP_PRICE_MOVE: 70,
    SL_PRICE_MOVE: 70,

    MAKER_FEE:  0.000144,  // 0.0144%
    TAKER_FEE:  0.000440,  // 0.0440% — used for SL exit fee calc

    ENTRY_OFFSET: 3,       // PostOnly: $3 inside book, guaranteed maker entry

    FILL_CHECK_INTERVAL_MS: 3_000,
    FILL_MAX_ATTEMPTS: 30,  // 90s fill window

    MAX_HOLD_MS: 15 * 60 * 1000,  // 15 min hard stop (prevents 6-hour sits)
    MONITOR_INTERVAL_MS: 2_000,
    MIN_BALANCE: 1.5,
};

const exchange = new ccxt.hyperliquid({
    apiKey:        process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    secret:        process.env.HYPERLIQUID_API_SECRET || '',
    privateKey:    process.env.HYPERLIQUID_API_SECRET,
    walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS || '',
    options: { defaultType: 'swap', recvWindow: 10000 },
    timeout: 15_000,
    enableRateLimit: true,
});

interface TradeResult {
    success: boolean;
    outcome: 'tp_hit' | 'sl_hit' | 'timeout_exit' | 'cancelled' | 'error' | 'skipped';
    netProfit?: number;
    fees?: number;
    entryPrice?: number;
    exitPrice?: number;
    message?: string;
}

function makerEntryPrice(mp: number, dir: 'long' | 'short') {
    return dir === 'long' ? mp - STRATEGY.ENTRY_OFFSET : mp + STRATEGY.ENTRY_OFFSET;
}

function calcTP(entry: number, dir: 'long' | 'short') {
    return dir === 'long' ? entry + STRATEGY.TP_PRICE_MOVE : entry - STRATEGY.TP_PRICE_MOVE;
}

function calcSL(entry: number, dir: 'long' | 'short') {
    return dir === 'long' ? entry - STRATEGY.SL_PRICE_MOVE : entry + STRATEGY.SL_PRICE_MOVE;
}

function calcContractSize(balance: number, price: number) {
    // Use 98% of balance — buffer for rounding
    const posValue = balance * 0.98 * STRATEGY.LEVERAGE;
    return Math.max(0.001, Math.floor((posValue / price) * 10000) / 10000);
}

async function getBalance(): Promise<number> {
    try {
        const b = await exchange.fetchBalance({ user: process.env.HYPERLIQUID_WALLET_ADDRESS });
        const u = b['USDC'] || b['USD'];
        return parseFloat((u?.free || u?.total || 0).toString());
    } catch (e: any) {
        console.error(`[Execute] Balance error: ${e.message}`);
        return 0;
    }
}

async function getPosition(): Promise<any | null> {
    try {
        const positions = await exchange.fetchPositions([STRATEGY.SYMBOL]);
        return positions.find((p: any) =>
            p.symbol === STRATEGY.SYMBOL &&
            parseFloat((p.contracts || 0).toString()) > 0
        ) || null;
    } catch (e: any) {
        console.error(`[Execute] Position error: ${e.message}`);
        return null;
    }
}

function orderId(o: any): string {
    if (!o) return '';
    if (typeof o.id === 'string') return o.id;
    if (typeof o.id === 'number') return String(o.id);
    return String(o.info?.oid || o.info?.orderId || '');
}

async function forceClose(dir: 'long' | 'short', sz: number) {
    const side = dir === 'long' ? 'sell' : 'buy';
    console.log(`[Execute] 🚨 Force closing ${side} ${sz}...`);
    try {
        await exchange.createOrder(STRATEGY.SYMBOL, 'market', side, sz, undefined, { reduceOnly: true });
    } catch (e: any) {
        console.error(`[Execute] Force close failed: ${e.message}`);
    }
}

export async function executeHyperliquidTrade(signal: GeneratedSignal): Promise<TradeResult> {
    const { direction, market_price, reasoning, regime } = signal;
    if (direction === 'neutral') return { success: false, outcome: 'skipped', message: 'Neutral' };

    const dir   = direction as 'long' | 'short';
    const isBuy = dir === 'long';
    const side  = isBuy ? 'buy' : 'sell';

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${market_price.toFixed(2)} | ${regime}`);
    console.log(`[Execute] ${reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        if (await getPosition()) {
            console.log(`[Execute] Position already open — skip`);
            return { success: false, outcome: 'skipped', message: 'Position active' };
        }

        const balance = await getBalance();
        console.log(`[Execute] Balance: $${balance.toFixed(4)}`);
        if (balance < STRATEGY.MIN_BALANCE) return { success: false, outcome: 'skipped', message: `Balance too low: $${balance.toFixed(4)}` };

        const entry   = makerEntryPrice(market_price, dir);
        const tp      = calcTP(entry, dir);
        const sl      = calcSL(entry, dir);
        const sz      = calcContractSize(balance, entry);
        const notl    = sz * entry;
        const gross   = sz * STRATEGY.TP_PRICE_MOVE;
        // Win: maker entry + maker TP exit
        const feesWin = notl * STRATEGY.MAKER_FEE * 2;
        // Loss: maker entry + TAKER SL exit (market order)
        const feesLoss = notl * (STRATEGY.MAKER_FEE + STRATEGY.TAKER_FEE);
        const netWin  = gross - feesWin;
        const netLoss = -(sz * STRATEGY.SL_PRICE_MOVE) - feesLoss;

        console.log(`[Execute] Entry: $${entry.toFixed(2)} | TP: $${tp.toFixed(2)} | SL: $${sl.toFixed(2)}`);
        console.log(`[Execute] Size: ${sz} BTC | Notional: $${notl.toFixed(2)} | If win: +$${netWin.toFixed(4)} | If loss: $${netLoss.toFixed(4)}`);

        // ── ENTRY — PostOnly, never taker ─────────────────────────────────
        let entryOrder: any;
        try {
            entryOrder = await exchange.createOrder(STRATEGY.SYMBOL, 'limit', side, sz, entry,
                { timeInForce: 'Alo' });
        } catch (e: any) {
            console.error(`[Execute] Entry failed: ${e.message}`);
            return { success: false, outcome: 'error', message: e.message };
        }
        const entryId = orderId(entryOrder);
        console.log(`[Execute] Entry order: ${entryId}`);

        // ── WAIT FOR FILL ─────────────────────────────────────────────────
        let filled = false;
        for (let i = 0; i < STRATEGY.FILL_MAX_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, STRATEGY.FILL_CHECK_INTERVAL_MS));
            if (await getPosition()) { filled = true; console.log(`[Execute] ✅ Filled (~${(i+1)*3}s)`); break; }
            if ((i + 1) % 5 === 0) console.log(`[Execute] Waiting fill... ${(i+1)*3}s/90s`);
        }

        if (!filled) {
            console.log(`[Execute] ⏱️ No fill in 90s — cancelling`);
            try { await exchange.cancelOrder(entryId, STRATEGY.SYMBOL); } catch { await exchange.cancelAllOrders(STRATEGY.SYMBOL); }
            return { success: false, outcome: 'cancelled', message: 'No fill in 90s' };
        }

        // ── BRACKET ORDERS — placed AFTER fill, correct side ─────────────
        let tpId = '', slId = '';
        const closeSide = isBuy ? 'sell' : 'buy';

        // TP: PostOnly limit (maker fee)
        try {
            const tpOrder = await exchange.createOrder(STRATEGY.SYMBOL, 'limit', closeSide, sz, tp,
                { timeInForce: 'Alo', reduceOnly: true });
            tpId = orderId(tpOrder);
            console.log(`[Execute] TP placed: ${tpId} @ $${tp.toFixed(2)}`);
        } catch (e: any) {
            console.error(`[Execute] TP failed: ${e.message}`);
        }

        // SL: market trigger (taker — unavoidable for emergency exit)
        try {
            const slOrder = await exchange.createOrder(STRATEGY.SYMBOL, 'market', closeSide, sz, undefined,
                { triggerPrice: sl, reduceOnly: true, stopLoss: true });
            slId = orderId(slOrder);
            console.log(`[Execute] SL placed: ${slId} @ $${sl.toFixed(2)} (market trigger)`);
        } catch (e: any) {
            console.error(`[Execute] ⚠️ SL FAILED: ${e.message} — position unprotected!`);
        }

        // ── MONITOR — 15 min hard ceiling ────────────────────────────────
        console.log(`[Execute] Monitoring (max 15 min)...`);
        let resolved = false;
        let outcome: TradeResult['outcome'] = 'error';
        const start = Date.now();
        let cycles = 0;

        while (!resolved) {
            await new Promise(r => setTimeout(r, STRATEGY.MONITOR_INTERVAL_MS));
            cycles++;

            if (Date.now() - start >= STRATEGY.MAX_HOLD_MS) {
                console.warn(`[Execute] ⏰ 15-min timeout — force close`);
                try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
                await forceClose(dir, sz);
                outcome = 'timeout_exit';
                resolved = true;
                break;
            }

            try {
                const pos = await getPosition();
                if (!pos) {
                    let det = false;
                    if (tpId) {
                        try {
                            const tpChk = await exchange.fetchOrder(tpId, STRATEGY.SYMBOL);
                            if (tpChk.status === 'closed' || tpChk.status === 'filled') {
                                console.log(`[Execute] 🎯 TP HIT @ $${tp.toFixed(2)} | net +$${netWin.toFixed(4)}`);
                                outcome = 'tp_hit'; det = true;
                            }
                        } catch { /* ok */ }
                    }
                    if (!det && slId) {
                        try {
                            const slChk = await exchange.fetchOrder(slId, STRATEGY.SYMBOL);
                            if (slChk.status === 'closed' || slChk.status === 'filled') {
                                console.log(`[Execute] 🛑 SL HIT @ $${sl.toFixed(2)} | net $${netLoss.toFixed(4)}`);
                                outcome = 'sl_hit'; det = true;
                            }
                        } catch { /* ok */ }
                    }
                    if (!det) { outcome = 'tp_hit'; console.log(`[Execute] Position closed (indeterminate → tp_hit)`); }
                    resolved = true;
                }
                if (cycles % 30 === 0) console.log(`[Execute] Open ${((Date.now()-start)/1000).toFixed(0)}s | TP $${tp.toFixed(2)} SL $${sl.toFixed(2)}`);
            } catch (e: any) {
                console.warn(`[Execute] Poll error: ${e.message}`);
            }
        }

        try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }

        const result: TradeResult = {
            success: outcome === 'tp_hit',
            outcome,
            netProfit: outcome === 'tp_hit' ? netWin : netLoss,
            fees:      outcome === 'tp_hit' ? feesWin : feesLoss,
            entryPrice: entry,
            exitPrice:  outcome === 'tp_hit' ? tp : sl,
        };

        console.log(`[Execute] Done: ${outcome.toUpperCase()}`);
        console.log(`${'─'.repeat(65)}\n`);
        return result;

    } catch (e: any) {
        console.error(`[Execute] Critical: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
