import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { RSI, EMA, ADX, ATR } from 'technicalindicators';
import { generateSignals, getSession, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import {
    executeBinanceTrade,
    getAvailableBalance,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    triggerStopLoss,
    cancelAlgoOrder,
    getRealizedPnlSince,
    sendAlert
} from './executeTrade.js';

dotenv.config();

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const CONFIG = {
    MAX_TRADES_DAY:      400,
    MAX_TRADING_BALANCE: 25_000, 
    BANK_THRESHOLD:      5.00,   
    BANK_FRACTION:       0.30,   
} as const;

interface DayStats {
    date: string; attempts: number; fills: number; tpHits: number;
    slHits: number; skipped: number; grossProfit: number; netProfit: number;
    slLoss: number; totalTakerFees: number; fillTimes: number[];
}

let stats: DayStats = freshStats();
function freshStats(): DayStats {
    return {
        date: new Date().toISOString().slice(0, 10),
        attempts: 0, fills: 0, tpHits: 0, slHits: 0, skipped: 0,
        grossProfit: 0, netProfit: 0, slLoss: 0, totalTakerFees: 0, fillTimes: [],
    };
}

let virtualTradingBalance = 0;   
let accumulatedNetProfit  = 0;   
let totalBanked           = 0;   
const startTime           = Date.now();
const initialBalance      = { value: 0, set: false };

const STATE_FILE = process.env.STATE_FILE ?? './bot-state.json';

function saveState(): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            virtualTradingBalance, accumulatedNetProfit, totalBanked,
            initialBalance, stats, savedAt: new Date().toISOString(),
        }, null, 2));
    } catch (e: any) {
        console.error(`[State] Failed to save: ${e.message}`);
    }
}

function loadState(): void {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        virtualTradingBalance = raw.virtualTradingBalance ?? 0;
        accumulatedNetProfit  = raw.accumulatedNetProfit  ?? 0;
        totalBanked           = raw.totalBanked           ?? 0;
        if (raw.initialBalance) Object.assign(initialBalance, raw.initialBalance);
        if (raw.stats && raw.stats.date === new Date().toISOString().slice(0, 10)) {
            stats = raw.stats; 
        }
        console.log(`[State] Restored baseline parameters: vBal=$${virtualTradingBalance.toFixed(2)}`);
    } catch (e: any) {
        console.error(`[State] Core framework init fresh: ${e.message}`);
    }
}

function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) { 
        printDailySummary(); 
        sendAlert(`📊 Day ${stats.date} Summary Report: Completed ${stats.fills} trade segments.`);
        stats = freshStats(); 
        stats.date = today; 
        saveState();
    }
}

function printDailySummary(): void {
    const total   = virtualTradingBalance + totalBanked;
    const uptime  = ((Date.now() - startTime) / 3600_000).toFixed(1);
    const tpRate  = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';

    console.log(`\n${'█'.repeat(70)}`);
    console.log(`📊 CORE OPERATIONAL DATA MATRIX — 5X PROFILE`);
    console.log(`Fills: ${stats.fills} | Success Ratio: ${tpRate}% | Total Skipped: ${stats.skipped}`);
    console.log(`Gross profit yield: +$${stats.grossProfit.toFixed(4)} | Net: +$${stats.netProfit.toFixed(4)}`);
    console.log(`💼 Active Compounding Bankroll Base: $${virtualTradingBalance.toFixed(2)}`);
    console.log(`🏦 Spot Reserves Vault Balance: $${totalBanked.toFixed(2)}`);
    console.log(`${'█'.repeat(70)}\n`);
}

function bankProfit(netProfit: number, takerFeeCost = 0): void {
    stats.totalTakerFees += takerFeeCost;

    if (netProfit <= 0) {
        virtualTradingBalance = Math.max(1.50, virtualTradingBalance + netProfit);
        console.log(`[Risk Node] Net draw down processed: -$${Math.abs(netProfit).toFixed(4)}`);
        return;
    }

    if (virtualTradingBalance >= CONFIG.MAX_TRADING_BALANCE) {
        accumulatedNetProfit += netProfit;
        totalBanked          += netProfit;
        stats.netProfit      += netProfit;
        return;
    }

    accumulatedNetProfit += netProfit;
    stats.netProfit      += netProfit;
    stats.grossProfit    += netProfit;

    if (accumulatedNetProfit >= CONFIG.BANK_THRESHOLD) {
        const toVault     = accumulatedNetProfit * CONFIG.BANK_FRACTION;
        const toCompound  = accumulatedNetProfit * (1 - CONFIG.BANK_FRACTION);

        totalBanked            += toVault;
        virtualTradingBalance   = Math.min(virtualTradingBalance + toCompound, CONFIG.MAX_TRADING_BALANCE);
        accumulatedNetProfit    = 0;  

        console.log(`[Vault Allocation] 🏦 Banked: $${toVault.toFixed(4)} | Compounded: $${toCompound.toFixed(4)}`);
    } else {
        virtualTradingBalance = Math.min(virtualTradingBalance + netProfit, CONFIG.MAX_TRADING_BALANCE);
    }
}

async function buildLiveMarketData(symbol: string): Promise<MarketData[]> {
    interface BinanceTickerResponse { lastPrice: string; highPrice: string; lowPrice: string; priceChangePercent: string; }
    interface BinanceDepthResponse { bids: string[][]; asks: string[][]; }
    type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

    const [tickerRes, bookRes, klinesRes] = await Promise.all([
        fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json() as Promise<BinanceTickerResponse>),
        fetch(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`).then(r => r.json() as Promise<BinanceDepthResponse>),
        fetch(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`).then(r => r.json() as Promise<BinanceKline[]>)
    ]);

    const currentPrice = Number(tickerRes.lastPrice);
    
    const bids = bookRes.bids.slice(0, 10).reduce((acc: number, val: string[]) => acc + (Number(val[0]) * Number(val[1])), 0);
    const asks = bookRes.asks.slice(0, 10).reduce((acc: number, val: string[]) => acc + (Number(val[0]) * Number(val[1])), 0);
    const totalVolume = bids + asks;
    const obImbalance = totalVolume === 0 ? 0 : (bids - asks) / totalVolume; 
    
    const spreadUsd = Number(bookRes.asks[0][0]) - Number(bookRes.bids[0][0]);

    const highs  = klinesRes.map((c: any) => Number(c[2]));
    const lows   = klinesRes.map((c: any) => Number(c[3]));
    const closes = klinesRes.map((c: any) => Number(c[4]));
    const volumes = klinesRes.map((c: any) => Number(c[5]));

    const currentRsi = RSI.calculate({ values: closes, period: 14 }).pop() ?? 50;
    const currentEma50 = EMA.calculate({ values: closes, period: 50 }).pop() ?? currentPrice;
    const currentAdx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop()?.adx ?? 25;
    const currentAtr5m = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop() ?? 3.50;

    const momentum5m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volumeRatio = avgVolume > 0 ? volumes[volumes.length - 1] / avgVolume : 1.0;

    let fundingRate = 0;
    try {
        const premium = await fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.json()) as any;
        fundingRate = Number(premium?.lastFundingRate ?? 0);
    } catch { /* fallback */ }

    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < klinesRes.length; i++) {
        cumPV += ((highs[i] + lows[i] + closes[i]) / 3) * volumes[i];
        cumVol += volumes[i];
    }
    const priceVsVwap = cumVol > 0 ? ((currentPrice - (cumPV / cumVol)) / (cumPV / cumVol)) * 100 : 0;

    const swingHigh = Math.max(...highs.slice(-20));
    const swingLow = Math.min(...lows.slice(-20));

    const liveIndicators: TechnicalIndicators = {
        emaTrend:             currentPrice > currentEma50 ? 'bullish' : 'bearish', 
        ema8:                 currentPrice, ema21: currentPrice, ema50: currentEma50,
        rsi:                  currentRsi,
        momentum5m, momentum30m: momentum5m * 6, momentum1h: momentum5m * 12,
        priceStructure:       currentPrice > currentEma50 ? 'uptrend' : 'downtrend', 
        trendBias4h:          currentPrice > currentEma50 ? 'bull' : 'bear',
        weeklyBias:           'neutral',
        atr5m:                currentAtr5m,
        atrPct:               currentAtr5m / currentPrice,
        volumeRatio,
        nearestResistance:    swingHigh, nearestSupport: swingLow,
        distanceToResistance: Math.abs(swingHigh - currentPrice),
        distanceToSupport:    Math.abs(currentPrice - swingLow),
        high24h:              Number(tickerRes.highPrice), low24h: Number(tickerRes.lowPrice),
        adx:                  currentAdx,
        fundingRate, spreadUsd, obImbalance, priceVsVwap,
        recentSwingHigh:      swingHigh, recentSwingLow: swingLow
    };

    return [{
        symbol: DISPLAY_SYMBOL, price: currentPrice, change_24h: Number(tickerRes.priceChangePercent),
        indicators: liveIndicators, orderBook: { bidWalls: [], askWalls: [] } 
    }];
}

async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const pos = await getOpenPositionDetails();
    const trade = getActiveTrade();

    if (!pos.exists) {
        if (trade) {
            const real = await getRealizedPnlSince(trade.openedAt - 2000);
            if (real) {
                const outcome = real.pnl >= 0 ? 'tp' : 'sl';
                if (outcome === 'sl') { stats.slHits++; stats.slLoss += Math.abs(real.pnl); } else { stats.tpHits++; }
                stats.fills++;
                bankProfit(real.pnl);
                if (trade.slAlgoId) await cancelAlgoOrder(trade.slAlgoId);
                clearActiveTrade();
                return outcome;
            }
            clearActiveTrade();
            return 'none';
        }
        return 'none';
    }

    if (!trade) return 'open';

    const adverseMove = pos.side === 'long' ? trade.entryPrice - pos.currentPrice : pos.currentPrice - trade.entryPrice;
    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);

    if (adverseMove >= slThreshold) {
        await triggerStopLoss(pos.side ?? 'long', pos.size, `Heartbeat fail-safe triggered exit.`);
        const real = await getRealizedPnlSince(trade.openedAt - 2000);
        const realizedLoss = real ? real.pnl : -(pos.size * adverseMove);
        stats.slHits++; stats.slLoss += Math.abs(realizedLoss); stats.fills++;
        bankProfit(realizedLoss);
        return 'sl';
    }
    return 'open';
}

async function runCycle(): Promise<void> {
    checkReset();
    if (stats.fills >= CONFIG.MAX_TRADES_DAY) return;

    try {
        const health = await checkPositionHealth();
        if (health === 'tp' || health === 'sl') { saveState(); return; }
        if (health === 'open') return;

        const realBalance = await getAvailableBalance();
        if (virtualTradingBalance <= 0 && realBalance > 0) {
            virtualTradingBalance = realBalance;
            initialBalance.value  = realBalance;
            initialBalance.set    = true;
        }

        const liveAssets = await buildLiveMarketData(MARKET_SYMBOL);
        const signals = await generateSignals(liveAssets);

        console.log(`[Heartbeat] Matrix: ${signals[0].reasoning} | Skipped today: ${stats.skipped}`);

        for (const signal of signals) {
            if (signal.direction === 'neutral') { stats.skipped++; continue; }
            stats.attempts++;

            const result = await executeBinanceTrade(signal, virtualTradingBalance);
            if (result.outcome === 'orders_placed') {
                console.log(`[Sniper Module] 🚀 Resting orders deployed safely at $${result.entryPrice?.toFixed(2)}`);
            } else {
                stats.attempts--; stats.skipped++;
            }
            break; 
        }
    } catch (e: any) {
        console.error(`[System Lifecyle Execution Error] Loop processing skipped: ${e.message}`);
    }
}

// ─── TIGHT RISK PROTECTION WATCHDOG ──────────────────────────────────────────
const WATCHDOG_MS = 3_000;
let watchdogBusy = false;

setInterval(async () => {
    if (!getActiveTrade() || watchdogBusy) return;
    watchdogBusy = true;
    try {
        const health = await checkPositionHealth();
        if (health === 'tp' || health === 'sl') { saveState(); }
    } catch (e: any) { /* silent protective handling */ } finally { watchdogBusy = false; }
}, WATCHDOG_MS);

// ─── RUNTIME SYSTEM DAEMON INTERFACE ──────────────────────────────────────────
function scheduleNext(): void {
    const session = getSession();
    const ms = Math.floor(Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin);
    setTimeout(async () => { await runCycle(); scheduleNext(); }, ms);
}

loadState();
console.log(`[AWS EC2 Node] Quantitative execution environment online via Binance API.`);
runCycle().then(scheduleNext);