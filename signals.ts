import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
export const MARKET_SYMBOL  = 'XAUUSDT';
export const DISPLAY_SYMBOL = 'XAU/USDT';

// ─── TYPES ────────────────────────────────────────────────────────────────────
export type SignalDirection = 'long' | 'short' | 'neutral';
export type MarketRegime   = 'normal' | 'dip' | 'rip';

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
    symbol:      string;
    price:       number;
    bid:         number;   // live best bid — used for entry offset instead of last price
    ask:         number;   // live best ask
    change_24h:  number;
    indicators:  TechnicalIndicators;
    regime:      MarketRegime;
    regimeReason: string;
    orderBook: {
        bidWalls: Array<{ price: number; notionalUsd: number }>;
        askWalls: Array<{ price: number; notionalUsd: number }>;
    };
}

export interface GeneratedSignal {
    symbol:             string;
    direction:          SignalDirection;
    market_price:       number;
    bid:                number;
    ask:                number;
    atr5m:              number;   // live ATR — used for dynamic entry offset and SL distance
    target_move:        number;
    confidence:         number;
    reasoning:          string;
    suggested_tp:       number;
    suggested_leverage: number;
    session_size_pct:   number;
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
// Tighter cycles for high-frequency scalping
export function getSession(): {
    name:       string;
    quality:    'PEAK' | 'HIGH' | 'LOW';
    cycleMsMin: number;
    cycleMsMax: number;
    sizePct:    number;
} {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 8_000,  cycleMsMax: 12_000, sizePct: 1.00 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 10_000, cycleMsMax: 15_000, sizePct: 1.00 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 10_000, cycleMsMax: 15_000, sizePct: 1.00 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 20_000, cycleMsMax: 30_000, sizePct: 1.00 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 20_000, cycleMsMax: 30_000, sizePct: 1.00 };
}

// ─── DIP / RIP REGIME DETECTION ───────────────────────────────────────────────
// "The only time we are not going to trade is when gold is taking huge dips."
// We also pause on parabolic rips — entering long into a spike is equally
// dangerous on a $0.20 target with fast reversal risk.
//
// Detection: if price moved more than DIP_ATR_MULT × ATR over the last
// DIP_CANDLES 5-minute candles, we consider it a regime event and pause.
const DIP_ATR_MULT  = 2.5;             // 2.5× ATR drop in 3 candles = huge dip
const RIP_ATR_MULT  = 2.0;             // 2.0× ATR rip = pause entering longs
const DIP_CANDLES   = 3;               // look back 3 × 5m = 15 minutes
const DIP_PAUSE_MS  = 10 * 60 * 1000; // sit out 10 minutes after detection

let _dipPauseUntil = 0;

export function detectRegime(closes: number[], atr5m: number): { regime: MarketRegime; reason: string } {
    if (closes.length < DIP_CANDLES + 1) return { regime: 'normal', reason: 'Insufficient history' };

    const window = closes.slice(-(DIP_CANDLES + 1));
    const startPrice = window[0];
    const endPrice   = window[window.length - 1];
    const move       = endPrice - startPrice;
    const threshold  = atr5m; // ATR is already per candle

    if (move < -(DIP_ATR_MULT * threshold)) {
        _dipPauseUntil = Date.now() + DIP_PAUSE_MS;
        return {
            regime: 'dip',
            reason: `HUGE DIP: -$${Math.abs(move).toFixed(2)} in ${DIP_CANDLES} candles (${(Math.abs(move)/threshold).toFixed(1)}× ATR). Pausing 10 min.`
        };
    }

    if (move > (RIP_ATR_MULT * threshold)) {
        _dipPauseUntil = Date.now() + (DIP_PAUSE_MS / 2); // 5 min pause on rip
        return {
            regime: 'rip',
            reason: `PARABOLIC RIP: +$${move.toFixed(2)} in ${DIP_CANDLES} candles (${(move/threshold).toFixed(1)}× ATR). Pausing 5 min.`
        };
    }

    if (Date.now() < _dipPauseUntil) {
        const secsLeft = Math.ceil((_dipPauseUntil - Date.now()) / 1000);
        return { regime: 'dip', reason: `DIP COOLDOWN: ${secsLeft}s remaining` };
    }

    return { regime: 'normal', reason: 'Market regime: normal' };
}

// ─── DIRECTION SIGNAL ─────────────────────────────────────────────────────────
// High-frequency scalping direction is determined by two fast signals:
//   1. Order book imbalance (primary) — most predictive for sub-$1 moves
//   2. 5m momentum (confirmation)
//
// No multi-signal ensemble here: at a $0.20 target, we need to fire
// frequently. The dip filter is the gate, not a high-conviction threshold.
function getDirection(ind: TechnicalIndicators): { direction: SignalDirection; reasoning: string; confidence: number } {
    const ob  = ind.obImbalance;   // range -1 to +1
    const m5  = ind.momentum5m;    // raw price delta last 5m candle

    // Hard block: spread too wide to clear $0.20 profit
    if (ind.spreadUsd >= 0.15) {
        return { direction: 'neutral', reasoning: `SPREAD BLOCK: $${ind.spreadUsd.toFixed(3)} (max $0.15)`, confidence: 0 };
    }

    // Strong OB imbalance — trade with the pressure
    if (ob > 0.35) {
        return { direction: 'long',  reasoning: `OB LONG: imbalance=${(ob*100).toFixed(0)}% buy pressure`, confidence: ob };
    }
    if (ob < -0.35) {
        return { direction: 'short', reasoning: `OB SHORT: imbalance=${(Math.abs(ob)*100).toFixed(0)}% sell pressure`, confidence: Math.abs(ob) };
    }

    // Moderate OB confirmed by momentum
    if (ob > 0.15 && m5 > 0.05) {
        return { direction: 'long',  reasoning: `OB+MOM LONG: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)}`, confidence: ob };
    }
    if (ob < -0.15 && m5 < -0.05) {
        return { direction: 'short', reasoning: `OB+MOM SHORT: ob=${(Math.abs(ob)*100).toFixed(0)}% mom=$${m5.toFixed(2)}`, confidence: Math.abs(ob) };
    }

    // Pure momentum fallback when OB is flat
    if (m5 > 0.15) return { direction: 'long',  reasoning: `MOM LONG: $${m5.toFixed(3)}/5m`,  confidence: 0.40 };
    if (m5 < -0.15) return { direction: 'short', reasoning: `MOM SHORT: $${m5.toFixed(3)}/5m`, confidence: 0.40 };

    return { direction: 'neutral', reasoning: `NO EDGE: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(3)}`, confidence: 0 };
}

// ─── SIGNAL DISPATCHER ────────────────────────────────────────────────────────
export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        const { indicators: ind, price, bid, ask, symbol, regime, regimeReason } = asset;

        // Regime gate first — overrides everything
        if (regime !== 'normal') {
            signals.push({
                symbol,
                direction:          'neutral',
                market_price:       price,
                bid,
                ask,
                atr5m:              ind.atr5m,
                target_move:        0.20,
                confidence:         0,
                reasoning:          regimeReason,
                suggested_tp:       0.20,
                suggested_leverage: Number(process.env.BOT_LEVERAGE ?? 50),
                session_size_pct:   1.00,
            });
            continue;
        }

        const sig = getDirection(ind);
        const leverage = Number(process.env.BOT_LEVERAGE ?? 50);

        if (sig.direction !== 'neutral') {
            console.log(`[Signal] 🎯 ${sig.direction.toUpperCase()} | ${sig.reasoning} | ADX=${ind.adx.toFixed(1)} ATR=$${ind.atr5m.toFixed(2)}`);
        }

        signals.push({
            symbol,
            direction:          sig.direction,
            market_price:       price,
            bid,
            ask,
            atr5m:              ind.atr5m,
            target_move:        0.20,
            confidence:         sig.confidence,
            reasoning:          sig.reasoning,
            suggested_tp:       0.20,
            suggested_leverage: leverage,
            session_size_pct:   1.00,
        });
    }

    return signals;
}
