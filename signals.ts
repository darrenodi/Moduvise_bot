import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Read from env so the multi-symbol orchestrator can inject per-symbol values.
export const MARKET_SYMBOL  = process.env.MARKET_SYMBOL  ?? 'XAUUSDT';
export const DISPLAY_SYMBOL = process.env.DISPLAY_SYMBOL ?? 'XAU/USDT';

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
    // Tight cycle cadence for HFT — quick re-evaluation/re-entry after each close.
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 4_000,  cycleMsMax: 7_000,  sizePct: 1.00 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 5_000,  cycleMsMax: 9_000,  sizePct: 1.00 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 5_000,  cycleMsMax: 9_000,  sizePct: 1.00 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 9_000,  cycleMsMax: 14_000, sizePct: 1.00 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 9_000,  cycleMsMax: 14_000, sizePct: 1.00 };
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

// ─── RELATIVE SIGNAL THRESHOLDS (env-tunable, scale-free) ─────────────────────
// Every threshold is expressed relative to price/ATR so all four symbols behave
// identically regardless of absolute price. This is what makes XAU & DOGE trade.
const MAX_SPREAD_BPS    = Number(process.env.MAX_SPREAD_BPS    ?? 3.0);   // spread/price in basis points
const ATR_CEIL_PCT      = Number(process.env.ATR_CEIL_PCT      ?? 0.6);   // ATR as % of price — above = too fast
const ATR_FLOOR_PCT     = Number(process.env.ATR_FLOOR_PCT     ?? 0.02);  // ATR as % of price — below = dead
const MOM_TRAP_ATR      = Number(process.env.MOM_TRAP_ATR      ?? 1.0);   // momentum AGAINST dir, in ATR units
const MOM_STRONG_ATR    = Number(process.env.MOM_STRONG_ATR    ?? 0.5);   // pure-momentum entry, ATR units
const MOM_CONFIRM_ATR   = Number(process.env.MOM_CONFIRM_ATR   ?? 0.15);  // OB+momentum confirm, ATR units
const MOM_WEAK_ATR      = Number(process.env.MOM_WEAK_ATR      ?? 0.25);  // |mom| below this = weak
const OB_STRONG         = Number(process.env.OB_STRONG         ?? 0.35);  // strong book imbalance
const OB_LEAN           = Number(process.env.OB_LEAN           ?? 0.15);  // mild book imbalance
const ADX_TREND         = Number(process.env.ADX_TREND         ?? 25);    // ADX >= this = trending
const ADX_RANGE         = Number(process.env.ADX_RANGE         ?? 20);    // ADX < this = ranging
const WALL_RANGE_PCT    = Number(process.env.WALL_RANGE_PCT    ?? 0.05);  // wall must be within this % of price
const WALL_MIN_NOTIONAL = Number(process.env.WALL_MIN_NOTIONAL ?? 20_000);
const REQUIRE_WALL      = (process.env.REQUIRE_WALL ?? 'true') === 'true';

// ─── OSCILLATION / RANGING GATE ───────────────────────────────────────────────
const OSCILLATION_LOOKBACK = 4;
const BODY_RATIO_MAX       = 0.75;
const OVERLAP_MIN_FRACTION = 0.67;
const OSC_NET_MOVE_ATR     = Number(process.env.OSC_NET_MOVE_ATR ?? 2.0); // per-candle net move cap, ATR units

export function isSafeOscillation(klines: any[], atr5m: number): { safe: boolean; reason: string } {
    if (klines.length < OSCILLATION_LOOKBACK + 1) {
        return { safe: true, reason: 'Insufficient kline history — fail-open' };
    }

    const completed   = klines.slice(-(OSCILLATION_LOOKBACK + 1), -1);
    const atr         = atr5m > 0 ? atr5m : 1e-9;
    const netMoveMax  = OSC_NET_MOVE_ATR * atr;

    let overlapCount = 0;
    const failedCandles: string[] = [];

    for (let i = 0; i < completed.length; i++) {
        const c     = completed[i];
        const open  = Number(c[1]);
        const high  = Number(c[2]);
        const low   = Number(c[3]);
        const close = Number(c[4]);

        const totalRange = high - low;
        const netMove    = Math.abs(close - open);
        const bodyRatio  = totalRange > 0 ? netMove / totalRange : 0;

        if (bodyRatio > BODY_RATIO_MAX) {
            failedCandles.push(`C${i}: body=${(bodyRatio*100).toFixed(0)}%>${(BODY_RATIO_MAX*100).toFixed(0)}%`);
        }
        if (netMove > netMoveMax) {
            failedCandles.push(`C${i}: move=${(netMove/atr).toFixed(1)}ATR>${OSC_NET_MOVE_ATR}ATR`);
        }

        if (i > 0) {
            const prev     = completed[i - 1];
            const prevHigh = Number(prev[2]);
            const prevLow  = Number(prev[3]);
            if (low <= prevHigh && high >= prevLow) overlapCount++;
        }
    }

    const pairs           = completed.length - 1;
    const overlapFraction = pairs > 0 ? overlapCount / pairs : 1;

    if (overlapFraction < OVERLAP_MIN_FRACTION) {
        return {
            safe:   false,
            reason: `TRENDING: only ${(overlapFraction*100).toFixed(0)}% candle overlap (need ${(OVERLAP_MIN_FRACTION*100).toFixed(0)}%) — stairstepping`,
        };
    }
    if (failedCandles.length > 2) {
        return { safe: false, reason: `DIRECTIONAL CANDLES: ${failedCandles.join(', ')}` };
    }
    return { safe: true, reason: `Oscillation ok: ${(overlapFraction*100).toFixed(0)}% overlap, ${completed.length - failedCandles.length}/${completed.length} clean` };
}

// ─── MARKET REGIME CLASSIFIER ─────────────────────────────────────────────────
// Decides HOW we are allowed to trade, like a discretionary scalper would:
//   chaotic    → too fast / violent → sit out entirely
//   trend-up   → only longs (never fade a strong uptrend)
//   trend-down → only shorts
//   ranging    → both directions OK (ideal for tiny mean-reversion TP)
//   unclear    → allowed only on strong conviction
export type TradeRegime = 'chaotic' | 'trend-up' | 'trend-down' | 'ranging' | 'unclear';

function classifyRegime(
    ind: TechnicalIndicators,
    osc: { safe: boolean; reason: string },
): { regime: TradeRegime; reason: string } {
    const atrPct = ind.atrPct * 100;   // ind.atrPct is a fraction (atr/price)
    if (atrPct > ATR_CEIL_PCT) {
        return { regime: 'chaotic', reason: `ATR ${atrPct.toFixed(2)}% > ${ATR_CEIL_PCT}% — too fast` };
    }
    if (ind.adx >= ADX_TREND) {
        const up = ind.emaTrend === 'bullish';
        return { regime: up ? 'trend-up' : 'trend-down', reason: `ADX ${ind.adx.toFixed(0)} trending ${up ? 'up' : 'down'}` };
    }
    if (ind.adx < ADX_RANGE && osc.safe) {
        return { regime: 'ranging', reason: `ADX ${ind.adx.toFixed(0)} ranging; ${osc.reason}` };
    }
    return { regime: 'unclear', reason: `ADX ${ind.adx.toFixed(0)} mixed; ${osc.reason}` };
}

// ─── DIRECTION SIGNAL ─────────────────────────────────────────────────────────
function getDirection(
    ind:          TechnicalIndicators,
    orderBook:    MarketData['orderBook'],
    price:        number,
    klines:       any[],
    velocityState: import('./velocityMonitor.js').VelocityState | null,
): { direction: SignalDirection; reasoning: string; confidence: number } {
    const neutral = (reasoning: string) => ({ direction: 'neutral' as SignalDirection, reasoning, confidence: 0 });

    const ob        = ind.obImbalance;
    const atr       = ind.atr5m > 0 ? ind.atr5m : 1e-9;
    const momScore  = ind.momentum5m / atr;              // momentum in ATR units (scale-free)
    const atrPct    = ind.atrPct * 100;                  // ATR as % of price
    const spreadBps = price > 0 ? (ind.spreadUsd / price) * 1e4 : 999;

    // ── Gate 1: Spread (bps, scale-free) ──────────────────────────────────────
    if (process.env.ENVIRONMENT === 'live' && spreadBps > MAX_SPREAD_BPS) {
        return neutral(`SPREAD BLOCK: ${spreadBps.toFixed(2)}bps > ${MAX_SPREAD_BPS}bps`);
    }

    // ── Gate 2: ATR window — too fast (trap) or too dead (TP never reached) ────
    if (atrPct > ATR_CEIL_PCT) return neutral(`TOO FAST: ATR ${atrPct.toFixed(2)}% > ${ATR_CEIL_PCT}% ceiling`);
    if (atrPct < ATR_FLOOR_PCT) return neutral(`DEAD MARKET: ATR ${atrPct.toFixed(3)}% < ${ATR_FLOOR_PCT}% floor`);

    // ── Regime: decides which directions are even allowed ─────────────────────
    const osc                       = isSafeOscillation(klines, atr);
    const { regime, reason: regReason } = classifyRegime(ind, osc);
    if (regime === 'chaotic') return neutral(`CHAOTIC: ${regReason}`);

    // ── Gate 3: Genuine no-edge ───────────────────────────────────────────────
    if (Math.abs(ob) < OB_LEAN && Math.abs(momScore) < MOM_WEAK_ATR) {
        return neutral(`LOW CONVICTION: ob=${(ob*100).toFixed(0)}% mom=${momScore.toFixed(2)}ATR — no edge`);
    }

    // ── Direction: order-book led, momentum-confirmed (all ATR-normalized) ────
    let dir: SignalDirection = 'neutral';
    let conf = 0;
    let reason = '';

    if (ob > OB_STRONG) {
        dir = 'long';  conf = ob;            reason = `OB LONG ${(ob*100).toFixed(0)}%`;
    } else if (ob < -OB_STRONG) {
        dir = 'short'; conf = Math.abs(ob);  reason = `OB SHORT ${(Math.abs(ob)*100).toFixed(0)}%`;
    } else if (ob > OB_LEAN && momScore > MOM_CONFIRM_ATR) {
        dir = 'long';  conf = ob;            reason = `OB+MOM LONG ob=${(ob*100).toFixed(0)}% mom=${momScore.toFixed(2)}ATR`;
    } else if (ob < -OB_LEAN && momScore < -MOM_CONFIRM_ATR) {
        dir = 'short'; conf = Math.abs(ob);  reason = `OB+MOM SHORT ob=${(ob*100).toFixed(0)}% mom=${momScore.toFixed(2)}ATR`;
    } else if (momScore > MOM_STRONG_ATR) {
        dir = 'long';  conf = 0.30;          reason = `MOM LONG ${momScore.toFixed(2)}ATR`;
    } else if (momScore < -MOM_STRONG_ATR) {
        dir = 'short'; conf = 0.30;          reason = `MOM SHORT ${momScore.toFixed(2)}ATR`;
    } else {
        return neutral(`CONFLICTING: ob=${(ob*100).toFixed(0)}% mom=${momScore.toFixed(2)}ATR`);
    }

    // ── Regime alignment: never fade a trend; gate weak signals when unclear ──
    if (regime === 'trend-up'   && dir === 'short') return neutral(`COUNTER-TREND: ${regReason} — no shorts`);
    if (regime === 'trend-down' && dir === 'long')  return neutral(`COUNTER-TREND: ${regReason} — no longs`);
    if (regime === 'unclear'    && conf < OB_STRONG) return neutral(`UNCLEAR regime (${regReason}) — conviction too low`);

    // ── Gate 4: Momentum trap (strong momentum AGAINST the entry) ─────────────
    if (dir === 'long'  && momScore < -MOM_TRAP_ATR) return neutral(`MOM TRAP (LONG): ${momScore.toFixed(2)}ATR breaking down`);
    if (dir === 'short' && momScore >  MOM_TRAP_ATR) return neutral(`MOM TRAP (SHORT): ${momScore.toFixed(2)}ATR spiking up`);

    // ── Gate 4b: Don't enter into a marubozu against us ───────────────────────
    if (klines.length >= 2) {
        const lc      = klines[klines.length - 2];
        const o = Number(lc[1]), h = Number(lc[2]), l = Number(lc[3]), c = Number(lc[4]);
        const rng     = h - l;
        const bodyPct = rng > 0 ? Math.abs(c - o) / rng : 0;
        const MARUBOZU = 0.80;
        if (dir === 'long'  && c < o && bodyPct >= MARUBOZU) return neutral(`LAST CANDLE: ${(bodyPct*100).toFixed(0)}% bear body — no long`);
        if (dir === 'short' && c > o && bodyPct >= MARUBOZU) return neutral(`LAST CANDLE: ${(bodyPct*100).toFixed(0)}% bull body — no short`);
    }

    // ── Gate 5: Liquidity wall within a relative range ────────────────────────
    if (REQUIRE_WALL) {
        const wallRange = price * (WALL_RANGE_PCT / 100);
        if (dir === 'long') {
            const w = orderBook.bidWalls.find(w => w.price >= price - wallRange && w.notionalUsd >= WALL_MIN_NOTIONAL);
            if (!w) return neutral(`NO BID WALL >=$${(WALL_MIN_NOTIONAL/1000).toFixed(0)}K within ${WALL_RANGE_PCT}%`);
            reason += ` | bid wall@$${w.price.toFixed(2)} ($${(w.notionalUsd/1000).toFixed(0)}K)`;
        } else {
            const w = orderBook.askWalls.find(w => w.price <= price + wallRange && w.notionalUsd >= WALL_MIN_NOTIONAL);
            if (!w) return neutral(`NO ASK WALL >=$${(WALL_MIN_NOTIONAL/1000).toFixed(0)}K within ${WALL_RANGE_PCT}%`);
            reason += ` | ask wall@$${w.price.toFixed(2)} ($${(w.notionalUsd/1000).toFixed(0)}K)`;
        }
    }

    // ── Gate 6: 5-second velocity guard (don't enter into a flush/spike) ──────
    if (velocityState?.wsReady) {
        if (dir === 'long'  && velocityState.isSellFlush) return neutral(`VELOCITY: sell flush ratio=${velocityState.ratio}x`);
        if (dir === 'short' && velocityState.isBuyFlush)  return neutral(`VELOCITY: buy spike ratio=${velocityState.ratio}x`);
    }

    return { direction: dir, reasoning: `[${regime}] ${reason}`, confidence: conf };
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
