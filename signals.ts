// ─── signals.ts ───────────────────────────────────────────────────────────────
// Gemini removed entirely. Direction is determined by local bias scoring only.
// This eliminates the 1–4s API latency per cycle that was the largest per-trade
// overhead. The bias engine already made the final call in every fallback path —
// this just removes the round trip.

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XAUUSDT';
export const DISPLAY_SYMBOL = 'XAU/USDT';
export const TARGET_MOVE    = 0.50;

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

// ─── SESSION ──────────────────────────────────────────────────────────────────
// Cycle timers cut to allow ~400 trades per 24h day.
// London/NY Overlap: 20–30s cycles → up to 180 cycles/hour during peak 3h.
// London / New York: 25–40s cycles.
// Off-hours intentionally slower — noise reduces, fills take longer.

export function getSession(): {
    name:       string;
    quality:    'PEAK' | 'HIGH' | 'LOW';
    cycleMsMin: number;
    cycleMsMax: number;
    sizePct:    number;
} {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 20_000, cycleMsMax: 30_000,  sizePct: 0.95 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 25_000, cycleMsMax: 40_000,  sizePct: 0.80 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 25_000, cycleMsMax: 40_000,  sizePct: 0.80 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 45_000, cycleMsMax: 70_000,  sizePct: 0.50 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 60_000, cycleMsMax: 90_000,  sizePct: 0.30 };
}

// ─── ATR REGIME ───────────────────────────────────────────────────────────────

export interface AtrRegime {
    label:          'HIGH' | 'MED' | 'LOW';
    leverage:       number;
    tp:             number;
    sl:             number;
    baseSizePct:    number;
    minFeeMultiple: number;
}

export function calcAtrRegime(atr5m: number, _confidence: number): AtrRegime {
    const FIXED_TP = 0.50;
    const FIXED_SL = 2.00;
    if (atr5m > 8) {
        return { label: 'HIGH', leverage: 40, tp: FIXED_TP, sl: FIXED_SL, baseSizePct: 0.60, minFeeMultiple: 3 };
    } else if (atr5m >= 4) {
        return { label: 'MED',  leverage: 40, tp: FIXED_TP, sl: FIXED_SL, baseSizePct: 0.80, minFeeMultiple: 3 };
    } else {
        return { label: 'LOW',  leverage: 40, tp: FIXED_TP, sl: FIXED_SL, baseSizePct: 0.95, minFeeMultiple: 3 };
    }
}

// ─── LIQUIDATION BUFFER ───────────────────────────────────────────────────────

export function safeLeverage(leverage: number, entryPrice: number, atr5m: number): number {
    const minLiqDistance = atr5m * 2;
    let lev = leverage;
    while (lev > 1) {
        const liqDistance = entryPrice / lev;
        if (liqDistance >= minLiqDistance) break;
        lev = Math.max(1, lev - 5);
    }
    if (lev !== leverage) {
        console.log(`[Signal] ⚠️ Leverage reduced ${leverage}x→${lev}x — liq buffer ATR×2=$${(atr5m * 2).toFixed(2)}`);
    }
    return lev;
}

// ─── BIAS SCORING ─────────────────────────────────────────────────────────────
// Scores 9 independent market factors. Each contributes +1 bull or +1 bear.
// Net score determines direction. Ties broken by OB imbalance then 5m momentum.

function computeBias(ind: TechnicalIndicators, price: number): {
    direction:  'LONG' | 'SHORT' | 'NEUTRAL';
    score:      number;
    isChoppy:   boolean;
    blockLong:  boolean;
    blockShort: boolean;
    reasons:    string[];
} {
    let bull = 0, bear = 0;
    const reasons: string[] = [];

    if (ind.emaTrend === 'bullish')      { bull++; reasons.push('EMA8>21>50 bull'); }
    else if (ind.emaTrend === 'bearish') { bear++; reasons.push('EMA8<21<50 bear'); }
    else reasons.push('EMA neutral');

    if (ind.rsi < 42)       { bull++; reasons.push(`RSI ${ind.rsi.toFixed(0)} low`); }
    else if (ind.rsi > 58)  { bear++; reasons.push(`RSI ${ind.rsi.toFixed(0)} high`); }
    else reasons.push(`RSI ${ind.rsi.toFixed(0)} mid`);

    if (ind.momentum30m > 0.025)       { bull++; reasons.push(`30m +${ind.momentum30m.toFixed(3)}%`); }
    else if (ind.momentum30m < -0.025) { bear++; reasons.push(`30m ${ind.momentum30m.toFixed(3)}%`); }

    if (ind.momentum1h > 0.07)         { bull++; reasons.push(`1h +${ind.momentum1h.toFixed(3)}%`); }
    else if (ind.momentum1h < -0.07)   { bear++; reasons.push(`1h ${ind.momentum1h.toFixed(3)}%`); }

    if (ind.trendBias4h === 'bull')      { bull++; reasons.push('4h bull'); }
    else if (ind.trendBias4h === 'bear') { bear++; reasons.push('4h bear'); }

    if (ind.adx > 18) {
        if (bull > bear)      { bull++; reasons.push(`ADX ${ind.adx.toFixed(0)} bull`); }
        else if (bear > bull) { bear++; reasons.push(`ADX ${ind.adx.toFixed(0)} bear`); }
    }

    if (ind.obImbalance > 0.15)       { bull++; reasons.push(`OB +${(ind.obImbalance * 100).toFixed(0)}% buy`); }
    else if (ind.obImbalance < -0.15) { bear++; reasons.push(`OB ${(ind.obImbalance * 100).toFixed(0)}% sell`); }

    if (ind.distanceToSupport < 3.0)    { bull++; reasons.push(`Near sup $${ind.nearestSupport.toFixed(1)}`); }
    if (ind.distanceToResistance < 3.0) { bear++; reasons.push(`Near res $${ind.nearestResistance.toFixed(1)}`); }

    if (ind.fundingRate !== null) {
        if (ind.fundingRate < -0.0002) { bull++; reasons.push(`Funding ${(ind.fundingRate * 100).toFixed(4)}% short-bias`); }
        if (ind.fundingRate >  0.0002) { bear++; reasons.push(`Funding ${(ind.fundingRate * 100).toFixed(4)}% long-bias`); }
    }

    // Choppy: short-term momentum conflicts with medium-term trend
    const isChoppy =
        (ind.momentum30m > 0.025 && ind.momentum1h < -0.07) ||
        (ind.momentum30m < -0.025 && ind.momentum1h > 0.07);

    const blockLong  = ind.rsi >= 82;
    const blockShort = ind.rsi <= 18;
    const score      = Math.max(bull, bear);
    const direction  = bull > bear ? 'LONG' : bear > bull ? 'SHORT' : 'NEUTRAL';

    return { direction, score, isChoppy, blockLong, blockShort, reasons };
}

// ─── GUARDS ───────────────────────────────────────────────────────────────────

function isExtremeVolatility(ind: TechnicalIndicators): boolean {
    return ind.atr5m > 10.0 && ind.volumeRatio > 3.5;
}

function isSpreadTooWide(ind: TechnicalIndicators): boolean {
    // Spread must be < 60% of ATR to be tradeable.
    // On live Gold this is typically $0.01–$0.10, well within threshold.
    const maxSpread = ind.atr5m * 0.60;
    const tooWide   = ind.spreadUsd >= maxSpread;
    if (tooWide) console.log(`[Signal] ⚠️ Spread $${ind.spreadUsd.toFixed(2)} ≥ ATR×0.6 ($${maxSpread.toFixed(2)}) — skip.`);
    return tooWide;
}

// ─── DIRECTION ENGINE ─────────────────────────────────────────────────────────
// Pure local decision. No external API calls. Deterministic.
// Priority chain: bias score → OB imbalance → 5m momentum → price vs mid range.

function resolveDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    confidence: number;
    reasoning: string;
} {
    const bias = computeBias(ind, price);

    // Hard blocks
    if (bias.blockLong && bias.blockShort) {
        // Extremely rare (RSI simultaneously ≥82 and ≤18) — treat as neutral
        return { direction: 'neutral', confidence: 0, reasoning: 'RSI extreme both sides' };
    }

    let dir: SignalDirection;
    let confidence: number;

    if (bias.direction === 'LONG' && !bias.blockLong) {
        dir = 'long';
        confidence = 0.55 + Math.min(bias.score / 9, 1) * 0.35; // 0.55–0.90
    } else if (bias.direction === 'SHORT' && !bias.blockShort) {
        dir = 'short';
        confidence = 0.55 + Math.min(bias.score / 9, 1) * 0.35;
    } else if (bias.direction === 'NEUTRAL') {
        // Tiebreak: OB imbalance → 5m momentum → price vs mid
        if (Math.abs(ind.obImbalance) > 0.10) {
            dir = ind.obImbalance > 0 ? 'long' : 'short';
        } else if (Math.abs(ind.momentum5m) > 0.005) {
            dir = ind.momentum5m >= 0 ? 'long' : 'short';
        } else {
            const mid = (ind.high24h + ind.low24h) / 2;
            dir = price < mid ? 'long' : 'short';
        }
        // Respect RSI blocks even on tiebreak
        if (dir === 'long'  && bias.blockLong)  dir = 'short';
        if (dir === 'short' && bias.blockShort) dir = 'long';
        confidence = 0.52; // minimum confidence for tiebreak signals
    } else {
        // bias direction blocked by RSI — flip to opposite if not also blocked
        dir = bias.direction === 'LONG' ? 'short' : 'long';
        if (dir === 'long'  && bias.blockLong)  return { direction: 'neutral', confidence: 0, reasoning: 'Both directions RSI-blocked' };
        if (dir === 'short' && bias.blockShort) return { direction: 'neutral', confidence: 0, reasoning: 'Both directions RSI-blocked' };
        confidence = 0.52;
    }

    const reasoning = `${dir.toUpperCase()} score=${bias.score}/9 choppy=${bias.isChoppy} | ${bias.reasons.slice(0, 5).join(', ')}`;
    return { direction: dir, confidence, reasoning };
}

// ─── MAIN SIGNAL ENGINE ───────────────────────────────────────────────────────

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];
    const session = getSession();

    console.log(`[Signal] Session: ${session.name} [${session.quality}] sizePct=${session.sizePct}`);

    for (const asset of assets) {
        const { indicators: ind, price, symbol } = asset;

        if (isExtremeVolatility(ind)) {
            console.log(`[Signal] 🔴 EXTREME VOLATILITY ATR=$${ind.atr5m.toFixed(2)} vol=${ind.volumeRatio.toFixed(1)}x — pausing.`);
            continue;
        }

        if (isSpreadTooWide(ind)) {
            continue;
        }

        const regime   = calcAtrRegime(ind.atr5m, 0.65);
        const safetyLev = safeLeverage(regime.leverage, price, ind.atr5m);

        console.log(`[Signal] ATR=$${ind.atr5m.toFixed(2)} Regime:${regime.label} lev=${safetyLev}x TP=$${regime.tp.toFixed(2)} SL=$${regime.sl.toFixed(2)}`);

        const { direction, confidence, reasoning } = resolveDirection(ind, price);

        if (direction === 'neutral') {
            console.log(`[Signal] ⏸️ Neutral — skipping cycle.`);
            continue;
        }

        console.log(`[Signal] ✅ ${direction.toUpperCase()} conf=${confidence.toFixed(2)} | ${reasoning}`);

        signals.push({
            symbol,
            direction,
            market_price:       price,
            target_move:        regime.tp,
            confidence,
            reasoning:          reasoning.slice(0, 200),
            suggested_tp:       regime.tp,
            suggested_leverage: safetyLev,
            session_size_pct:   session.sizePct * regime.baseSizePct,
        });
    }

    return signals;
}
