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
    // Raw klines passed through so gates can inspect candle structure
    klines: any[];
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
const DIP_ATR_MULT = 2.5;
const RIP_ATR_MULT = 2.0;
const DIP_CANDLES  = 3;
const DIP_PAUSE_MS = 10 * 60 * 1000;

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
        return { regime: 'dip', reason: `HUGE DIP: -$${Math.abs(move).toFixed(2)} in ${DIP_CANDLES} candles (${(Math.abs(move)/threshold).toFixed(1)}× ATR). Pausing 10 min.` };
    }
    if (move > (RIP_ATR_MULT * threshold)) {
        _dipPauseUntil = Date.now() + (DIP_PAUSE_MS / 2);
        return { regime: 'rip', reason: `PARABOLIC RIP: +$${move.toFixed(2)} in ${DIP_CANDLES} candles (${(move/threshold).toFixed(1)}× ATR). Pausing 5 min.` };
    }
    if (Date.now() < _dipPauseUntil) {
        const secsLeft = Math.ceil((_dipPauseUntil - Date.now()) / 1000);
        return { regime: 'dip', reason: `DIP COOLDOWN: ${secsLeft}s remaining` };
    }
    return { regime: 'normal', reason: 'Market regime: normal' };
}

// ─── 5-MINUTE OSCILLATION GATE ────────────────────────────────────────────────
// Confirms the market is chopping sideways — not trending — before allowing entry.
//
// The original suggestion checked only the CURRENT candle. That's wrong — a single
// doji appears in both ranging and trending markets. We check the last N candles
// together and require ALL of them to pass as low-conviction / non-directional.
//
// Three conditions must all hold across the last OSCILLATION_LOOKBACK candles:
//
//  1. Body/range ratio < BODY_RATIO_MAX (0.40):
//     Each candle's net directional move is less than 40% of its total range.
//     A pure marubozu (one-way candle) has ratio=1.0. A doji has ratio~0.0.
//     We want small bodies — price is reversing inside each candle, not pushing.
//
//  2. Net directional move < NET_MOVE_MAX ($1.50):
//     Even if body/range is small, a candle with high=$3990 low=$3985 and
//     open=$3989 close=$3988.50 has a $0.50 body but a $5 range — the market
//     IS moving fast. Cap the absolute net move to reject high-ATR candles.
//
//  3. Candles overlap in price (range overlap check):
//     If candles are stairstepping — each candle's low is above the prior
//     candle's high — that's a trend, not oscillation. Require that at least
//     OVERLAP_REQUIRED fraction of consecutive candle pairs overlap in range.
//
// All three must pass for isSafeOscillation() to return true.
//
// Fail-open: if klines is empty or too short, returns true so a bad data
// cycle doesn't freeze the bot.

const OSCILLATION_LOOKBACK = 4;     // check last 4 completed candles (20 minutes)
const BODY_RATIO_MAX       = 0.60;  // raised from 0.40 — gold ATR $4-6 means larger bodies are normal
const NET_MOVE_MAX         = 4.00;  // raised from $1.50 — matches current ATR regime
const OVERLAP_MIN_FRACTION = 0.67;  // at least 2/3 of consecutive pairs must overlap

export function isSafeOscillation(klines: any[]): { safe: boolean; reason: string } {
    // Need at least LOOKBACK + 1 candles (exclude the live forming candle)
    if (klines.length < OSCILLATION_LOOKBACK + 1) {
        return { safe: true, reason: 'Insufficient kline history — fail-open' };
    }

    // Use completed candles only — exclude the last (still forming)
    const completed = klines.slice(-(OSCILLATION_LOOKBACK + 1), -1);

    let overlapCount = 0;
    const failedCandles: string[] = [];

    for (let i = 0; i < completed.length; i++) {
        const c    = completed[i];
        const open = Number(c[1]);
        const high = Number(c[2]);
        const low  = Number(c[3]);
        const close = Number(c[4]);

        const totalRange = high - low;
        const netMove    = Math.abs(close - open);
        const bodyRatio  = totalRange > 0 ? netMove / totalRange : 0;

        // Condition 1: body must be small relative to range
        if (bodyRatio > BODY_RATIO_MAX) {
            failedCandles.push(`C${i}: body=${(bodyRatio*100).toFixed(0)}%>${(BODY_RATIO_MAX*100).toFixed(0)}%`);
        }

        // Condition 2: net move must be small in absolute terms
        if (netMove > NET_MOVE_MAX) {
            failedCandles.push(`C${i}: netMove=$${netMove.toFixed(2)}>$${NET_MOVE_MAX}`);
        }

        // Condition 3: range overlap with previous candle
        if (i > 0) {
            const prev     = completed[i - 1];
            const prevHigh = Number(prev[2]);
            const prevLow  = Number(prev[3]);
            const overlaps = low <= prevHigh && high >= prevLow;
            if (overlaps) overlapCount++;
        }
    }

    // Check overlap fraction across consecutive pairs
    const pairs           = completed.length - 1;
    const overlapFraction = pairs > 0 ? overlapCount / pairs : 1;
    const overlapOk       = overlapFraction >= OVERLAP_MIN_FRACTION;

    if (!overlapOk) {
        return {
            safe:   false,
            reason: `TRENDING: only ${(overlapFraction*100).toFixed(0)}% candle overlap (need ${(OVERLAP_MIN_FRACTION*100).toFixed(0)}%) — stairstepping, not oscillating`,
        };
    }

    if (failedCandles.length > 1) {
        // Allow 1 bad candle (noise) — block if 2+ candles show directional bias
        return {
            safe:   false,
            reason: `DIRECTIONAL CANDLES: ${failedCandles.join(', ')} — not safe oscillation`,
        };
    }

    return { safe: true, reason: `Oscillation confirmed: ${(overlapFraction*100).toFixed(0)}% overlap, ${completed.length - failedCandles.length}/${completed.length} candles clean` };
}

// ─── DIRECTION SIGNAL ─────────────────────────────────────────────────────────
// Six gates before any signal fires. Gates run in order — first failure stops.
//
//  Gate 1 — ATR ceiling ($6.00): market moving too fast for micro-scalp.
//            Raised from $2.50 to $6.00 to match current gold volatility regime.
//            The oscillation gate (Gate 6) handles the fine-grained chop check.
//  Gate 2 — Spread block ($0.15): spread eats the TP.
//  Gate 3 — Genuine neutral: both OB and momentum weak = no edge.
//  Gate 4 — Momentum trap: strong momentum AGAINST direction = freight train fill.
//  Gate 5 — Wall check: require resting OB wall within $0.50 as bounce cushion.
//  Gate 6 — Oscillation gate: multi-candle chop confirmation. Blocks trending markets.
//            Velocity check (5s aggTrade window) is passed in from main.ts and
//            checked here as Gate 6b — if a flush is detected, block entry.
function getDirection(
    ind:          TechnicalIndicators,
    orderBook:    MarketData['orderBook'],
    price:        number,
    klines:       any[],
    velocityState: import('./velocityMonitor.js').VelocityState | null,
): { direction: SignalDirection; reasoning: string; confidence: number } {
    const ob = ind.obImbalance;
    const m5 = ind.momentum5m;

    // ── Gate 1: ATR ceiling ───────────────────────────────────────────────────
    const ATR_CEILING = 6.00;
    if (ind.atr5m > ATR_CEILING) {
        return {
            direction:  'neutral',
            reasoning:  `TRAP MARKET: ATR=$${ind.atr5m.toFixed(2)} > $${ATR_CEILING} ceiling. Sitting out.`,
            confidence: 0,
        };
    }

    // ── Gate 2: Spread ────────────────────────────────────────────────────────
    // Demo spreads are artificially wide ($0.30-$0.50) vs live ($0.03-$0.08).
    // Use a relaxed limit on demo so the gate doesn't block everything.
    const SPREAD_MAX = process.env.ENVIRONMENT !== 'live' ? 0.50 : 0.15;
    if (ind.spreadUsd >= SPREAD_MAX) {
        return {
            direction:  'neutral',
            reasoning:  `SPREAD BLOCK: $${ind.spreadUsd.toFixed(3)} (max $${SPREAD_MAX})`,
            confidence: 0,
        };
    }

    // ── Gate 3: Genuine neutral ───────────────────────────────────────────────
    const obWeak  = ob > -0.15 && ob < 0.15;
    const momWeak = m5 > -0.10 && m5 < 0.10;
    if (obWeak && momWeak) {
        return {
            direction:  'neutral',
            reasoning:  `LOW CONVICTION: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)} — no edge.`,
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
            direction:  'neutral',
            reasoning:  `CONFLICTING SIGNALS: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)} — disagreement.`,
            confidence: 0,
        };
    }

    // ── Gate 4: Momentum trap ─────────────────────────────────────────────────
    const MOMENTUM_TRAP_USD = 0.50;
    if (preferredDir === 'long'  && m5 < -MOMENTUM_TRAP_USD) {
        return { direction: 'neutral', reasoning: `MOMENTUM TRAP (LONG): mom=$${m5.toFixed(2)} breaking down.`, confidence: 0 };
    }
    if (preferredDir === 'short' && m5 > MOMENTUM_TRAP_USD) {
        return { direction: 'neutral', reasoning: `MOMENTUM TRAP (SHORT): mom=$${m5.toFixed(2)} spiking up.`, confidence: 0 };
    }

    // ── Gate 5: Order book wall check ─────────────────────────────────────────
    const WALL_RANGE_USD    = 0.50;
    const WALL_MIN_NOTIONAL = 20_000;

    if (preferredDir === 'long' && orderBook.bidWalls.length > 0) {
        const nearWall = orderBook.bidWalls.find(
            w => w.price >= price - WALL_RANGE_USD && w.notionalUsd >= WALL_MIN_NOTIONAL
        );
        if (!nearWall) {
            return { direction: 'neutral', reasoning: `NO BID WALL: no wall >=$${WALL_MIN_NOTIONAL/1000}K within $${WALL_RANGE_USD}.`, confidence: 0 };
        }
        preferredReason += ` | bid wall@$${nearWall.price.toFixed(2)} ($${(nearWall.notionalUsd/1000).toFixed(0)}K)`;
    }
    if (preferredDir === 'short' && orderBook.askWalls.length > 0) {
        const nearWall = orderBook.askWalls.find(
            w => w.price <= price + WALL_RANGE_USD && w.notionalUsd >= WALL_MIN_NOTIONAL
        );
        if (!nearWall) {
            return { direction: 'neutral', reasoning: `NO ASK WALL: no wall >=$${WALL_MIN_NOTIONAL/1000}K within $${WALL_RANGE_USD}.`, confidence: 0 };
        }
        preferredReason += ` | ask wall@$${nearWall.price.toFixed(2)} ($${(nearWall.notionalUsd/1000).toFixed(0)}K)`;
    }

    // ── Gate 6a: Oscillation gate (multi-candle chop check) ───────────────────
    // Confirms the last 4 completed 5m candles are choppy, not trending.
    // A single doji is noise — we need the whole recent structure to be tight.
    const osc = isSafeOscillation(klines);
    if (!osc.safe) {
        return { direction: 'neutral', reasoning: `OSC BLOCK: ${osc.reason}`, confidence: 0 };
    }

    // ── Gate 6b: 5-second velocity guard (WebSocket aggTrade) ─────────────────
    // If the velocity monitor is live and detects a flush IN THE DIRECTION WE
    // WANT TO FADE, block entry. We don't block on the matching direction —
    // if we want to go long and buyers are spiking, that's momentum confirmation,
    // not a danger sign.
    //
    // Fail-open if WebSocket isn't ready yet (first few seconds after bot start).
    if (velocityState?.wsReady) {
        if (preferredDir === 'long'  && velocityState.isSellFlush) {
            return {
                direction:  'neutral',
                reasoning:  `VELOCITY BLOCK (LONG): sell flush detected — buy=${velocityState.buyVol5s} sell=${velocityState.sellVol5s} ratio=${velocityState.ratio}x. Sellers hitting bids aggressively.`,
                confidence: 0,
            };
        }
        if (preferredDir === 'short' && velocityState.isBuyFlush) {
            return {
                direction:  'neutral',
                reasoning:  `VELOCITY BLOCK (SHORT): buy spike detected — buy=${velocityState.buyVol5s} sell=${velocityState.sellVol5s} ratio=${velocityState.ratio}x. Buyers hitting asks aggressively.`,
                confidence: 0,
            };
        }
    }

    preferredReason += ` | osc:✓ ${osc.reason.split(':')[1]?.trim() ?? ''}`;
    return { direction: preferredDir, reasoning: preferredReason, confidence: preferredConf };
}

// ─── SIGNAL DISPATCHER ────────────────────────────────────────────────────────
export async function generateSignals(
    assets:        MarketData[],
    velocityState: import('./velocityMonitor.js').VelocityState | null = null,
): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        const { indicators: ind, price, bid, ask, symbol, regime, regimeReason, klines } = asset;

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

        const sig      = getDirection(ind, asset.orderBook, price, klines, velocityState);
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
