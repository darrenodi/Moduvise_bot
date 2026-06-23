import * as dotenv from 'dotenv';
import * as fs    from 'fs';
import { RSI, EMA, ADX, ATR } from 'technicalindicators';
import { generateSignals, getSession, detectRegime, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { TechnicalIndicators, MarketRegime } from './signals.js';
import {
    executeBinanceTrade,
    getAvailableBalance,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    triggerEmergencyClose,
    cancelAllOrders,
    getRealizedPnlSince,
    sendAlert,
} from './executeTrade.js';

dotenv.config();

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const BANK_SPLIT    = Number(process.env.BANK_SPLIT    ?? 0.50);
const MAX_TRADES    = Number(process.env.MAX_TRADES_DAY ?? 2000); 

let tradingBalance  = 0;  
let bankedBalance   = 0;  
const startTime     = Date.now();
const initialBalance = { value: 0, set: false };

interface DayStats {
    date:         string;
    fills:        number;
    tpHits:       number;
    slHits:       number;
    skipped:      number;
    grossProfit:  number;
    netProfit:    number;
    slLoss:       number;
}

let stats: DayStats = freshStats();
function freshStats(): DayStats {
    return {
        date:        new Date().toISOString().slice(0, 10),
        fills:       0, tpHits:      0, slHits:   0,
        skipped:     0, grossProfit: 0, netProfit: 0, slLoss: 0,
    };
}

const STATE_FILE = process.env.STATE_FILE ?? './bot-state.json';

function saveState(): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            tradingBalance, bankedBalance, initialBalance, stats,
            savedAt: new Date().toISOString(),
        }, null, 2));
    } catch (e: any) { console.error(`[State] Save failed: ${e.message}`); }
}

function loadState(): void {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        tradingBalance  = raw.tradingBalance  ?? 0;
        bankedBalance   = raw.bankedBalance   ?? 0;
        if (raw.initialBalance) Object.assign(initialBalance, raw.initialBalance);
        const today = new Date().toISOString().slice(0, 10);
        if (raw.stats?.date === today) stats = raw.stats;
        console.log(`[State] Restored — trading: $${tradingBalance.toFixed(4)} | banked: $${bankedBalance.toFixed(4)}`);
    } catch (e: any) { console.error(`[State] Load failed: ${e.message}`); }
}

function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) {
        printDailySummary();
        stats = freshStats();
        stats.date = today;
        saveState();
    }
}

function printDailySummary(): void {
    const tpRate = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';
    console.log(`\n${'█'.repeat(70)}`);
    console.log(`📊 DAILY SUMMARY— ${stats.date}`);
    console.log(`Trades: ${stats.fills} | Win rate: ${tpRate}% | Skipped: ${stats.skipped}`);
    console.log(`Gross: +$${stats.grossProfit.toFixed(4)} | Net: $${stats.netProfit.toFixed(4)} | SL Loss: -$${stats.slLoss.toFixed(4)}`);
    console.log(`💼 Trading Stack:  $${tradingBalance.toFixed(4)} | 🏦 Banked: $${bankedBalance.toFixed(4)}`);
    console.log(`${'█'.repeat(70)}\n`);
}

function applyTradeResult(realizedPnl: number): void {
    if (realizedPnl <= 0) {
        tradingBalance = Math.max(0, tradingBalance + realizedPnl);
        stats.netProfit += realizedPnl;
        stats.slLoss    += Math.abs(realizedPnl);
        console.log(`[Bank] 🔴 Loss: $${realizedPnl.toFixed(4)} | Trading: $${tradingBalance.toFixed(4)} | Banked: $${bankedBalance.toFixed(4)}`);
        return;
    }
    const toBank     = realizedPnl * BANK_SPLIT;
    const toCompound = realizedPnl * (1 - BANK_SPLIT);
    bankedBalance  += toBank;
    tradingBalance += toCompound;
    stats.grossProfit += realizedPnl;
    stats.netProfit   += realizedPnl;
    console.log(`[Bank] 🟢 Profit: +$${realizedPnl.toFixed(4)} | Compounded: +$${toCompound.toFixed(4)} | Banked: +$${toBank.toFixed(4)}`);
}

async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const trade = getActiveTrade();
    if (!trade) return 'none';
    
    const pos = await getOpenPositionDetails();
    if (!pos.exists) {
        console.log(`[Watch] Position missing! Concluding trade.`);
        await cancelAllOrders();
        const real = await getRealizedPnlSince(trade.openedAt - 2000);
        const pnl = real ? real.pnl : 0;
        if (pnl > 0) {
            stats.tpHits++; stats.fills++;
            console.log(`[Result] ✅ TP HIT | Profit: $${pnl.toFixed(4)}`);
        } else if (pnl < 0) {
            stats.slHits++; stats.fills++;
            console.log(`[Result] ❌ SL HIT | Loss: $${pnl.toFixed(4)}`);
        }
        applyTradeResult(pnl);
        clearActiveTrade();
        return pnl > 0 ? 'tp' : 'sl';
    }

    const adverseMove = trade.side === 'long' ? trade.entryPrice - pos.currentPrice : pos.currentPrice - trade.entryPrice;
    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);
    if (adverseMove >= slThreshold * 1.1) {
        await triggerEmergencyClose(trade.side, trade.size, `Fail-safe: adverse move`);
        const real = await getRealizedPnlSince(trade.openedAt - 2000);
        const loss = real ? real.pnl : -(trade.size * adverseMove);
        stats.slHits++; stats.fills++;
        applyTradeResult(loss);
        clearActiveTrade();
        return 'sl';
    }
    return 'open';
}

async function runCycle(): Promise<void> {
    checkReset();
    if (stats.fills >= MAX_TRADES) return;

    try {
        const activeTrade = getActiveTrade();
        if (activeTrade) {
            const timeOpenMs = Date.now() - activeTrade.openedAt;
            
            if (timeOpenMs > 45000) { 
                console.log(`[Watchdog] ⚠️ Trade stale! Open for ${(timeOpenMs / 1000).toFixed(1)}s without hitting TP. Executing aggressive scratch.`);
                
                await cancelAllOrders();
                await triggerEmergencyClose(activeTrade.side, activeTrade.size, '45s TTL Timeout - Market Scratch');
                
                const real = await getRealizedPnlSince(activeTrade.openedAt - 2000);
                const pnl = real ? real.pnl : 0;
                applyTradeResult(pnl);

                clearActiveTrade();
                tradingBalance = await getAvailableBalance();
                saveState();
                return;
            }
        }

        const health = await checkPositionHealth();
        if (health === 'tp' || health === 'sl') {
            saveState();
        }
        if (health === 'open') {
            const openTime = (Date.now() - (activeTrade?.openedAt ?? Date.now())) / 1000;
            console.log(`[Heartbeat] In active trade... Open for ${openTime.toFixed(1)}s`);
            return;
        }

        const symbol = MARKET_SYMBOL;
        interface BinanceTicker { lastPrice: string; highPrice: string; lowPrice: string; }
        interface BinanceDepth { bids: string[][]; asks: string[][]; }
        type BinanceKline = [number, string, string, string, string, string, ...unknown[]];
        
        const [tickerRes, bookRes, klinesRes] = await Promise.all([
            fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json() as Promise<BinanceTicker>),
            fetch(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`).then(r => r.json() as Promise<BinanceDepth>),
            fetch(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`).then(r => r.json() as Promise<BinanceKline[]>),
        ]);

        const currentPrice = Number(tickerRes.lastPrice);
        const topBid = Number(bookRes.bids[0][0]);
        const topAsk = Number(bookRes.asks[0][0]);
        const spreadUsd = topAsk - topBid;

        const bidNot = bookRes.bids.slice(0, 10).reduce((s, v) => s + Number(v[0]) * Number(v[1]), 0);
        const askNot = bookRes.asks.slice(0, 10).reduce((s, v) => s + Number(v[0]) * Number(v[1]), 0);
        const obImbalance = bidNot > askNot ? (bidNot - askNot) / bidNot : -(askNot - bidNot) / askNot;

        const closes = klinesRes.map(k => Number(k[4]));
        const highs = klinesRes.map(k => Number(k[2]));
        const lows = klinesRes.map(k => Number(k[3]));

        const atr5m = Math.max(0.1, ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop() ?? 0.5);

        const liveIndicators: TechnicalIndicators = {
            emaTrend: 'neutral', ema8: currentPrice, ema21: currentPrice, ema50: currentPrice,
            rsi: 50, momentum5m: 0, momentum30m: 0, momentum1h: 0, priceStructure: 'ranging',
            trendBias4h: 'neutral', weeklyBias: 'neutral',
            atr5m, atrPct: atr5m / currentPrice, volumeRatio: 1.0,
            nearestResistance: currentPrice + 10, nearestSupport: currentPrice - 10,
            distanceToResistance: 10, distanceToSupport: 10,
            high24h: Number(tickerRes.highPrice), low24h: Number(tickerRes.lowPrice),
            adx: 20, fundingRate: 0, spreadUsd, obImbalance, priceVsVwap: 0, recentSwingHigh: 0, recentSwingLow: 0
        };

        const signals = generateSignals([{
            indicators: liveIndicators, price: currentPrice, bid: topBid, ask: topAsk,
            symbol, regime: 'normal', regimeReason: 'Normal conditions'
        }]);

        const sig = signals[0];
        if (!sig || sig.direction === 'neutral') return;

        if (tradingBalance <= 0) {
            tradingBalance = await getAvailableBalance();
            if (!initialBalance.set && tradingBalance > 0) {
                initialBalance.value = tradingBalance;
                initialBalance.set = true;
            }
            if (tradingBalance <= 0) return;
        }

        const leverage = sig.suggested_leverage;
        const res = await executeBinanceTrade(sig, tradingBalance, leverage);

        if (res.success && res.outcome === 'orders_placed') {
            console.log(`[Entry] ✅ ${sig.direction.toUpperCase()} maker order posted at $${res.entryPrice}`);
            saveState();
        } else {
            console.log(`[Entry] ⚠️ Trade skipped/failed: ${res.message}`);
        }

    } catch (e: any) {
        console.error(`[Cycle] Error: ${e.message}`);
    }
}

function scheduleNext(): void {
    const session = getSession();
    const ms = Math.floor(Math.random() * 500) + 1500; 
    setTimeout(async () => {
        await runCycle();
        scheduleNext();
    }, ms);
}

process.on('uncaughtException', async (err: Error) => {
    saveState(); process.exit(1);
});
process.on('SIGTERM', async () => {
    saveState(); process.exit(0);
});

loadState();
console.log(`\n${'═'.repeat(70)}`);
console.log(`  MODUVISE XAUUSDT SCALPER — HFMM LIVE BINANCE`);
console.log(`  TRADING BAL : $${tradingBalance.toFixed(4)}`);
console.log(`${'═'.repeat(70)}\n`);
scheduleNext();