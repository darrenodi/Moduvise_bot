import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL, calcAtrRegime, safeLeverage } from './signals.js';
dotenv.config();

// ─── STRATEGY ────────────────────────────────────────────────────────────────
//
// Gold (XAUUSDT) on Binance USDⓈ-M Futures — dynamic leverage + dynamic TP.
//
// FEES (XAUUSDT Perp):
//   Maker: 0.0180%  (GTC limit TP order)
//   Taker: 0.0450%  (market entry + SL)
//
// MODEL: Hybrid Taker/Maker
//   ENTRY:  Market Taker → guaranteed fill    0.0450%
//   TP:     GTC Maker limit → resting on book 0.0180%
//   SL:     Market Taker → monitored by main  0.0450%
//
// GATE: gross profit > fees × 3 — prevents fee-eating micro trades.
//
// ARCHITECTURE: decoupled — returns immediately after entry + TP placed.
// main.ts monitors SL every cycle independently.

const STRATEGY = {
    SYMBOL:              MARKET_SYMBOL,       // 'XAUUSDT'
    TAKER_FEE:           0.000450,            // 0.0450%
    MAKER_FEE:           0.000180,            // 0.0180%
    MIN_BALANCE:         1.50,
    GOLD_TICK:           0.10,
    MAX_TRADING_BALANCE: 20_000,
    MAX_SIGNAL_DRIFT:    5.00,
    MIN_FEE_MULTIPLE:    3,
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type TradeOutcome =
    | 'orders_placed'
    | 'tp_confirmed'
    | 'sl_triggered'
    | 'skipped'
    | 'error';

export interface TradeResult {
    success:      boolean;
    outcome:      TradeOutcome;
    entryPrice?:  number;
    tpPrice?:     number;
    slPrice?:     number;
    tpMove?:      number;
    leverage?:    number;
    sizePct?:     number;
    grossProfit?: number;
    netProfit?:   number;
    fees?:        number;
    message?:     string;
    fillTimeMs?:  number;
}

// ─── ACTIVE TRADE STATE ───────────────────────────────────────────────────────

export interface ActiveTrade {
    entryPrice: number;
    tpPrice:    number;
    slPrice:    number;
    tpMove:     number;
    side:       'long' | 'short';
    size:       number;
    posVal:     number;
    leverage:   number;
    openedAt:   number;
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

// ─── EXCHANGE ─────────────────────────────────────────────────────────────────

const IS_TESTNET = process.env.ENVIRONMENT === 'testnet';

const exchange = new (ccxt as any).binanceusdm({
    apiKey:          process.env.BINANCE_API_KEY    ?? '',
    secret:          process.env.BINANCE_API_SECRET ?? '',
    timeout:         15_000,
    enableRateLimit: true,
    options: { defaultType: 'future' },
    ...(IS_TESTNET ? {
        urls: {
            api: {
                public:  'https://testnet.binancefuture.com',
                private: 'https://testnet.binancefuture.com',
            },
        },
    } : {}),
});

console.log(`[Exchange] Binance USDM Futures | Mode: ${IS_TESTNET ? '🧪 TESTNET' : '🔴 MAINNET'}`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

export async function getAvailableBalance(): Promise<number> {
    try {
        const bal  = await exchange.fetchBalance({ type: 'future' });
        const usdt = bal['USDT'];
        return Number(usdt?.free ?? usdt?.total ?? 0);
    } catch (e: any) {
        console.error(`[Execute] Balance error: ${e.message}`);
        return 0;
    }
}

export async function hasOpenPosition(): Promise<boolean> {
    try {
        const positions = await exchange.fetchPositions([STRATEGY.SYMBOL]);
        return positions.some((p: any) =>
            Math.abs(Number(p.info?.positionAmt ?? p.contracts ?? 0)) > 0
        );
    } catch {
        return false;
    }
}

export async function getOpenPositionDetails(): Promise<{
    exists:        boolean;
    side:          'long' | 'short' | null;
    entryPrice:    number;
    size:          number;
    unrealisedPnl: number;
    currentPrice:  number;
}> {
    try {
        const [positions, ticker] = await Promise.all([
            exchange.fetchPositions([STRATEGY.SYMBOL]),
            exchange.fetchTicker(STRATEGY.SYMBOL).catch(() => ({ last: 0 })),
        ]);
        const pos = positions.find((p: any) =>
            Math.abs(Number(p.info?.positionAmt ?? p.contracts ?? 0)) > 0
        );
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };

        const posAmt        = Number(pos.info?.positionAmt ?? pos.contracts ?? 0);
        const size          = Math.abs(posAmt);
        const entry         = Number(pos.entryPrice ?? pos.info?.entryPrice ?? 0);
        const side          = posAmt > 0 ? 'long' : 'short';
        const unrealisedPnl = Number(pos.unrealizedPnl ?? pos.info?.unRealizedProfit ?? 0);
        const currentPrice  = Number((ticker as any).last ?? entry);
        return { exists: true, side, entryPrice: entry, size, unrealisedPnl, currentPrice };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0, unrealisedPnl: 0, currentPrice: 0 };
    }
}

// ─── SL TRIGGER ───────────────────────────────────────────────────────────────

export async function triggerStopLoss(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'sell' : 'buy';
    console.log(`[Execute] 🛑 STOP LOSS (${reason}) — market ${closeSide} ${size}`);
    try { await exchange.cancelAllOrders(STRATEGY.SYMBOL); } catch { /* ok */ }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await exchange.createOrder(
                STRATEGY.SYMBOL, 'market', closeSide, size, undefined,
                { reduceOnly: true }
            );
            console.log(`[Execute] SL submitted (attempt ${attempt}).`);
            clearActiveTrade();
            return;
        } catch (e: any) {
            console.error(`[Execute] SL attempt ${attempt} FAILED: ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1_500));
        }
    }
    console.error(`[Execute] ⚠️ All SL attempts failed — position may still be open!`);
}

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

// ─── DYNAMIC SIZE CALCULATION ─────────────────────────────────────────────────
// Binance XAUUSDT quantity is in XAU (troy oz).
// Min order size: 0.01 XAU.

export function calcSize(balance: number, price: number, sizePct: number, leverage: number): number {
    const cappedBalance = Math.min(balance, STRATEGY.MAX_TRADING_BALANCE);
    const usable        = cappedBalance * sizePct;
    const posVal        = usable * leverage;
    const raw           = posVal / price;
    const floored       = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

// ─── FEE GATE ─────────────────────────────────────────────────────────────────

function passesFeeGate(size: number, tpMove: number, entryPrice: number): boolean {
    const posVal    = size * entryPrice;
    const takerFee  = posVal * STRATEGY.TAKER_FEE;
    const makerFee  = posVal * STRATEGY.MAKER_FEE;
    const totalFees = takerFee + makerFee;
    const gross     = size * tpMove;
    const multiple  = totalFees > 0 ? gross / totalFees : 999;
    const passes    = multiple >= STRATEGY.MIN_FEE_MULTIPLE;

    console.log(`[Execute] Fee gate: gross=$${gross.toFixed(4)} fees=$${totalFees.toFixed(4)} multiple=${multiple.toFixed(1)}x (need ${STRATEGY.MIN_FEE_MULTIPLE}x) → ${passes ? '✅ PASS' : '❌ FAIL'}`);
    return passes;
}

// ─── MAIN EXECUTION ───────────────────────────────────────────────────────────

export async function executeBinanceTrade(
    signal:          GeneratedSignal,
    virtualBalance?: number,
): Promise<TradeResult> {

    if (signal.direction === 'neutral') {
        return { success: false, outcome: 'skipped', message: 'Neutral signal' };
    }

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'buy'  : 'sell';
    const closeSide = isBuy ? 'sell' : 'buy';

    const tpMove   = signal.suggested_tp       ?? signal.target_move ?? 3.00;
    const leverage = signal.suggested_leverage ?? 20;
    const sizePct  = signal.session_size_pct   ?? 0.80;

    console.log(`\n${'─'.repeat(65)}`);
    console.log(`[Execute] XAUUSDT ${isBuy ? 'LONG 📈' : 'SHORT 📉'} | $${signal.market_price.toFixed(2)} | conf=${signal.confidence.toFixed(2)}`);
    console.log(`[Execute] TP=$${tpMove.toFixed(2)} | SL=$${tpMove.toFixed(2)} | Lev=${leverage}x | Size=${(sizePct * 100).toFixed(0)}% | ${IS_TESTNET ? '🧪 TESTNET' : '🔴 LIVE'}`);
    console.log(`[Execute] ${signal.reasoning}`);
    console.log(`${'─'.repeat(65)}`);

    try {
        // ── 1. POSITION GUARD ─────────────────────────────────────────────
        if (_activeTrade || await hasOpenPosition()) {
            console.log(`[Execute] 🛑 Position already open — skip.`);
            return { success: false, outcome: 'skipped', message: 'Position already open' };
        }

        // ── 2. BALANCE ────────────────────────────────────────────────────
        const balance          = await getAvailableBalance();
        const effectiveBalance = virtualBalance ?? balance;
        console.log(`[Execute] Balance: $${balance.toFixed(4)} | Virtual: $${effectiveBalance.toFixed(4)}`);
        if (balance < STRATEGY.MIN_BALANCE) {
            return { success: false, outcome: 'skipped', message: `Low balance: $${balance.toFixed(4)}` };
        }

        // ── 3. LEVERAGE — set dynamically per trade ────────────────────────
        // Binance: setLeverage on XAUUSDT, isolated margin mode
        try {
            await exchange.setLeverage(leverage, STRATEGY.SYMBOL);
            console.log(`[Execute] Leverage set: ${leverage}x`);
        } catch (e: any) {
            if (!/already|same/i.test(e.message ?? '')) {
                console.warn(`[Execute] Leverage warn: ${e.message}`);
            }
        }

        // ── 4. MARGIN MODE — isolated ─────────────────────────────────────
        try {
            await exchange.setMarginMode('isolated', STRATEGY.SYMBOL);
            console.log(`[Execute] Margin mode: isolated`);
        } catch (e: any) {
            // Binance throws if already isolated — safe to ignore
            if (!/already|No need/i.test(e.message ?? '')) {
                console.warn(`[Execute] Margin mode warn: ${e.message}`);
            }
        }

        // ── 5. STALE SIGNAL CHECK ─────────────────────────────────────────
        let livePrice = signal.market_price;
        try {
            const ticker = await exchange.fetchTicker(STRATEGY.SYMBOL);
            livePrice    = ticker.last ?? signal.market_price;
        } catch { /* use signal price */ }

        const drift = Math.abs(livePrice - signal.market_price);
        if (drift > STRATEGY.MAX_SIGNAL_DRIFT) {
            console.log(`[Execute] ⏩ Stale signal — drifted $${drift.toFixed(2)}. Skip.`);
            return { success: false, outcome: 'skipped', message: `Signal stale: $${drift.toFixed(2)} drift` };
        }

        // ── 6. SIZE ───────────────────────────────────────────────────────
        const size   = calcSize(effectiveBalance, livePrice, sizePct, leverage);
        const posVal = size * livePrice;
        console.log(`[Execute] Size: ${size} XAU | Notional: ~$${posVal.toFixed(2)} | Margin: ~$${(posVal / leverage).toFixed(2)}`);

        // ── 7. FEE GATE ───────────────────────────────────────────────────
        if (!passesFeeGate(size, tpMove, livePrice)) {
            return { success: false, outcome: 'skipped', message: 'Fee gate: gross < fees × 3' };
        }

        // ── 8. TAKER MARKET ENTRY ─────────────────────────────────────────
        const entryStart = Date.now();
        let fillPrice    = livePrice;

        try {
            const entryOrder = await exchange.createOrder(
                STRATEGY.SYMBOL, 'market', side, size, undefined, {}
            );
            const fillTimeMs = Date.now() - entryStart;

            fillPrice = Number(
                entryOrder.average    ??
                entryOrder.price      ??
                entryOrder.info?.avgPrice ??
                livePrice
            );

            console.log(`[Execute] ✅ TAKER ENTRY: ${size} XAU @ $${fillPrice.toFixed(2)} (${fillTimeMs}ms)`);

            // ── 9. MAKER GTC LIMIT TP — resting on book ───────────────────
            const tpPrice = tickRound(isBuy ? fillPrice + tpMove : fillPrice - tpMove);
            const slPrice = tickRound(isBuy ? fillPrice - tpMove : fillPrice + tpMove);

            const takerFee  = posVal * STRATEGY.TAKER_FEE;
            const makerFee  = posVal * STRATEGY.MAKER_FEE;
            const totalFees = takerFee + makerFee;
            const gross     = size * tpMove;
            const net       = gross - totalFees;

            console.log(`[Execute] TP=$${tpPrice.toFixed(2)} (+$${tpMove.toFixed(2)}) | SL=$${slPrice.toFixed(2)} (-$${tpMove.toFixed(2)}) | 1:1 R:R`);
            console.log(`[Execute] Gross=$${gross.toFixed(4)} | Fees=T:$${takerFee.toFixed(4)}+M:$${makerFee.toFixed(4)}=$${totalFees.toFixed(4)} | Net=$${net.toFixed(4)}`);

            // Binance: GTC reduceOnly limit order for TP (maker)
            try {
                const tpOrder = await exchange.createOrder(
                    STRATEGY.SYMBOL, 'limit', closeSide, size, tpPrice,
                    { timeInForce: 'GTC', reduceOnly: true }
                );
                console.log(`[Execute] ✅ MAKER TP placed: orderId=${tpOrder.id}`);
            } catch (e: any) {
                console.error(`[Execute] TP order failed: ${e.message} — SL in main.ts will protect.`);
            }

            _activeTrade = {
                entryPrice: fillPrice, tpPrice, slPrice, tpMove,
                side: direction, size, posVal, leverage,
                openedAt: Date.now(),
            };

            console.log(`[Execute] ✅ Decoupled — main.ts monitors SL@$${slPrice.toFixed(2)} TP@$${tpPrice.toFixed(2)}`);
            console.log(`${'─'.repeat(65)}\n`);

            return {
                success: true, outcome: 'orders_placed',
                entryPrice: fillPrice, tpPrice, slPrice, tpMove, leverage, sizePct,
                grossProfit: gross, netProfit: net, fees: totalFees, fillTimeMs,
            };

        } catch (e: any) {
            console.error(`[Execute] Market entry failed: ${e.message}`);
            return { success: false, outcome: 'error', message: `Entry failed: ${e.message}` };
        }

    } catch (e: any) {
        console.error(`[Execute] Fatal: ${e.message}`);
        return { success: false, outcome: 'error', message: e.message };
    }
}
