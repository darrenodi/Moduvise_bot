import * as dotenv from 'dotenv';
import type { GeneratedSignal } from './signals.js';
import { MARKET_SYMBOL } from './signals.js';
import { createHmac } from 'crypto';
dotenv.config();

// ─── STRATEGY PARAMETERS ──────────────────────────────────────────────────────
const STRATEGY = {
    SYMBOL:           MARKET_SYMBOL,
    TP_MOVE:          0.20,
    GOLD_TICK:        0.01,
    MIN_QTY:          0.001,
    QTY_STEP:         0.001,
    MIN_NOTIONAL:     5.0,
    LEVERAGE:         Number(process.env.BOT_LEVERAGE ?? 50),
    MAKER_FEE:        Number(process.env.MAKER_FEE_PCT ?? 0.0),
    TAKER_FEE:        0.0002,
    MAX_SIGNAL_DRIFT: 2.00,
} as const;

// ─── INTERFACES ───────────────────────────────────────────────────────────────
export type TradeOutcome = 'orders_placed' | 'tp_confirmed' | 'sl_triggered' | 'skipped' | 'error';

export interface TradeResult {
    success:       boolean;
    outcome:       TradeOutcome;
    entryPrice?:   number;
    tpPrice?:      number;
    slPrice?:      number;
    grossProfit?:  number;
    netProfit?:    number;
    fees?:         number;
    message?:      string;
    fillTimeMs?:   number;
}

export interface ActiveTrade {
    entryPrice:   number;
    tpPrice:      number;
    slPrice:      number;
    slBackupPrice: number;
    side:         'long' | 'short';
    size:         number;
    margin:       number;
    posVal:       number;
    leverage:     number;
    openedAt:     number;
    tpOrderId?:   number;
    slAlgoId?:    number;
    slBackupId?:  number;
}

let _activeTrade: ActiveTrade | null = null;
export function getActiveTrade(): ActiveTrade | null { return _activeTrade; }
export function clearActiveTrade(): void { _activeTrade = null; }

// ─── ALERTING ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   ?? '';

export async function sendAlert(message: string): Promise<void> {
    console.log(`[Alert] ${message}`);
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `🤖 ${message}` }),
            signal:  AbortSignal.timeout(8_000),
        });
    } catch (e: any) {
        console.error(`[Alert] Telegram failed: ${e.message}`);
    }
}

// ─── API INFRASTRUCTURE ────────────────────────────────────────────────────────
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const API_KEY    = IS_TESTNET ? (process.env.BINANCE_BOT_API    ?? '') : (process.env.BINANCE_API_KEY    ?? '');
const API_SECRET = IS_TESTNET ? (process.env.BINANCE_BOT_SECRET ?? '') : (process.env.BINANCE_API_SECRET ?? '');

function signedUrl(path: string, params: Record<string, string | number> = {}): string {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const query   = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(query).digest('hex');
    return `${BASE_URL}${path}?${query}&signature=${sig}`;
}

async function privateGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), {
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

async function privatePost(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const rawQ    = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const body    = Object.entries(entries).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(rawQ).digest('hex');
    const res = await fetch(`${BASE_URL}${path}`, {
        method:  'POST',
        headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body + `&signature=${sig}`,
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

export async function privateDelete(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const res = await fetch(signedUrl(path, params), {
        method:  'DELETE',
        headers: { 'X-MBX-APIKEY': API_KEY },
        signal:  AbortSignal.timeout(10_000),
    });
    return res.json();
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
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

export async function getOpenPositionDetails(): Promise<{ exists: boolean; side: 'long' | 'short' | null; entryPrice: number; size: number; currentPrice: number; }> {
    try {
        const [positions, priceData] = await Promise.all([
            privateGet('/fapi/v3/positionRisk', { symbol: STRATEGY.SYMBOL }),
            fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${STRATEGY.SYMBOL}`).then(r => r.json())
        ]);
        const pos = Array.isArray(positions) ? positions.find((p: any) => p.symbol === STRATEGY.SYMBOL) : null;
        if (!pos) return { exists: false, side: null, entryPrice: 0, size: 0, currentPrice: 0 };
        const amt = Number(pos.positionAmt);
        return {
            exists: Math.abs(amt) > 0,
            side: amt > 0 ? 'long' : amt < 0 ? 'short' : null,
            entryPrice: Number(pos.entryPrice),
            size: Math.abs(amt),
            // THE FIX: Explicitly cast priceData to 'any' to access .price
            currentPrice: Number((priceData as any).price) 
        };
    } catch { return { exists: false, side: null, entryPrice: 0, size: 0, currentPrice: 0 }; }
}

export async function getRealizedPnlSince(startTime: number): Promise<{ pnl: number } | null> {
    try {
        const data = await privateGet('/fapi/v1/userTrades', { symbol: STRATEGY.SYMBOL, startTime });
        if (!Array.isArray(data) || data.length === 0) return null;
        const pnl = data.reduce((sum, t) => sum + Number(t.realizedPnl) - Number(t.commission), 0);
        return { pnl };
    } catch { return null; }
}

export async function cancelAllOrders(): Promise<void> {
    try { await privateDelete('/fapi/v1/allOpenOrders', { symbol: STRATEGY.SYMBOL }); } catch { /* ignore */ }
}

export async function triggerEmergencyClose(side: 'long' | 'short', size: number, reason: string): Promise<void> {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    console.log(`[EMERGENCY] 🛑 Market ${closeSide} ${size} XAU | ${reason}`);
    await cancelAllOrders();
    try {
        await privatePost('/fapi/v1/order', {
            symbol: STRATEGY.SYMBOL,
            side: closeSide,
            type: 'MARKET',
            quantity: size,
            reduceOnly: 'true',
        });
        clearActiveTrade();
    } catch (e: any) {
        console.error(`[EMERGENCY] Close FAILED: ${e.message}`);
        await sendAlert(`🚨 EMERGENCY CLOSE FAILED on ${STRATEGY.SYMBOL} ${size} XAU. ${e.message}`);
    }
}

function tickRound(price: number): number {
    return Math.round(price / STRATEGY.GOLD_TICK) * STRATEGY.GOLD_TICK;
}

export function calcSize(balance: number, price: number): number {
    const notional = balance * STRATEGY.LEVERAGE;
    let qty = notional / price;
    const steps = Math.floor(qty / STRATEGY.QTY_STEP);
    return Math.max(STRATEGY.MIN_QTY, steps * STRATEGY.QTY_STEP);
}

// ─── EXECUTION ENGINE ─────────────────────────────────────────────────────────
export async function executeBinanceTrade(signal: GeneratedSignal, tradingBalance: number, leverage: number): Promise<TradeResult> {
    const fillStart = Date.now();
    try {
        // --- TYPE FIX IS HERE ---
        if (signal.direction === 'neutral') {
            return { success: false, outcome: 'skipped', message: 'Neutral signal skipped.' };
        }
        const direction = signal.direction as 'long' | 'short';
        
        const isBuy = direction === 'long';
        const side  = isBuy ? 'BUY' : 'SELL';
        const closeSide = isBuy ? 'SELL' : 'BUY';

        try { await privatePost('/fapi/v1/leverage', { symbol: STRATEGY.SYMBOL, leverage }); } catch { /* ignore */ }

        const dynamicOffset = Math.max(0.01, signal.spread_usd * 0.5); 
        const dynamicSlDistance = Math.max(0.40, signal.atr_usd * 1.5); 

        let actualEntry: number;
        let tpPrice: number;
        let slPrice: number;
        let slBackupPrice: number;

        if (direction === 'long') {
            actualEntry   = signal.bid - dynamicOffset;
            tpPrice       = actualEntry + STRATEGY.TP_MOVE;
            slPrice       = actualEntry - dynamicSlDistance;
            slBackupPrice = slPrice - 0.50; 
        } else {
            actualEntry   = signal.ask + dynamicOffset;
            tpPrice       = actualEntry - STRATEGY.TP_MOVE;
            slPrice       = actualEntry + dynamicSlDistance;
            slBackupPrice = slPrice + 0.50;
        }

        actualEntry   = tickRound(actualEntry);
        tpPrice       = tickRound(tpPrice);
        slPrice       = tickRound(slPrice);
        slBackupPrice = tickRound(slBackupPrice);

        const size = calcSize(tradingBalance, actualEntry);
        const margin = tradingBalance; 

        await privatePost('/fapi/v1/order', {
            symbol: STRATEGY.SYMBOL,
            side,
            type: 'LIMIT',
            timeInForce: 'GTX',
            price: actualEntry.toFixed(2),
            quantity: size.toFixed(3)
        });

        let tpOrderId = 0;
        try {
            const tpOrder = await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL,
                side: closeSide,
                type: 'LIMIT',
                timeInForce: 'GTC',
                price: tpPrice.toFixed(2),
                quantity: size.toFixed(3),
                reduceOnly: 'true',
            });
            tpOrderId = tpOrder.orderId ?? 0;
        } catch (e: any) {
            console.error(`[TP] TP limit placement failed: ${e.message}`);
        }

        let slAlgoId = 0;
        let slBackupId = 0;
        try {
            const slOrder = await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL,
                side: closeSide,
                type: 'STOP_MARKET',
                stopPrice: slPrice.toFixed(2),
                closePosition: 'true'
            });
            slAlgoId = slOrder.orderId ?? 0;

            const slBackup = await privatePost('/fapi/v1/order', {
                symbol: STRATEGY.SYMBOL,
                side: closeSide,
                type: 'STOP_MARKET',
                stopPrice: slBackupPrice.toFixed(2),
                closePosition: 'true'
            });
            slBackupId = slBackup.orderId ?? 0;
        } catch (e: any) {
            console.error(`[SL] Placement failed: ${e.message}`);
        }

        if (!slAlgoId && !slBackupId) {
            await triggerEmergencyClose(direction, size, 'SL placement failure');
            return { success: false, outcome: 'error', message: 'SL failed, emergency closed.' };
        }

        _activeTrade = {
            entryPrice:    actualEntry,
            tpPrice,
            slPrice,
            slBackupPrice,
            side:          direction, // Uses the strictly typed variable now
            size,
            margin,
            posVal:        size * actualEntry,
            leverage,
            openedAt:      Date.now(),
            tpOrderId,
            slAlgoId,
            slBackupId,
        };

        return {
            success:     true,
            outcome:     'orders_placed',
            entryPrice:  actualEntry,
            tpPrice,
            slPrice,
            grossProfit: size * STRATEGY.TP_MOVE,
            netProfit:   size * STRATEGY.TP_MOVE,
            fees:        0,
            fillTimeMs:  Date.now() - fillStart,
        };

    } catch (e: any) {
        return { success: false, outcome: 'error', message: e.message };
    }
}