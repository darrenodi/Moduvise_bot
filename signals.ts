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
    topObImbalance:       number;   // imbalance of the top 3 levels (next-tick predictor)
    oiChangePct:          number;   // open-interest change over ~5min, % (0 if unknown)
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

// ─── TRADING BLACKOUT ─────────────────────────────────────────────────────────
// Weekend trading is ALLOWED — the perp keeps trading (thinner, slower) even
// while the underlying spot/COMEX market is shut, so a blanket weekend block was
// leaving real (if smaller) opportunity on the table. Thin/quiet weekend
// stretches are handled by the fee-aware TP floor in executeTrade (which sizes
// the TP honestly no matter how quiet it gets), not a blanket calendar/ATR rule
// — both the old LOW-session block and the ATR "dead market" floor were found
// to over-block genuinely tradeable quiet periods and have been removed.
// Blocks entries only when:
//  1. Daily settlement break (21:00–22:05 UTC, every day) — frozen-index window.
//  2. Scheduled US data windows (default 12:30, 14:00, 18:00 UTC = 8:30 ET data,
//     10:00 ET data, FOMC), ±NEWS_BLACKOUT_MIN minutes. Gold does $30 candles on
//     CPI/NFP/Fed — no snapshot gate can see those coming; the calendar can.
const NEWS_BLACKOUT_MIN   = Number(process.env.NEWS_BLACKOUT_MIN ?? 10);
const NEWS_BLACKOUT_TIMES = (process.env.NEWS_BLACKOUT_TIMES ?? '12:30,14:00,18:00')
    .split(',').map(s => s.trim()).filter(Boolean);

export function getTradingBlackout(now = new Date()): string | null {
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

    // Daily settlement break 21:00–22:05 UTC (applies every day, incl. weekends)
    if (mins >= 21 * 60 && mins < 22 * 60 + 5) return 'DAILY BREAK: 21:00–22:05 UTC (frozen index)';

    // Scheduled news windows (weekdays)
    for (const t of NEWS_BLACKOUT_TIMES) {
        const [h, m] = t.split(':').map(Number);
        if (!Number.isFinite(h)) continue;
        const target = h * 60 + (m || 0);
        if (Math.abs(mins - target) <= NEWS_BLACKOUT_MIN) {
            return `NEWS WINDOW: ±${NEWS_BLACKOUT_MIN}min around ${t} UTC`;
        }
    }
    return null;
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
const RSI_OVERBOUGHT    = Number(process.env.RSI_OVERBOUGHT    ?? 75);    // don't buy exhausted tops (no-SL killer)
const RSI_OVERSOLD      = Number(process.env.RSI_OVERSOLD      ?? 25);    // don't sell exhausted bottoms (RSI 22.2 short liquidated us)
const FLOW_1M_AGAINST   = Number(process.env.FLOW_1M_AGAINST   ?? 1.3);   // block if 60s cumulative flow opposes by more than this ratio
const VWAP_EXT_MAX_PCT  = Number(process.env.VWAP_EXT_MAX_PCT  ?? 0.0);   // max % price may be stretched PAST VWAP in the trade's direction (0 = enter at/behind value only)
const RANGING_ONLY      = (process.env.RANGING_ONLY ?? 'true') === 'true'; // user spec 2026-07-11: trade only when regime classifies as 'ranging'
const MOM_ALIGN         = (process.env.MOM_ALIGN    ?? 'true') === 'true'; // user spec 2026-07-11: 5m momentum must already point in the trade's direction
// Was 'true' by default (blocks Asia/off-hours + NY-close, i.e. ~14h/day) from
// back when a bad drift trade could ride to liquidation. That risk is now fixed
// structurally: SL is hard-capped at exactly SL_MAX_WIN_MULTIPLE x whatever TP is
// (see executeTrade calcSlDistance), and TP itself is ATR-adaptive to the actual
// (quieter) volatility of those hours — so a low-liquidity-hour trade is already
// sized down and loss-capped, not exposed the way it was when this gate was added.
// Blocking all LOW hours now just costs trading time without addressing a live
// risk. Default OFF; set BLOCK_LOW_SESSIONS=true to restore the old behavior.
const BLOCK_LOW_SESSIONS = (process.env.BLOCK_LOW_SESSIONS ?? 'false') === 'true';
const FUNDING_EXTREME   = Number(process.env.FUNDING_EXTREME   ?? 0.0005);// don't join the crowded side when funding is extreme (squeeze risk)
const OI_SURGE_PCT      = Number(process.env.OI_SURGE_PCT      ?? 2.0);   // OI +% in ~5m = new money piling in; block if momentum opposes us
const TOUCH_CONFIRM     = Number(process.env.TOUCH_CONFIRM     ?? 0.12);  // top-of-book must lean THIS far in our direction (confirmation)
const FLOW_AGAINST      = Number(process.env.FLOW_AGAINST      ?? 1.15);  // block if opposing 5s trade flow exceeds this ratio
const ATR_CEIL_PCT      = Number(process.env.ATR_CEIL_PCT      ?? 0.6);   // ATR as % of price — above = too fast
const MOM_TRAP_ATR      = Number(process.env.MOM_TRAP_ATR      ?? 0.6);   // momentum AGAINST dir, in ATR units (tighter: no SL)
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

    // ── Gate 0: Trading blackout (weekend frozen index, daily break, news) ─────
    const blackout = getTradingBlackout();
    if (blackout) return neutral(`BLACKOUT: ${blackout}`);

    // ── Gate 0b: Session quality — no entries in thin/drift hours. Both live
    //    losses (174min ride, 72min ride) entered during Asia/off-hours; the
    //    wins-fast scalp thesis needs active liquidity behind it. ───────────────
    if (BLOCK_LOW_SESSIONS && getSession().quality === 'LOW') {
        return neutral(`LOW SESSION (${getSession().name}) — thin hours, no scalping edge`);
    }

    const ob        = ind.obImbalance;
    const top       = ind.topObImbalance;                // top-of-book (next-tick) imbalance
    const atr       = ind.atr5m > 0 ? ind.atr5m : 1e-9;
    const momScore  = ind.momentum5m / atr;              // momentum in ATR units (scale-free)
    const atrPct    = ind.atrPct * 100;                  // ATR as % of price
    // (Spread is gated per-asset at execution time in executeTrade, not here.)

    // ── Gate 2: ATR ceiling only — no floor ────────────────────────────────────
    // Explicit user decision (2026-07-05): this is a HIGH-FREQUENCY scalper and
    // must keep trading through quiet stretches, not idle waiting for volatility.
    // A prior fix added an ATR floor here (skip if TP would be "fee-floor-pinned")
    // after a 2-day audit showed those trades resolving badly — but blocking them
    // means the bot goes fully dark during gold's calmest (and probably most
    // common) hours, which directly conflicts with the frequency goal. Resolved
    // by NOT blocking entry — instead executeTrade's calcTpDistance lets TP
    // shrink to its real tick floor in calm markets, and the loss-per-win ratio
    // floats above SL_MAX_WIN_MULTIPLE specifically on those small-TP trades
    // (disclosed, bounded, not unbounded). Do not re-add an ATR floor gate here
    // without asking first — this exact flip/flop has happened twice already.
    if (atrPct > ATR_CEIL_PCT) return neutral(`TOO FAST: ATR ${atrPct.toFixed(2)}% > ${ATR_CEIL_PCT}% ceiling`);

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

    // ── Gate 3a2: RANGING ONLY (user spec 2026-07-11: "only enter... when market
    //    is ranging"). Data agrees: 2026-07-10 sample ran ~80% WR in ranging vs
    //    ~64% in unclear and worse in trends. Cuts frequency; that's the point. ──
    if (RANGING_ONLY && regime !== 'ranging') {
        return neutral(`NOT RANGING: regime=${regime} (${regReason}) — ranging-only mode`);
    }

    // ── Gate 3a3: MOMENTUM ALIGNMENT (user spec 2026-07-11: "only enter when
    //    price is going in my direction"). OB-led entries may fire against the
    //    live 5m move; require the tape to already lean our way. ────────────────
    if (MOM_ALIGN) {
        if (dir === 'long'  && momScore <= 0) return neutral(`MOM NOT ALIGNED: ${momScore.toFixed(2)}ATR ≤ 0 — price not moving up yet`);
        if (dir === 'short' && momScore >= 0) return neutral(`MOM NOT ALIGNED: ${momScore.toFixed(2)}ATR ≥ 0 — price not moving down yet`);
    }

    // ── Gate 3b: Exhaustion — never chase an overbought top / oversold bottom.
    //    This is what liquidated the no-SL long (bought RSI 79.5 blowoff top). ───
    if (dir === 'long'  && ind.rsi >= RSI_OVERBOUGHT) return neutral(`OVERBOUGHT: RSI ${ind.rsi.toFixed(0)} ≥ ${RSI_OVERBOUGHT} — no long into blowoff`);
    if (dir === 'short' && ind.rsi <= RSI_OVERSOLD)   return neutral(`OVERSOLD: RSI ${ind.rsi.toFixed(0)} ≤ ${RSI_OVERSOLD} — no short into capitulation`);

    // ── Gate 3b2: VWAP extension — enter at value, never chase past it. ────────
    // MAE path audit 2026-07-07 (90 trades, drawdown reconstructed from 1m
    // candles): 82% of entries took ≥$1.50 heat before resolving — the signal
    // direction was fine but the TIMING was late, firing after the move was
    // already stretched. The one variable that cleanly separated "straight to
    // TP" entries (9 trades, 100% win, ≤$0.50 heat) from divers: VWAP side.
    // Clean entries were at/below VWAP (longs) — extension ≤ +0.17%, mostly
    // negative. Divers were 77% extended past VWAP. Gating at 0.0 (enter longs
    // only at-or-below VWAP, shorts only at-or-above) kept 26/90 trades:
    // WR 56→62%, avg MAE $4.43→$3.01, net PnL −$0.13→+$0.03. Costs ~⅔ of
    // frequency — that's the price of not buying the top of every micro-swing.
    // REGIME-SCOPED (fixed 2026-07-09): applying this gate in trend regimes
    // deadlocked the bot for a full day — in a downtrend only shorts are allowed
    // (regime filter) but price sits below VWAP nearly continuously, so the gate
    // blocked every short and the bot went dark all of Jul 8 (fourth over-blocking
    // gate; the memory file warned about exactly this pattern). Per-regime re-run
    // of the same 90-trade MAE sweep: in RANGE/UNCLEAR the 0.0 gate is the best
    // config tested (WR 55→64%, net −$0.23→+$0.06); in TREND regimes it keeps
    // 1/28 trades while ungated with-trend entries were the most profitable bucket
    // of all (57% WR, +$0.11) — extension past VWAP is normal in a trend. So:
    // value-side entry discipline in ranges only; trends rely on the regime filter.
    if (regime === 'ranging' || regime === 'unclear') {
        const vwapExt = dir === 'long' ? ind.priceVsVwap : -ind.priceVsVwap;   // % stretched in OUR direction
        if (vwapExt > VWAP_EXT_MAX_PCT) {
            return neutral(`CHASING: ${Math.abs(ind.priceVsVwap).toFixed(2)}% past VWAP in trade direction (max ${VWAP_EXT_MAX_PCT}) — wait for value side`);
        }
    }

    // ── Gate 3c: Sentiment — funding + open-interest ──────────────────────────
    // Extreme funding = one side is crowded and paying to stay in; joining that
    // side is squeeze bait. OI surging while momentum runs against us = new money
    // aggressively positioned the other way.
    const funding = ind.fundingRate ?? 0;
    if (dir === 'long'  && funding >=  FUNDING_EXTREME) return neutral(`FUNDING CROWDED LONG: ${(funding*100).toFixed(3)}% — squeeze risk`);
    if (dir === 'short' && funding <= -FUNDING_EXTREME) return neutral(`FUNDING CROWDED SHORT: ${(funding*100).toFixed(3)}% — squeeze risk`);
    if (ind.oiChangePct >= OI_SURGE_PCT) {
        if (dir === 'long'  && momScore < 0) return neutral(`OI SURGE +${ind.oiChangePct.toFixed(1)}% with momentum down — new shorts piling in`);
        if (dir === 'short' && momScore > 0) return neutral(`OI SURGE +${ind.oiChangePct.toFixed(1)}% with momentum up — new longs piling in`);
    }

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

    // ── Gate 6: Top-of-book must CONFIRM the entry (sets the next tick). With no
    //            SL, a bad-direction entry rides deep — so require the best levels
    //            to actively lean our way, not merely "not oppose". ──────────────
    if (dir === 'long'  && top < TOUCH_CONFIRM)  return neutral(`TOUCH not confirming LONG: top ${(top*100).toFixed(0)}% < ${(TOUCH_CONFIRM*100).toFixed(0)}%`);
    if (dir === 'short' && top > -TOUCH_CONFIRM) return neutral(`TOUCH not confirming SHORT: top ${(top*100).toFixed(0)}% > -${(TOUCH_CONFIRM*100).toFixed(0)}%`);

    // ── Gate 7: Real-time trade flow, two horizons ─────────────────────────────
    //   5s window  = fast veto: don't step in front of an active flush/spike.
    //   60s window = trend: sustained cumulative delta must not oppose the entry
    //   (a 5s snapshot decays in seconds; the 1m delta actually spans our trade).
    if (velocityState?.wsReady) {
        const b = velocityState.buyVol5s,  s  = velocityState.sellVol5s;
        const b60 = velocityState.buyVol60s, s60 = velocityState.sellVol60s;
        if (dir === 'long'  && s > b * FLOW_AGAINST && s > 0) return neutral(`FLOW AGAINST LONG: sell ${s} > ${FLOW_AGAINST}× buy ${b}`);
        if (dir === 'short' && b > s * FLOW_AGAINST && b > 0) return neutral(`FLOW AGAINST SHORT: buy ${b} > ${FLOW_AGAINST}× sell ${s}`);
        if (dir === 'long'  && s60 > b60 * FLOW_1M_AGAINST && s60 > 0) return neutral(`1M FLOW AGAINST LONG: sell ${s60} > ${FLOW_1M_AGAINST}× buy ${b60}`);
        if (dir === 'short' && b60 > s60 * FLOW_1M_AGAINST && b60 > 0) return neutral(`1M FLOW AGAINST SHORT: buy ${b60} > ${FLOW_1M_AGAINST}× sell ${s60}`);

        // Confidence boost when the 1m delta actively agrees with the entry.
        const deltaAgrees = dir === 'long' ? velocityState.delta60s > 0 : velocityState.delta60s < 0;
        if (deltaAgrees) conf = Math.min(1, conf + 0.15);
    }

    return { direction: dir, reasoning: `[${regime}] ${reason} | top=${(top*100).toFixed(0)}%`, confidence: conf };
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
