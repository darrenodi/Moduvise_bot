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
    bid:         number;
    ask:         number;
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
    atr5m:              number;
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
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 8_000,  cycleMsMax: 12_000, sizePct: 1.00 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 10_000, cycleMsMax: 15_000, sizePct: 1.00 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 10_000, cycleMsMax: 15_000, sizePct: 1.00 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 20_000, cycleMsMax: 30_000, sizePct: 1.00 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 20_000, cycleMsMax: 30_000, sizePct: 1.00 };
}

// ─── DIP / RIP REGIME DETECTION ───────────────────────────────────────────────
const DIP_ATR_MULT  = 2.5;
const RIP_ATR_MULT  = 2.0;
const DIP_CANDLES   = 3;
const DIP_PAUSE_MS  = 10 * 60 * 1000;

let _dipPauseUntil = 0;

export function detectRegime(closes: number[], atr5m: number): { regime: MarketRegime; reason: string } {
    if (closes.length < DIP_CANDLES + 1) return { regime: 'normal', reason: 'Insufficient history' };

    const window     = closes.slice(-(DIP_CANDLES + 1));
    const startPrice = window[0];
    const endPrice   = window[window.length - 1];
    const move       = endPrice - startPrice;
    const threshold  = atr5m;

    if (move < -(DIP_ATR_MULT * threshold)) {
        _dipPauseUntil = Date.now() + DIP_PAUSE_MS;
        return {
            regime: 'dip',
            reason: `HUGE DIP: -$${Math.abs(move).toFixed(2)} in ${DIP_CANDLES} candles (${(Math.abs(move)/threshold).toFixed(1)}× ATR). Pausing 10 min.`
        };
    }

    if (move > (RIP_ATR_MULT * threshold)) {
        _dipPauseUntil = Date.now() + (DIP_PAUSE_MS / 2);
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
// Five gates before any signal fires:
//
//  Gate 1 — ATR ceiling ($2.50): market moving too fast for micro-scalp, sit out.
//  Gate 2 — Spread block ($0.15): can't clear TP if spread eats it.
//  Gate 3 — Genuine neutral: both OB and momentum weak = no edge, don't trade.
//  Gate 4 — Momentum trap: strong momentum AGAINST direction = filling into freight train.
//  Gate 5 — Wall check: require a resting order book wall within $0.50 as bounce cushion.
//
// The old code NEVER returned neutral in normal regime — it always fired a signal.
// That was the root cause of every large loser. These gates fix that.
function getDirection(
    ind:       TechnicalIndicators,
    orderBook: MarketData['orderBook'],
    price:     number,
): { direction: SignalDirection; reasoning: string; confidence: number } {
    const ob = ind.obImbalance;
    const m5 = ind.momentum5m;

    // ── Gate 1: ATR ceiling ───────────────────────────────────────────────────
    const ATR_CEILING = 7.50;
    if (ind.atr5m > ATR_CEILING) {
        return {
            direction: 'neutral',
            reasoning: `TRAP MARKET: ATR=$${ind.atr5m.toFixed(2)} > $${ATR_CEILING} ceiling. Sitting out.`,
            confidence: 0,
        };
    }

    // ── Gate 2: Spread ────────────────────────────────────────────────────────
    if (ind.spreadUsd >= 0.15) {
        return {
            direction: 'neutral',
            reasoning: `SPREAD BLOCK: $${ind.spreadUsd.toFixed(3)} (max $0.15)`,
            confidence: 0,
        };
    }

    // ── Gate 3: Genuine neutral ───────────────────────────────────────────────
    const obWeak  = ob > -0.15 && ob < 0.15;
    const momWeak = m5 > -0.10 && m5 < 0.10;
    if (obWeak && momWeak) {
        return {
            direction: 'neutral',
            reasoning: `LOW CONVICTION: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)} — no edge, skipping.`,
            confidence: 0,
        };
    }

    // ── Direction determination ───────────────────────────────────────────────
    let preferredDir: SignalDirection = 'neutral';
    let preferredConf = 0;
    let preferredReason = '';

    if (ob > 0.35) {
        preferredDir    = 'long';
        preferredConf   = ob;
        preferredReason = `OB LONG: imbalance=${(ob*100).toFixed(0)}% buy pressure`;
    } else if (ob < -0.35) {
        preferredDir    = 'short';
        preferredConf   = Math.abs(ob);
        preferredReason = `OB SHORT: imbalance=${(Math.abs(ob)*100).toFixed(0)}% sell pressure`;
    } else if (ob > 0.15 && m5 > 0.05) {
        preferredDir    = 'long';
        preferredConf   = ob;
        preferredReason = `OB+MOM LONG: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)}`;
    } else if (ob < -0.15 && m5 < -0.05) {
        preferredDir    = 'short';
        preferredConf   = Math.abs(ob);
        preferredReason = `OB+MOM SHORT: ob=${(Math.abs(ob)*100).toFixed(0)}% mom=$${m5.toFixed(2)}`;
    } else if (m5 > 0.10) {
        preferredDir    = 'long';
        preferredConf   = 0.30;
        preferredReason = `MOM LONG: $${m5.toFixed(3)}/5m`;
    } else if (m5 < -0.10) {
        preferredDir    = 'short';
        preferredConf   = 0.30;
        preferredReason = `MOM SHORT: $${m5.toFixed(3)}/5m`;
    } else {
        return {
            direction: 'neutral',
            reasoning: `CONFLICTING SIGNALS: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)} — disagreement, skipping.`,
            confidence: 0,
        };
    }

    // ── Gate 4: Momentum trap guard ───────────────────────────────────────────
    // Limit buy fills when sellers push price down to us — fine if mild (oscillation),
    // dangerous if momentum is strongly against us (breakdown).
    const MOMENTUM_TRAP_USD = 0.50;
    if (preferredDir === 'long'  && m5 < -MOMENTUM_TRAP_USD) {
        return {
            direction: 'neutral',
            reasoning: `MOMENTUM TRAP (LONG): 5m mom=$${m5.toFixed(2)} — price breaking down, not retracing.`,
            confidence: 0,
        };
    }
    if (preferredDir === 'short' && m5 > MOMENTUM_TRAP_USD) {
        return {
            direction: 'neutral',
            reasoning: `MOMENTUM TRAP (SHORT): 5m mom=$${m5.toFixed(2)} — price spiking up, not retracing.`,
            confidence: 0,
        };
    }

    // ── Gate 5: Order book wall check ─────────────────────────────────────────
    // Require a resting wall within $0.50 of price on the protective side.
    // Fail-open if walls array is empty (bad data cycle shouldn't freeze the bot).
    const WALL_RANGE_USD    = 0.50;
    const WALL_MIN_NOTIONAL = 20_000;

    if (preferredDir === 'long' && orderBook.bidWalls.length > 0) {
        const nearWall = orderBook.bidWalls.find(
            w => w.price >= price - WALL_RANGE_USD && w.notionalUsd >= WALL_MIN_NOTIONAL
        );
        if (!nearWall) {
            return {
                direction: 'neutral',
                reasoning: `NO BID WALL: no wall >=$${WALL_MIN_NOTIONAL/1000}K within $${WALL_RANGE_USD} of price. Fill unprotected.`,
                confidence: 0,
            };
        }
        preferredReason += ` | bid wall @ $${nearWall.price.toFixed(2)} ($${(nearWall.notionalUsd/1000).toFixed(0)}K)`;
    }

    if (preferredDir === 'short' && orderBook.askWalls.length > 0) {
        const nearWall = orderBook.askWalls.find(
            w => w.price <= price + WALL_RANGE_USD && w.notionalUsd >= WALL_MIN_NOTIONAL
        );
        if (!nearWall) {
            return {
                direction: 'neutral',
                reasoning: `NO ASK WALL: no wall >=$${WALL_MIN_NOTIONAL/1000}K within $${WALL_RANGE_USD} of price. Fill unprotected.`,
                confidence: 0,
            };
        }
        preferredReason += ` | ask wall @ $${nearWall.price.toFixed(2)} ($${(nearWall.notionalUsd/1000).toFixed(0)}K)`;
    }

    return { direction: preferredDir, reasoning: preferredReason, confidence: preferredConf };
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
                suggested_leverage: Number(process.env.BOT_LEVERAGE ?? 100),
                session_size_pct:   1.00,
            });
            continue;
        }

        const sig      = getDirection(ind, asset.orderBook, price);
        const leverage = Number(process.env.BOT_LEVERAGE ?? 100);

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
