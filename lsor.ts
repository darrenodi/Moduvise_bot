// ─── LSOR: Liquidity Sweep + Order-Flow Reversal ─────────────────────────────
// Built 2026-07-29 to the pro-trader spec, in response to a MEASURED problem:
// after switching to maker entry, 61 fills / 30 closes produced 50% WR with
// avg MFE $26.29 vs avg MAE $46.80 — a 1.78:1 adverse ratio. That is textbook
// ADVERSE SELECTION: a post-only order only fills when someone wants to trade
// against you, so quoting passively INTO momentum makes you the exit liquidity
// for informed flow.
//
// The fix is not a different fee mode (taker died to fees at a 7.8bps target,
// maker dies to toxic fills). It is WHERE and WHEN the passive order is placed:
//   sweep a liquidity level -> aggressive flow exhausts -> price reclaims ->
//   order flow flips -> only THEN quote passively.
//
// Scoring is 6 conditions; the caller decides the threshold (spec: >=5/6 for a
// new strategy, >=4/6 once validated).

import type { TechnicalIndicators, MarketData, SignalDirection } from './signals.js';
import type { VelocityState } from './velocityMonitor.js';

export interface LsorResult {
    direction: SignalDirection;
    score:     number;
    max:       number;
    reasons:   string[];
    /** Suggested passive entry price (the reclaimed level), 0 if no setup. */
    entryHint: number;
}

interface Level { price: number; kind: string }

/** Build the liquidity map: recent swing highs/lows + session extremes.
 *  These are where stops, liquidations and breakout orders cluster. */
export function buildLiquidityMap(klines: any[], lookback = 60): { highs: Level[]; lows: Level[] } {
    const highs: Level[] = [];
    const lows:  Level[] = [];
    if (!Array.isArray(klines) || klines.length < 10) return { highs, lows };

    const bars = klines.slice(-lookback);
    // Fractal swing points: a high with 2 lower highs each side (and inverse).
    for (let i = 2; i < bars.length - 2; i++) {
        const h = Number(bars[i][2]), l = Number(bars[i][3]);
        const hL = Number(bars[i-1][2]), hL2 = Number(bars[i-2][2]);
        const hR = Number(bars[i+1][2]), hR2 = Number(bars[i+2][2]);
        const lL = Number(bars[i-1][3]), lL2 = Number(bars[i-2][3]);
        const lR = Number(bars[i+1][3]), lR2 = Number(bars[i+2][3]);
        if (h > hL && h > hL2 && h > hR && h > hR2) highs.push({ price: h, kind: 'swingHigh' });
        if (l < lL && l < lL2 && l < lR && l < lR2) lows.push({ price: l, kind: 'swingLow' });
    }
    // Session extremes over the lookback window.
    const sessHigh = Math.max(...bars.map((b: any) => Number(b[2])));
    const sessLow  = Math.min(...bars.map((b: any) => Number(b[3])));
    highs.push({ price: sessHigh, kind: 'sessionHigh' });
    lows.push({ price: sessLow,  kind: 'sessionLow'  });
    return { highs, lows };
}

/** Did price sweep BELOW a support level and reclaim it? (long setup)
 *  Returns the reclaimed level, or 0. */
function findSweepReclaimLong(klines: any[], lows: Level[], tolPct: number): number {
    if (klines.length < 4) return 0;
    const n = klines.length;
    const cur = Number(klines[n-1][4]);           // current close
    // look at the last 3 completed candles for the sweep
    for (let back = 2; back <= 4 && back < n; back++) {
        const lo = Number(klines[n-back][3]);
        for (const lvl of lows) {
            const tol = lvl.price * tolPct;
            // wick went below the level...
            if (lo < lvl.price - tol * 0.1) {
                // ...and price is now back ABOVE it = reclaim
                if (cur > lvl.price + tol * 0.1) return lvl.price;
            }
        }
    }
    return 0;
}

/** Mirror: swept ABOVE resistance and reclaimed back below. (short setup) */
function findSweepReclaimShort(klines: any[], highs: Level[], tolPct: number): number {
    if (klines.length < 4) return 0;
    const n = klines.length;
    const cur = Number(klines[n-1][4]);
    for (let back = 2; back <= 4 && back < n; back++) {
        const hi = Number(klines[n-back][2]);
        for (const lvl of highs) {
            const tol = lvl.price * tolPct;
            if (hi > lvl.price + tol * 0.1) {
                if (cur < lvl.price - tol * 0.1) return lvl.price;
            }
        }
    }
    return 0;
}

export function evaluateLsor(
    ind: TechnicalIndicators,
    orderBook: MarketData['orderBook'],
    price: number,
    klines: any[],
    vel: VelocityState | null,
): LsorResult {
    const tolPct   = Number(process.env.LSOR_LEVEL_TOL_PCT ?? 0.0006); // 6bps zone around a level
    const obMin    = Number(process.env.LSOR_OB_MIN ?? 0.15);
    const spreadMaxBps = Number(process.env.LSOR_SPREAD_MAX_BPS ?? 3);

    const { highs, lows } = buildLiquidityMap(klines);
    const longLevel  = findSweepReclaimLong(klines, lows, tolPct);
    const shortLevel = findSweepReclaimShort(klines, highs, tolPct);

    // Decide which side has a setup at all. If both (rare chop), prefer the one
    // aligned with VWAP regime.
    let dir: SignalDirection = 'neutral';
    let level = 0;
    if (longLevel && !shortLevel)      { dir = 'long';  level = longLevel; }
    else if (shortLevel && !longLevel) { dir = 'short'; level = shortLevel; }
    else if (longLevel && shortLevel)  {
        if (ind.priceVsVwap < 0) { dir = 'long';  level = longLevel; }
        else                     { dir = 'short'; level = shortLevel; }
    }

    const reasons: string[] = [];
    if (dir === 'neutral') {
        return { direction: 'neutral', score: 0, max: 6, reasons: ['no sweep+reclaim'], entryHint: 0 };
    }

    let score = 0;

    // 1. Liquidity sweep occurred + reclaimed (this is why we're here at all)
    score++; reasons.push(`sweep+reclaim @${level.toFixed(1)}`);

    // 2. Order-flow / delta improving in our favour (exhaustion of the sweep)
    if (vel?.wsReady) {
        const d = vel.delta60s;
        const flowOk = dir === 'long' ? d > 0 : d < 0;
        if (flowOk) { score++; reasons.push(`delta60s ${d.toFixed(2)} favours ${dir}`); }
        else reasons.push(`delta60s ${d.toFixed(2)} against`);
    } else {
        reasons.push('no flow data');
    }

    // 3. Order-book imbalance supports the direction
    const ob = ind.obImbalance;
    const obOk = dir === 'long' ? ob >= obMin : ob <= -obMin;
    if (obOk) { score++; reasons.push(`ob ${(ob*100).toFixed(0)}%`); }
    else reasons.push(`ob ${(ob*100).toFixed(0)}% weak`);

    // 4. Top-of-book (next-tick) agrees — guards against stale depth
    const top = ind.topObImbalance;
    const topOk = dir === 'long' ? top > 0 : top < 0;
    if (topOk) { score++; reasons.push(`top ${(top*100).toFixed(0)}%`); }
    else reasons.push(`top ${(top*100).toFixed(0)}% against`);

    // 5. VWAP / regime supports the trade (mean-reversion back toward value)
    const vwapOk = dir === 'long' ? ind.priceVsVwap <= 0.10 : ind.priceVsVwap >= -0.10;
    if (vwapOk) { score++; reasons.push(`vwapDev ${ind.priceVsVwap.toFixed(3)}%`); }
    else reasons.push(`vwapDev ${ind.priceVsVwap.toFixed(3)}% extended`);

    // 6. Execution conditions: spread tight enough to make a passive fill worth it
    const spreadBps = price > 0 ? (ind.spreadUsd / price) * 1e4 : 99;
    if (spreadBps <= spreadMaxBps) { score++; reasons.push(`spread ${spreadBps.toFixed(2)}bps`); }
    else reasons.push(`spread ${spreadBps.toFixed(2)}bps wide`);

    return { direction: dir, score, max: 6, reasons, entryHint: level };
}


// ─── MPM: Momentum Pullback Maker ────────────────────────────────────────────
// Strategy V2 (2026-07-29). Sequence: impulse -> breakout of a swing level ->
// pullback back toward that level -> passive entry near it.
// Rationale: quoting INTO momentum got picked off (live MFE/MAE 1.78 against).
// Quoting at a reclaimed level after the market has already proven direction
// measured MFE/MAE 1.02 FOR us on candle data.
export function evaluateMpm(
    ind: TechnicalIndicators,
    price: number,
    klines: any[],
    vel: VelocityState | null,
): LsorResult {
    const pullBps = Number(process.env.MPM_PULLBACK_BPS ?? 8);
    const lookback = Number(process.env.MPM_BREAK_LOOKBACK ?? 6);
    const reasons: string[] = [];
    if (!Array.isArray(klines) || klines.length < 70) {
        return { direction: 'neutral', score: 0, max: 6, reasons: ['insufficient history'], entryHint: 0 };
    }
    const n = klines.length;
    const c = Number(klines[n-1][4]);
    const { highs, lows } = buildLiquidityMap(klines);
    const vol = klines.slice(-21, -1).map((b: any) => Number(b[5]));
    const avgVol = vol.reduce((a,b)=>a+b,0) / Math.max(vol.length,1);

    const impulseAt = (bi: number) => Number(klines[bi][4]) - Number(klines[bi-3][4]);

    // LONG: recently closed above a swing high, now pulled back near it (still above)
    for (const lvl of [...highs].sort((a,b)=>b.price-a.price).slice(0,6)) {
        for (let j = Math.max(3, n-1-lookback); j < n-1; j++) {
            if (Number(klines[j][4]) <= lvl.price) continue;
            if (impulseAt(j) <= 0) continue;
            if (Number(klines[j][5]) < avgVol) continue;
            if (ind.priceVsVwap < 0) continue;                 // regime: at/above value
            const distBps = (c - lvl.price) / lvl.price * 1e4;
            if (distBps >= 0 && distBps <= pullBps) {
                let score = 3;                                  // impulse + breakout + pullback
                reasons.push(`broke ${lvl.kind} @${lvl.price.toFixed(1)}`, `pullback ${distBps.toFixed(1)}bps`);
                if (vel?.wsReady && vel.delta60s > 0) { score++; reasons.push(`delta ${vel.delta60s.toFixed(2)}`); }
                if (ind.obImbalance > 0) { score++; reasons.push(`ob ${(ind.obImbalance*100).toFixed(0)}%`); }
                if (ind.topObImbalance > 0) { score++; reasons.push(`top ${(ind.topObImbalance*100).toFixed(0)}%`); }
                return { direction: 'long', score, max: 6, reasons, entryHint: lvl.price };
            }
        }
    }
    // SHORT: mirror
    for (const lvl of [...lows].sort((a,b)=>a.price-b.price).slice(0,6)) {
        for (let j = Math.max(3, n-1-lookback); j < n-1; j++) {
            if (Number(klines[j][4]) >= lvl.price) continue;
            if (impulseAt(j) >= 0) continue;
            if (Number(klines[j][5]) < avgVol) continue;
            if (ind.priceVsVwap > 0) continue;
            const distBps = (lvl.price - c) / lvl.price * 1e4;
            if (distBps >= 0 && distBps <= pullBps) {
                let score = 3;
                reasons.push(`broke ${lvl.kind} @${lvl.price.toFixed(1)}`, `pullback ${distBps.toFixed(1)}bps`);
                if (vel?.wsReady && vel.delta60s < 0) { score++; reasons.push(`delta ${vel.delta60s.toFixed(2)}`); }
                if (ind.obImbalance < 0) { score++; reasons.push(`ob ${(ind.obImbalance*100).toFixed(0)}%`); }
                if (ind.topObImbalance < 0) { score++; reasons.push(`top ${(ind.topObImbalance*100).toFixed(0)}%`); }
                return { direction: 'short', score, max: 6, reasons, entryHint: lvl.price };
            }
        }
    }
    return { direction: 'neutral', score: 0, max: 6, reasons: ['no breakout+pullback'], entryHint: 0 };
}
