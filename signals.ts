import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
export const MARKET_SYMBOL  = 'XAUUSDT';
export const DISPLAY_SYMBOL = 'XAU/USDT';

// ─── TYPES ────────────────────────────────────────────────────────────────────
export type SignalDirection = 'long' | 'short' | 'neutral';

export interface TechnicalIndicators {
    emaTrend:             'bullish' | 'bearish' | 'neutral';
    ema8:                 number;
    ema21:                number;
    ema50:                number;
    rsi:                  number;
    momentum5m:           number;
    momentum30m:          number;
    momentum1h:           number;
    priceStructure:       'uptrend' | 'downtrend' | 'ranging';
    trendBias4h:          'bull' | 'bear' | 'neutral';
    weeklyBias:           'bullish' | 'bearish' | 'neutral';
    atr5m:                number;
    atrPct:               number;
    volumeRatio:          number;
    nearestResistance:    number;
    nearestSupport:       number;
    distanceToResistance: number;
    distanceToSupport:    number;
    high24h:              number;
    low24h:               number;
    adx:                  number;
    fundingRate:          number | null;
    spreadUsd:            number;
    obImbalance:          number; 
    priceVsVwap:          number;
    recentSwingHigh:      number;
    recentSwingLow:       number;
}

export interface MarketData {
    symbol:     string;
    price:      number;
    change_24h: number;
    indicators: TechnicalIndicators;
    orderBook: {
        bidWalls: Array<{ price: number; notionalUsd: number }>;
        askWalls: Array<{ price: number; notionalUsd: number }>;
    };
}

export interface GeneratedSignal {
    symbol:             string;
    direction:          SignalDirection;
    market_price:       number;
    target_move:        number;
    confidence:         number;
    reasoning:          string;
    suggested_tp:       number;
    suggested_leverage: number;
    session_size_pct:   number;
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
export function getSession(): {
    name:       string;
    quality:    'PEAK' | 'HIGH' | 'LOW';
    cycleMsMin: number;
    cycleMsMax: number;
    sizePct:    number;
} {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 15_000, cycleMsMax: 25_000,  sizePct: 1.00 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 20_000, cycleMsMax: 35_000,  sizePct: 1.00 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 20_000, cycleMsMax: 35_000,  sizePct: 1.00 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 45_000, cycleMsMax: 60_000,  sizePct: 1.00 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 60_000, cycleMsMax: 90_000,  sizePct: 1.00 };
}

// ─── DYNAMIC ATR REGIME ───────────────────────────────────────────────────────
export interface AtrRegime {
    label:          'HIGH' | 'MED' | 'LOW';
    leverage:       number;
    tp:             number;
    sl:             number;
    baseSizePct:    number;
    minFeeMultiple: number;
}

export function calcAtrRegime(atr5m: number): AtrRegime {
    if (atr5m > 6.0) {
        return { label: 'HIGH', leverage: 5, tp: 1.50, sl: 3.00, baseSizePct: 1.00, minFeeMultiple: 2 };
    }
    return {
        label:          'MED',
        leverage:       5, // Forced to 5x Max Risk Profile
        tp:             0.50, // Locked to your $0.50 profit scalp target
        sl:             1.20, 
        baseSizePct:    1.00,
        minFeeMultiple: 1,
    };
}

// ─── RISK PROTECTION GUARDS ───────────────────────────────────────────────────
export function safeLeverage(leverage: number, entryPrice: number, atr5m: number): number {
    const minLiqDistance = atr5m * 2;
    let lev = leverage;
    while (lev > 1) {
        const liqDistance = entryPrice / lev;
        if (liqDistance >= minLiqDistance) break;
        lev = Math.max(1, lev - 1);
    }
    return lev;
}

function isExtremeVelocity(ind: TechnicalIndicators): boolean {
    const velocityThreshold = 4.5;
    return Math.abs(ind.momentum5m) > velocityThreshold && ind.volumeRatio > 3.0;
}

function isSpreadTooWide(ind: TechnicalIndicators): boolean {
    const maxSpread = 0.25; 
    const tooWide   = ind.spreadUsd >= maxSpread;
    if (tooWide) console.log(`[Gatekeeper] ⚠️ Spread wide ($${ind.spreadUsd.toFixed(3)}) — skipping cycle.`);
    return tooWide;
}

// ─── THE ENSEMBLE VOTING MATRIX (10 ALGORITHMS) ───────────────────────────────
function getEnsembleConsensus(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
    confidence: number;
} {
    if (ind.adx < 15) {
        return { direction: 'neutral', reasoning: 'VETO: ADX below 15. Market is in untradable chop.', confidence: 0 };
    }
    if (isExtremeVelocity(ind)) {
        return { direction: 'neutral', reasoning: 'VETO: Parabolic velocity detected. Avoiding steamroller.', confidence: 0 };
    }

    let longScore   = 0;
    let shortScore  = 0;
    let totalWeight = 0;

    const session = getSession();

    // 1. Mean Reversion Scalper (Weight: 2.0)
    const w1 = 2.0; totalWeight += w1;
    if (ind.rsi < 25 && ind.distanceToSupport <= 0.80) longScore += w1;
    else if (ind.rsi > 75 && ind.distanceToResistance <= 0.80) shortScore += w1;

    // 2. Order Book Imbalance (Weight: 3.0)
    const w2 = 3.0; totalWeight += w2;
    if (ind.obImbalance > 0.40) longScore += w2;
    else if (ind.obImbalance < -0.40) shortScore += w2;

    // 3. Trend-Aligned Pullback Sniper (Weight: 2.5)
    const w3 = 2.5; totalWeight += w3;
    if (ind.emaTrend === 'bullish' && ind.trendBias4h === 'bull' && ind.rsi < 42 && ind.rsi > 25) longScore += w3;
    else if (ind.emaTrend === 'bearish' && ind.trendBias4h === 'bear' && ind.rsi > 58 && ind.rsi < 75) shortScore += w3;

    // 4. VWAP Magnet (Weight: 1.5)
    const w4 = 1.5; totalWeight += w4;
    if (ind.priceVsVwap < -0.15 && ind.adx < 22) longScore += w4;
    else if (ind.priceVsVwap > 0.15 && ind.adx < 22) shortScore += w4;

    // 5. Velocity Breakout Filter (Weight: 2.0)
    const w5 = 2.0; totalWeight += w5;
    if (ind.adx > 35 && ind.volumeRatio > 2.0 && ind.momentum5m > 1.5 && price > ind.ema8) longScore += w5;
    else if (ind.adx > 35 && ind.volumeRatio > 2.0 && ind.momentum5m < -1.5 && price < ind.ema8) shortScore += w5;

    // 6. Micro-Spread Arbitrageur (Weight: 1.0)
    const w6 = 1.0; totalWeight += w6;
    if (ind.spreadUsd <= 0.10 && ind.momentum5m > 0.5) longScore += w6;
    else if (ind.spreadUsd <= 0.10 && ind.momentum5m < -0.5) shortScore += w6;

    // 7. Anti-Liquidity Sweep Engine (Weight: 2.5)
    const w7 = 2.5; totalWeight += w7;
    if (price < ind.low24h + 1.00 && ind.momentum5m > 0.5 && ind.rsi > 30) longScore += w7;
    else if (price > ind.high24h - 1.00 && ind.momentum5m < -0.5 && ind.rsi < 70) shortScore += w7;

    // 8. Session-Aware Guard (Weight: 1.5)
    const w8 = 1.5; totalWeight += w8;
    if (session.quality === 'LOW' && ind.rsi < 35 && ind.distanceToSupport < 1.0) longScore += w8;
    else if (session.quality === 'LOW' && ind.rsi > 65 && ind.distanceToResistance < 1.0) shortScore += w8;

    // 9. Multi-Timeframe Momentum Alignment (Weight: 2.0)
    const w9 = 2.0; totalWeight += w9;
    if (ind.momentum5m > 0 && ind.momentum30m > 0 && ind.momentum1h > 0 && ind.priceStructure === 'uptrend') longScore += w9;
    else if (ind.momentum5m < 0 && ind.momentum30m < 0 && ind.momentum1h < 0 && ind.priceStructure === 'downtrend') shortScore += w9;

    // 10. Funding Rate / Macro Arbitrage (Weight: 1.0)
    const w10 = 1.0; totalWeight += w10;
    if (ind.fundingRate !== null && ind.fundingRate < 0 && ind.priceStructure === 'uptrend') longScore += w10;
    else if (ind.fundingRate !== null && ind.fundingRate > 0 && ind.priceStructure === 'downtrend') shortScore += w10;

    // ─── CONSENSUS CALCULATION ───
    const longConviction  = longScore / totalWeight;
    const shortConviction = shortScore / totalWeight;
    const THRESHOLD       = 0.70;

    if (longConviction >= THRESHOLD) {
        return {
            direction: 'long',
            reasoning: `CONSENSUS LONG: ${(longConviction * 100).toFixed(0)}% agreement. Top weights aligned.`,
            confidence: longConviction
        };
    } else if (shortConviction >= THRESHOLD) {
        return {
            direction: 'short',
            reasoning: `CONSENSUS SHORT: ${(shortConviction * 100).toFixed(0)}% agreement. Top weights aligned.`,
            confidence: shortConviction
        };
    }

    return { 
        direction: 'neutral', 
        reasoning: `NO CONSENSUS: Long (${(longConviction * 100).toFixed(0)}%) | Short (${(shortConviction * 100).toFixed(0)}%)`, 
        confidence: Math.max(longConviction, shortConviction) 
    };
}

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        const { indicators: ind, price, symbol } = asset;

        if (isSpreadTooWide(ind)) continue;

        const engine = getEnsembleConsensus(ind, price);
        const regime = calcAtrRegime(ind.atr5m);
        const safetyLev = safeLeverage(regime.leverage, price, ind.atr5m);

        signals.push({
            symbol,
            direction:          engine.direction,
            market_price:       price,
            target_move:        regime.tp,
            confidence:         engine.confidence,
            reasoning:          engine.reasoning,
            suggested_tp:       regime.tp,
            suggested_leverage: safetyLev,
            session_size_pct:   1.00,
        });
    }

    return signals;
}