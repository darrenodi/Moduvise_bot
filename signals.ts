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
// Fill-quality prediction: before asking WHICH direction, ask WHETHER this
// market will produce a safe fill. A limit fill only profits when the market
// retraces gently into the order and bounces. It loses when the market is
// aggressively breaking through. Three gates guard against the latter:
//
//   Gate 1 — ATR ceiling:     if market is moving faster than 2.5× normal
//             candle range, we are in a trending / news-driven move. $0.05 TP
//             is noise relative to the move size → sit out.
//
//   Gate 2 — Momentum trap:   a strong directional momentum5m means the market
//             is already running. Entering against it (as a limit must) risks
//             filling into a freight train rather than a micro-oscillation.
//             Allow mildly adverse momentum (retracement); block strong momentum.
//
//   Gate 3 — Wall check:      only enter long if there is a resting bid wall
//             within $0.50 below entry to act as a bounce cushion. Same for
//             shorts and ask walls. If the book below (above) is thin, a fill
//             into us has nothing to stop further adverse movement.
//
//   Gate 4 — Genuine neutral: if OB imbalance is weak AND momentum is weak,
//             there is no edge. Return neutral — do NOT trade just to trade.
//             This replaces the old always-fire ranging fallback which was the
//             primary cause of losses in low-conviction choppy conditions.
//
// The dip/rip regime check in generateSignals() is the outer gate — it runs
// before getDirection() and blocks all signals during large fast moves.
function getDirection(
    ind:      TechnicalIndicators,
    orderBook: MarketData['orderBook'],
    price:    number,
): { direction: SignalDirection; reasoning: string; confidence: number } {
    const ob  = ind.obImbalance;
    const m5  = ind.momentum5m;

    // ── GATE 1: ATR ceiling ───────────────────────────────────────────────────
    // When ATR > $2.50, the market is moving too fast for a $0.05-$0.20 scalp.
    // A single candle's noise exceeds our entire TP — fills become lottery tickets.
    const ATR_CEILING = 7.30;
    if (ind.atr5m > ATR_CEILING) {
        return {
            direction: 'neutral',
            reasoning: `TRAP MARKET: ATR=$${ind.atr5m.toFixed(2)} > $${ATR_CEILING} ceiling. Sitting out.`,
            confidence: 0,
        };
    }

    // ── GATE 2: Spread ────────────────────────────────────────────────────────
    // Spread >= $0.15 means we start the trade behind by more than 75% of TP.
    if (ind.spreadUsd >= 0.15) {
        return {
            direction: 'neutral',
            reasoning: `SPREAD BLOCK: $${ind.spreadUsd.toFixed(3)} (max $0.15)`,
            confidence: 0,
        };
    }

    // ── GATE 3: Genuine neutral — no weak-signal trades ───────────────────────
    // If neither OB nor momentum shows meaningful conviction, there is no edge.
    // Return neutral rather than gambling on noise. This replaces the old
    // always-fire ranging fallback which never returned neutral and was the
    // root cause of losses in low-conviction choppy conditions.
    const obWeak  = ob > -0.15 && ob < 0.15;
    const momWeak = m5 > -0.10 && m5 < 0.10;
    if (obWeak && momWeak) {
        return {
            direction: 'neutral',
            reasoning: `LOW CONVICTION: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)} — no edge, skipping.`,
            confidence: 0,
        };
    }

    // ── DIRECTION DETERMINATION ────────────────────────────────────────────────
    // Resolve preferred direction from OB imbalance (primary) + momentum (confirmation).

    let preferredDir: SignalDirection = 'neutral';
    let preferredConf = 0;
    let preferredReason = '';

    // Strong OB signal — fire without requiring momentum confirmation
    if (ob > 0.35) {
        preferredDir    = 'long';
        preferredConf   = ob;
        preferredReason = `OB LONG: imbalance=${(ob*100).toFixed(0)}% buy pressure`;
    } else if (ob < -0.35) {
        preferredDir    = 'short';
        preferredConf   = Math.abs(ob);
        preferredReason = `OB SHORT: imbalance=${(Math.abs(ob)*100).toFixed(0)}% sell pressure`;
    // OB + momentum agreement
    } else if (ob > 0.15 && m5 > 0.05) {
        preferredDir    = 'long';
        preferredConf   = ob;
        preferredReason = `OB+MOM LONG: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)}`;
    } else if (ob < -0.15 && m5 < -0.05) {
        preferredDir    = 'short';
        preferredConf   = Math.abs(ob);
        preferredReason = `OB+MOM SHORT: ob=${(Math.abs(ob)*100).toFixed(0)}% mom=$${m5.toFixed(2)}`;
    // Momentum only
    } else if (m5 > 0.10) {
        preferredDir    = 'long';
        preferredConf   = 0.30;
        preferredReason = `MOM LONG: $${m5.toFixed(3)}/5m`;
    } else if (m5 < -0.10) {
        preferredDir    = 'short';
        preferredConf   = 0.30;
        preferredReason = `MOM SHORT: $${m5.toFixed(3)}/5m`;
    } else {
        // Reached here means one of OB or mom is non-weak but they disagree.
        // Conflicting signals = no edge.
        return {
            direction: 'neutral',
            reasoning: `CONFLICTING SIGNALS: ob=${(ob*100).toFixed(0)}% mom=$${m5.toFixed(2)} — disagreement, skipping.`,
            confidence: 0,
        };
    }

    // ── GATE 4: Momentum trap guard ───────────────────────────────────────────
    // A limit buy fills when sellers push price DOWN to us. That's fine if the
    // selling is mild (noise). It's dangerous if momentum is a strong downtrend —
    // our fill would occur mid-breakdown, not mid-oscillation.
    //
    // Allow: mildly negative momentum for longs (retracement)
    // Block: strongly negative momentum for longs (breakdown)
    //
    // Threshold: $0.50 on a 5m candle is ~1/5 of ATR at $2.50 ceiling —
    // moderate but not extreme. Adjust via MOMENTUM_TRAP_USD if needed.
    const MOMENTUM_TRAP_USD = 0.50;
    if (preferredDir === 'long'  && m5 < -MOMENTUM_TRAP_USD) {
        return {
            direction: 'neutral',
            reasoning: `MOMENTUM TRAP (LONG): 5m momentum=$${m5.toFixed(2)} — price breaking down, not retracing.`,
            confidence: 0,
        };
    }
    if (preferredDir === 'short' && m5 > MOMENTUM_TRAP_USD) {
        return {
            direction: 'neutral',
            reasoning: `MOMENTUM TRAP (SHORT): 5m momentum=$${m5.toFixed(2)} — price spiking up, not retracing.`,
            confidence: 0,
        };
    }

    // ── GATE 5: Order book wall check ─────────────────────────────────────────
    // A safe limit long fill requires a resting bid wall below us to bounce
    // off. Without it, sellers who fill us keep selling through — no reversal.
    // Same logic inverted for shorts and ask walls.
    //
    // Require at least one wall within $0.50 of current price with >= $20K notional.
    // (Wall data is populated in main.ts buildLiveMarketData. If walls are empty
    // this gate passes through — fail-open so a bad data cycle doesn't freeze the bot.)
    const WALL_RANGE_USD     = 0.50;
    const WALL_MIN_NOTIONAL  = 20_000;

    if (preferredDir === 'long' && orderBook.bidWalls.length > 0) {
        const nearWall = orderBook.bidWalls.find(
            w => w.price >= price - WALL_RANGE_USD && w.notionalUsd >= WALL_MIN_NOTIONAL
        );
        if (!nearWall) {
            return {
                direction: 'neutral',
                reasoning: `NO BID WALL: no wall >= $${WALL_MIN_NOTIONAL/1000}K within $${WALL_RANGE_USD} of price. Fill unprotected.`,
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
                reasoning: `NO ASK WALL: no wall >= $${WALL_MIN_NOTIONAL/1000}K within $${WALL_RANGE_USD} of price. Fill unprotected.`,
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
                suggested_leverage: Number(process.env.BOT_LEVERAGE ?? 50),
                session_size_pct:   1.00,
            });
            continue;
        }

        const sig = getDirection(ind, asset.orderBook, price);
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
