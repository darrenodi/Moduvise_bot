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

export interface GeneratedSignal {
    symbol: string;
    direction: SignalDirection;
    market_price: number;
    bid: number;
    ask: number;
    target_move: number;
    confidence: number;
    reasoning: string;
    suggested_tp: number;
    suggested_leverage: number;
    session_size_pct: number;
    spread_usd: number;
    atr_usd: number;   
}

// ─── REGIME & SESSION MOCKS ───────────────────────────────────────────────────
export function getSession() { return 'active'; }
export function detectRegime(ind: TechnicalIndicators): { regime: MarketRegime, regimeReason: string } {
    return { regime: 'normal', regimeReason: 'Normal conditions' };
}

// ─── HFMM LOGIC ───────────────────────────────────────────────────────────────
function getHFMMDirection(ind: TechnicalIndicators): { direction: SignalDirection; confidence: number; reasoning: string } {
    if (ind.spreadUsd >= 0.15) {
        return { direction: 'neutral', confidence: 0, reasoning: `SPREAD BLOCK: $${ind.spreadUsd.toFixed(3)}` };
    }

    if (ind.obImbalance > 0.15) {
        return { direction: 'long', confidence: 90, reasoning: `HFMM: Leaning Long | OB Imbalance ${Math.round(ind.obImbalance * 100)}%` };
    } else if (ind.obImbalance < -0.15) {
        return { direction: 'short', confidence: 90, reasoning: `HFMM: Leaning Short | OB Imbalance ${Math.round(Math.abs(ind.obImbalance) * 100)}%` };
    }

    return { direction: 'long', confidence: 80, reasoning: `HFMM: Pure Chop Ping-Pong | Spread $${ind.spreadUsd.toFixed(3)}` };
}

export function generateSignals(assets: { indicators: TechnicalIndicators, price: number, bid: number, ask: number, symbol: string, regime: MarketRegime, regimeReason: string }[]): GeneratedSignal[] {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        const { indicators: ind, price, bid, ask, symbol, regime, regimeReason } = asset;

        if (regime !== 'normal') {
            signals.push({
                symbol,
                direction:          'neutral',
                market_price:       price,
                bid,
                ask,
                target_move:        0.20,
                confidence:         0,
                reasoning:          regimeReason,
                suggested_tp:       0.20,
                suggested_leverage: Number(process.env.BOT_LEVERAGE ?? 50),
                session_size_pct:   1.00,
                spread_usd:         ind.spreadUsd,
                atr_usd:            ind.atr5m
            });
            continue;
        }

        const sig = getHFMMDirection(ind);
        const leverage = Number(process.env.BOT_LEVERAGE ?? 50);

        if (sig.direction !== 'neutral') {
            console.log(`[Signal] 🎯 ${sig.direction.toUpperCase()} | ${sig.reasoning} | Spread=$${ind.spreadUsd.toFixed(3)} ATR=$${ind.atr5m.toFixed(2)}`);
        }

        signals.push({
            symbol,
            direction:          sig.direction,
            market_price:       price,
            bid,
            ask,
            target_move:        0.20,
            confidence:         sig.confidence,
            reasoning:          sig.reasoning,
            suggested_tp:       0.20,
            suggested_leverage: leverage,
            session_size_pct:   1.0,
            spread_usd:         ind.spreadUsd,
            atr_usd:            ind.atr5m 
        });
    }
    return signals;
}