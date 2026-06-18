import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import { RSI, EMA, ADX } from 'technicalindicators';
import { generateSignals, getSession, MARKET_SYMBOL, DISPLAY_SYMBOL } from './signals.js';
import type { MarketData, TechnicalIndicators } from './signals.js';
import {
    executeBinanceTrade,
    getAvailableBalance,
    getOpenPositionDetails,
    getActiveTrade,
    clearActiveTrade,
    triggerStopLoss,
    cancelAlgoOrder
} from './executeTrade.js';

dotenv.config();

// ─── ENVIRONMENT & CONFIGURATION ──────────────────────────────────────────────
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'demo';
const IS_TESTNET  = ENVIRONMENT !== 'live';
const BASE_URL    = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';

const CONFIG = {
    MAX_TRADES_DAY:      400,
    MAX_TRADING_BALANCE: 25_000, // Hard wall cap for micro-liquidity
    BANK_THRESHOLD:      5.00,   // Vault trigger: $5.00 net accumulated profit   
    BANK_FRACTION:       0.30,   // 30% to Spot Reserve, 70% to Compound Baseline
} as const;

// ─── TELEMETRY & STATE MANAGEMENT ─────────────────────────────────────────────
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

// ─── VAULT & FEE TRACKING ENGINE ──────────────────────────────────────────────
function checkReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (stats.date && stats.date !== today) { 
        printDailySummary(); 
        stats = freshStats(); 
        stats.date = today; 
    }
}

function printDailySummary(): void {
    const total   = virtualTradingBalance + totalBanked;
    const uptime  = ((Date.now() - startTime) / 3600_000).toFixed(1);
    const tpRate  = stats.fills > 0 ? ((stats.tpHits / stats.fills) * 100).toFixed(0) : '0';

    console.log(`\n${'█'.repeat(70)}`);
    console.log(`📊 INSTITUTIONAL METRICS OVERVIEW — ${stats.date} (${uptime}h uptime)`);
    console.log(`Trades Executed: ${stats.fills} | Win Rate: ${tpRate}% | Total Skipped: ${stats.skipped}`);
    console.log(`Gross Profit: +$${stats.grossProfit.toFixed(4)} | True Net Profit: +$${stats.netProfit.toFixed(4)}`);
    console.log(`Stop Losses:  -$${stats.slLoss.toFixed(4)} | Taker Fee Drag: -$${stats.totalTakerFees.toFixed(4)}`);
    console.log(`💼 Active Compounding Margin: $${virtualTradingBalance.toFixed(2)}`);
    console.log(`🏦 Spot Vault (Secured Capital): $${totalBanked.toFixed(2)}`);
    if (initialBalance.set) {
        console.log(`📈 Net System Return: +${(((total - initialBalance.value) / initialBalance.value) * 100).toFixed(2)}%`);
    }
    console.log(`${'█'.repeat(70)}\n`);
}

function bankProfit(netProfit: number, takerFeeCost = 0): void {
    stats.totalTakerFees += takerFeeCost;

    // Handle Losing Trade (Deduct from active margin)
    if (netProfit <= 0) {
        virtualTradingBalance = Math.max(1.50, virtualTradingBalance + netProfit);
        console.log(`[Risk Node] Drawdown Deducted: -$${Math.abs(netProfit).toFixed(4)} | Active Margin: $${virtualTradingBalance.toFixed(2)}`);
        return;
    }

    // Handle Cap Limit
    if (virtualTradingBalance >= CONFIG.MAX_TRADING_BALANCE) {
        accumulatedNetProfit += netProfit;
        totalBanked          += netProfit;
        stats.netProfit      += netProfit;
        return;
    }

    // Handle Winning Trade
    accumulatedNetProfit += netProfit;
    stats.netProfit      += netProfit;
    stats.grossProfit    += netProfit;

    // Vault Trigger Matrix
    if (accumulatedNetProfit >= CONFIG.BANK_THRESHOLD) {
        const toVault     = accumulatedNetProfit * CONFIG.BANK_FRACTION;
        const toCompound  = accumulatedNetProfit * (1 - CONFIG.BANK_FRACTION);

        totalBanked            += toVault;
        virtualTradingBalance   = Math.min(virtualTradingBalance + toCompound, CONFIG.MAX_TRADING_BALANCE);
        accumulatedNetProfit    = 0;  

        console.log(`[Vault Allocation] 🏦 Secured $${toVault.toFixed(4)} | 🔄 Compounded $${toCompound.toFixed(4)}`);
    } else {
        virtualTradingBalance = Math.min(virtualTradingBalance + netProfit, CONFIG.MAX_TRADING_BALANCE);
    }
}

// ─── LIVE DATA INGESTION MATRIX ───────────────────────────────────────────────
async function buildLiveMarketData(symbol: string): Promise<MarketData[]> {
    interface BinanceTickerResponse {
        lastPrice: string;
        highPrice: string;
        lowPrice: string;
        priceChangePercent: string;
    }

    interface BinanceDepthResponse {
        bids: string[][];
        asks: string[][];
    }

    type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

    // 1. Fetch live Ticker, Order Book, and the last 100 5m Candles
    const [tickerRes, bookRes, klinesRes] = await Promise.all([
        fetch(`${BASE_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`)
            .then(r => r.json() as Promise<BinanceTickerResponse>),
        fetch(`${BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=20`)
            .then(r => r.json() as Promise<BinanceDepthResponse>),
        fetch(`${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`)
            .then(r => r.json() as Promise<BinanceKline[]>)
    ]);

    const currentPrice = Number(tickerRes.lastPrice);
    
    // 2. Order Book Math
    const bids = bookRes.bids.slice(0, 10).reduce((acc: number, val: string[]) => acc + (Number(val[0]) * Number(val[1])), 0);
    const asks = bookRes.asks.slice(0, 10).reduce((acc: number, val: string[]) => acc + (Number(val[0]) * Number(val[1])), 0);
    const totalVolume = bids + asks;
    const obImbalance = totalVolume === 0 ? 0 : (bids - asks) / totalVolume; 
    
    const topBid = Number(bookRes.bids[0][0]);
    const topAsk = Number(bookRes.asks[0][0]);
    const spreadUsd = topAsk - topBid;

    // 3. Mathematical Indicator Generation
    // Klines array format: [OpenTime, Open, High, Low, Close, Volume, ...]
    const highs  = klinesRes.map((c: any) => Number(c[2]));
    const lows   = klinesRes.map((c: any) => Number(c[3]));
    const closes = klinesRes.map((c: any) => Number(c[4]));

    // Calculate RSI (14 period)
    const rsiArray = RSI.calculate({ values: closes, period: 14 });
    const currentRsi = rsiArray.length > 0 ? rsiArray[rsiArray.length - 1] : 50;

    // Calculate EMA (50 period) for Trend detection
    const ema50Array = EMA.calculate({ values: closes, period: 50 });
    const currentEma50 = ema50Array.length > 0 ? ema50Array[ema50Array.length - 1] : currentPrice;
    const emaTrend = currentPrice > currentEma50 ? 'bullish' : 'bearish';

    // Calculate ADX (14 period) for Chop detection
    const adxArray = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const currentAdx = adxArray.length > 0 ? adxArray[adxArray.length - 1].adx : 25;

    // Calculate basic momentum (Price change over last candle)
    const momentum5m = closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;

    // 4. Map the live math into the Matrix Payload
    const liveIndicators: TechnicalIndicators = {
        emaTrend:             emaTrend, 
        ema8:                 currentPrice, 
        ema21:                currentPrice,
        ema50:                currentEma50,
        rsi:                  currentRsi,
        momentum5m:           momentum5m,         
        momentum30m:          momentum5m * 6, // Rough approximation
        momentum1h:           momentum5m * 12,
        priceStructure:       emaTrend === 'bullish' ? 'uptrend' : 'downtrend', 
        trendBias4h:          emaTrend === 'bullish' ? 'bull' : 'bear',
        weeklyBias:           'neutral',
        atr5m:                3.50, // Keep fixed or calculate dynamic ATR if desired
        atrPct:               0.05,
        volumeRatio:          1.0,  // Keep neutral or build volume calculation
        nearestResistance:    currentPrice + 5,
        nearestSupport:       currentPrice - 5,
        distanceToResistance: 5,
        distanceToSupport:    5,
        high24h:              Number(tickerRes.highPrice),
        low24h:               Number(tickerRes.lowPrice),
        adx:                  currentAdx,
        fundingRate:          0,         
        spreadUsd:            spreadUsd,
        obImbalance:          obImbalance, 
        priceVsVwap:          0,
        recentSwingHigh:      currentPrice + 5,
        recentSwingLow:       currentPrice - 5
    };

    return [{
        symbol: DISPLAY_SYMBOL,
        price: currentPrice,
        change_24h: Number(tickerRes.priceChangePercent),
        indicators: liveIndicators,
        orderBook: { bidWalls: [], askWalls: [] } 
    }];
}

// ─── EXECUTION LIFECYCLE ──────────────────────────────────────────────────────
async function checkPositionHealth(): Promise<'tp' | 'sl' | 'open' | 'none'> {
    const pos = await getOpenPositionDetails();
    const trade = getActiveTrade();

    if (!pos.exists) {
        if (trade) {
            // Position closed, but we have an active trade tracked. Determine if TP or SL was hit.
            const distToTP = Math.abs(trade.tpPrice - pos.currentPrice);
            const distToSL = Math.abs(trade.slPrice - pos.currentPrice);

            if (distToSL < distToTP) {
                // Stopped Out (Taker Fee Applies)
                const slLoss = trade.size * Math.abs(trade.slPrice - trade.entryPrice);
                const takerFee = trade.size * trade.slPrice * 0.00045; 
                
                stats.slHits++;
                stats.slLoss += slLoss;
                stats.netProfit -= (slLoss + takerFee);
                bankProfit(-(slLoss + takerFee), takerFee);
                clearActiveTrade();
                return 'sl';
            }
            // TP Hit (0% Maker Fee)
            return 'tp';
        }
        return 'none';
    }

    if (!trade) return 'open'; // Manual trade detected outside of bot

    // Hard fail-safe: Manual execution escape if exchange SL fails
    const adverseMove = pos.side === 'long' ? trade.entryPrice - pos.currentPrice : pos.currentPrice - trade.entryPrice;
    const slThreshold = Math.abs(trade.slPrice - trade.entryPrice);

    if (adverseMove >= slThreshold) {
        await triggerStopLoss(pos.side ?? 'long', pos.size, `Latency Fail-safe: Exceeded $${adverseMove.toFixed(2)} drawdown`);
        const slLoss = pos.size * adverseMove;
        const takerFee = pos.size * pos.currentPrice * 0.00045;
        
        stats.slHits++;
        stats.slLoss += slLoss;
        stats.netProfit -= (slLoss + takerFee);
        bankProfit(-(slLoss + takerFee), takerFee);
        return 'sl';
    }

    return 'open';
}

async function runCycle(): Promise<void> {
    checkReset();
    if (stats.fills >= CONFIG.MAX_TRADES_DAY) return;

    try {
        const health = await checkPositionHealth();

        // 1. Process Winning Trade Cleanup
        if (health === 'tp') {
            const trade = getActiveTrade()!;
            stats.fills++;
            stats.tpHits++;
            
            // 0% Maker fee, 100% yield retention
            const gross = trade.size * Math.abs(trade.tpPrice - trade.entryPrice);
            bankProfit(gross, 0); 
            
            if (trade.slAlgoId) await cancelAlgoOrder(trade.slAlgoId);
            clearActiveTrade();
            console.log(`[Execution] 🟢 TAKE PROFIT HIT: +$${gross.toFixed(4)} net.`);
            return;
        }

        // 2. Hard Block: Do not scan for trades while in a position
        if (health === 'sl' || health === 'open') return;

        // 3. System Startup & Sync
        const realBalance = await getAvailableBalance();
        if (virtualTradingBalance <= 0 && realBalance > 0) {
            virtualTradingBalance = realBalance;
            initialBalance.value  = realBalance;
            initialBalance.set    = true;
            console.log(`[System Initialization] Capital Base Locked: $${virtualTradingBalance.toFixed(2)}`);
        }

        // 4. Ingest Live Data & Run Ensemble Matrix
        const liveAssets = await buildLiveMarketData(MARKET_SYMBOL);
        const signals = await generateSignals(liveAssets);

        // 5. Print the Heartbeat Status
        console.log(`[Heartbeat] Matrix: ${signals[0].reasoning} | Skipped: ${stats.skipped}`);

        for (const signal of signals) {
            if (signal.direction === 'neutral') { 
                stats.skipped++; 
                continue; 
            }
            stats.attempts++;

            // 6. Deploy Single-Bullet Maker Execution
            const result = await executeBinanceTrade(signal, virtualTradingBalance);

            if (result.outcome === 'orders_placed') {
                console.log(`[Sniper Module] 🚀 ${signal.direction.toUpperCase()} GTX limit filled at $${result.entryPrice?.toFixed(2)}.`);
            } else {
                stats.attempts--;
                stats.skipped++;
            }
            break; 
        }
    } catch (e: any) {
        console.error(`[Lifecycle Control] System fault detected: ${e.message}`);
    }
}

// ─── DAEMON LOOP ──────────────────────────────────────────────────────────────
function scheduleNext(): void {
    const session = getSession();
    // Dynamic polling based on geographic session latency
    const ms = Math.floor(Math.random() * (session.cycleMsMax - session.cycleMsMin) + session.cycleMsMin);
    setTimeout(async () => {
        await runCycle();
        scheduleNext();
    }, ms);
}

console.log(`[AWS EC2 Node] Quantitative execution environment online.`);
runCycle().then(scheduleNext);