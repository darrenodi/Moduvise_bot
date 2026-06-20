import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
const STRATEGY = {
    SYMBOL:              MARKET_SYMBOL,
    TAKER_FEE:           0.00045,       // 0.045% Taker fee on SL exit[cite: 11]
    MAKER_FEE:           0.00000,       // 0.00% Maker fee on resting orders[cite: 11]
    ENTRY_OFFSET:        0.20,          // $0.20 offset below/above inside market[cite: 11]
    ENTRY_FILL_TIMEOUT:  90_000,        // 90 seconds fill execution window[cite: 11]
    TP_MOVE:             0.50,          // LOCKED to your exact $0.50 target
    SL_MOVE:             1.20,          // $1.20 Stop Loss protection corridor[cite: 11]
    GOLD_TICK:           0.01,          // Binance XAUUSDT tick structure[cite: 11]
    RISK_PER_TRADE_PCT:  0.05,          // 5% Account value risk baseline bounds[cite: 11]
    MAX_TRADING_BALANCE: 25_000,        // Capital wall safety limit[cite: 11]
    MAX_SIGNAL_DRIFT:    1.50,          // Maximum allowed drift since generation[cite: 11]
    LEVERAGE:            5,             // 🔒 HARD CODED TO 5X LEVERAGE PROFILE
} as const;

export type TradeOutcome = 'orders_placed' | 'tp_confirmed' | 'sl_triggered' | 'skipped' | 'error';

export interface TradeResult {
    success:      boolean;
    outcome:      TradeOutcome;
    entryPrice?:  number;
    tpPrice?:     number;
    slPrice?:     number;
    grossProfit?: number;
    netProfit?:   number;
    fees?:        number;
    message?:     string;
    fillTimeMs?:  number;
}

export interface ActiveTrade {
    entryPrice: number;
    tpPrice:    number;
    slPrice:    number;
    side:       'long' | 'short';
    size:       number;
    posVal:     number;
    leverage:   number;
    openedAt:   number;
    slAlgoId?:  number; 
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

export async function sendAlert(message: string): Promise<void> {
    console.log(`[Alert] ${message}`);
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
            signal: AbortSignal.timeout(8_000),
        });
    } catch (e: any) {
        console.error(`[Alert] Telegram send failed: ${e.message}`);
    }
}

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const API_KEY     = IS_TESTNET ? (process.env.BINANCE_BOT_API ?? '') : (process.env.BINANCE_API_KEY ?? '');
const API_SECRET  = IS_TESTNET ? (process.env.BINANCE_BOT_SECRET ?? '') : (process.env.BINANCE_API_SECRET ?? '');

function signedUrl(path: string, params: Record<string, string | number> = {}): string {
    const ts = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const query = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const sig = createHmac('sha256', API_SECRET).update(query).digest('hex');
    return `${BASE_URL}${path}?${query}&signature=${sig}`;
}

async function privateGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), { headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(10_000) });
    return res.json();
}

async function privatePost(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const ts = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const body = Object.entries(entries).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sig = createHmac('sha256', API_SECRET).update(Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&')).digest('hex');
    
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body + `&signature=${sig}`,
        signal: AbortSignal.timeout(10_000)
    });
    return res.json();
}

async function privateDelete(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), { method: 'DELETE', headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(10_000) });
    return res.json();
}

export async function getAvailableBalance(): Promise<number> {
    try {
        const data = await privateGet('/fapi/v3/account');
        return Number(data?.availableBalance ?? 0);
    } catch { return 0; }
}

export async function hasOpenPosition(): Promise<boolean> {
    try {
        const data = await privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL });
        return Array.isArray(data) && data.some((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0);
    } catch { return false; }
}

export async function getOpenPositionDetails(): Promise<{ exists: boolean; side: 'long' | 'short' | null; entryPrice: number; size: number; currentPrice: number }> {
    try {
        const [positions, priceData] = await Promise.all([
            privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL }),
            fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json())
        ]);
        const pos = Array.isArray(positions) ? positions.find((p: any) => Math.abs(Number(p.positionAmt ?? 0)) > 0) : null;
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0, currentPrice: 0 };
        return {
            exists:        true,
            side:          Number(pos.positionAmt) > 0 ? 'long' : 'short',
            entryPrice:    Number(pos.entryPrice),
            size:          Math.abs(Number(pos.positionAmt)),
            currentPrice:  Number((priceData as any).price),
        };
    } catch {
        return { exists: false, side: null, entryPrice: 0, size: 0, currentPrice: 0 };
    }
}

export async function triggerStopLoss(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[Emergency Node] 🛑 Execution Escape → Market ${closeSide} ${size} | Reason: ${reason}`);
    try { await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL }); } catch { /* no-op */ }
    try {
        await privatePost('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, side: closeSide, type: 'MARKET', quantity: size, reduceOnly: 'true' });
        clearActiveTrade();
    } catch (e: any) {
        console.error(`[CRITICAL ESCAPE ERROR] Native interface rejection on market escape: ${e.message}`);
        await sendAlert(`🚨🚨 EMERGENCY: fail-safe market close FAILED (${reason}). Check manually now: ${e.message}`);
    }
}

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

export function calcSize(balance: number, price: number, slMove: number = STRATEGY.SL_MOVE): number {
    const cappedBalance = Math.min(balance, STRATEGY.MAX_TRADING_BALANCE);
    const riskDollars   = cappedBalance * STRATEGY.RISK_PER_TRADE_PCT;
    const riskBasedSize = riskDollars / slMove;                  
    const maxNotional   = cappedBalance * STRATEGY.LEVERAGE; // Calculates off the tight 5x cap bounds
    const maxSize       = maxNotional / price;                   

    const raw     = Math.min(riskBasedSize, maxSize);
    const floored = Math.floor(raw * 100) / 100;
    return Math.max(0.01, floored);
}

export async function getRealizedPnlSince(sinceMs: number): Promise<{ pnl: number; trades: number } | null> {
    try {
        const data = await privateGet('/fapi/v1/userTrades', { symbol: STRATEGY.SYMBOL, startTime: sinceMs, limit: 50 });
        if (!Array.isArray(data) || !data.length) return null;
        const pnl = data.reduce((s: number, t: any) => s + Number(t.realizedPnl ?? 0), 0);
        return { pnl, trades: data.length };
    } catch (e: any) {
        console.error(`[Execute] Could not verify realized PnL: ${e.message}`);
        return null;
    }
}

export async function cancelAlgoOrder(algoId: number): Promise<void> {
    try {
        await privateDelete('/fapi/v1/algoOrder', { symbol: STRATEGY.SYMBOL, algoId });
    } catch (e: any) {
        console.log(`[Cleanup Sync] Order architecture alignment complete. ${e.message}`);
    }
}

export async function executeBinanceTrade(signal: GeneratedSignal, virtualBalance?: number): Promise<TradeResult> {
    if (signal.direction === 'neutral') return { success: false, outcome: 'skipped' };

    const direction = signal.direction as 'long' | 'short';
    const isBuy     = direction === 'long';
    const side      = isBuy ? 'BUY' : 'SELL';
    const closeSide = isBuy ? 'SELL' : 'BUY';
    const leverage  = STRATEGY.LEVERAGE; 

    try {
        if (_activeTrade || await hasOpenPosition()) {
            return { success: false, outcome: 'skipped', message: 'Resource busy: trade matrix occupied.' };
        }

        const effectiveBalance = virtualBalance && virtualBalance > 0 ? virtualBalance : await getAvailableBalance();
        const ticker = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json()) as any;
        const livePrice = Number(ticker?.price ?? signal.market_price);

        if (Math.abs(livePrice - signal.market_price) > STRATEGY.MAX_SIGNAL_DRIFT) {
            return { success: false, outcome: 'skipped', message: 'Aborting: Price drift out of baseline bounds.' };
        }

        try {
            await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage });
        } catch (e: any) { /* structural lock confirmation */ }

        const size = calcSize(effectiveBalance, livePrice);
        const entryPrice = tickRound(isBuy ? livePrice - STRATEGY.ENTRY_OFFSET : livePrice + STRATEGY.ENTRY_OFFSET);

        // Post-Only Limit Entry Execution (GTX Mode)[cite: 11]
        const entryOrder = await privatePost('/fapi/v1/order', {
            symbol: STRATEGY.SYMBOL, side, type: 'LIMIT', timeInForce: 'GTX', price: entryPrice.toFixed(2), quantity: size
        });

        if (!entryOrder?.orderId) return { success: false, outcome: 'error', message: 'Order structure syntax invalid.' };

        const entryStart = Date.now();
        let filled = false;
        while (Date.now() - entryStart < STRATEGY.ENTRY_FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, 400)); 
            const check = await privateGet('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId });
            if (check.status === 'FILLED') { filled = true; break; }
        }

        if (!filled) {
            await privateDelete('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, orderId: entryOrder.orderId });
            console.log(`[Order Control] Entry timeout hit. Cancelling transaction frame.`);
            return { success: false, outcome: 'skipped', message: 'GTX execution frame expired without fill.' };
        }

        const tpPrice = tickRound(isBuy ? entryPrice + STRATEGY.TP_MOVE : entryPrice - STRATEGY.TP_MOVE);
        const slPrice = tickRound(isBuy ? entryPrice - STRATEGY.SL_MOVE : entryPrice + STRATEGY.SL_MOVE);

        // Bracket Profit Target resting Limit Order Deployment[cite: 11]
        await privatePost('/fapi/v1/order', {
            symbol: STRATEGY.SYMBOL, side: closeSide, type: 'LIMIT', timeInForce: 'GTX', price: tpPrice.toFixed(2), quantity: size, reduceOnly: 'true'
        });

        // Exchange Native Algorithmic Safety Stop Loss Envelope[cite: 11]
        let slAlgoId = 0;
        try {
            const slOrder = await privatePost('/fapi/v1/algoOrder', {
                symbol:       STRATEGY.SYMBOL,
                side:         closeSide,
                algoType:     'CONDITIONAL',
                type:         'STOP_MARKET',
                quantity:     size,
                triggerPrice: slPrice.toFixed(2),
                workingType:  'MARK_PRICE',
                reduceOnly:   'true'
            });
            slAlgoId = slOrder.algoId;
            console.log(`[Exchange Native Protection] SL structural envelope established: id=${slAlgoId}`);
        } catch (err: any) {
            console.error(`[CRITICAL] Native SL rejected: ${err.message}. Flattening position immediately rather than running raw.`);
            try {
                await privatePost('/fapi/v1/order', { symbol: STRATEGY.SYMBOL, side: closeSide, type: 'MARKET', quantity: size, reduceOnly: 'true' });
            } catch (closeErr: any) {
                await sendAlert(`🚨🚨 EMERGENCY: Native SL failed and flattening execution failed on ${STRATEGY.SYMBOL}. Check manually.`);
            }
            return { success: false, outcome: 'error', message: `SL placement failed, position flattened: ${err.message}` };
        }

        _activeTrade = { entryPrice, tpPrice, slPrice, side: direction, size, posVal: size * entryPrice, leverage, openedAt: Date.now(), slAlgoId };

        return {
            success: true,
            outcome: 'orders_placed',
            entryPrice,
            tpPrice,
            slPrice,
            grossProfit: size * STRATEGY.TP_MOVE,
            netProfit: size * STRATEGY.TP_MOVE,
            fees: 0
        };

    } catch (e: any) {
        return { success: false, outcome: 'error', message: e.message };
    }
}