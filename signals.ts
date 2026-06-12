import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XAUUSDT';      // Binance USDM Futures symbol
export const DISPLAY_SYMBOL = 'XAU/USDT';
export const TARGET_MOVE    = 4.00;           // default fallback only

// ─── MODEL FAILOVER ───────────────────────────────────────────────────────────
// MODELS UNCHANGED — exactly as provided. Do not modify.

const MODEL_TIERS: Array<{ key: string; model: string }> = [
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-3.1-flash-lite' },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-3.5-flash'      },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash'      },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash-lite' },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-3-flash'        },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-3.1-flash-lite' },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-3.5-flash'      },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash'      },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash-lite' },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-3-flash'        },
];

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

export function getSession(): {
    name:       string;
    quality:    'PEAK' | 'HIGH' | 'LOW';
    cycleMsMin: number;
    cycleMsMax: number;
    sizePct:    number;
} {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 45_000, cycleMsMax: 75_000,  sizePct: 0.95 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 55_000, cycleMsMax: 90_000,  sizePct: 0.80 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 55_000, cycleMsMax: 90_000,  sizePct: 0.80 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 70_000, cycleMsMax: 120_000, sizePct: 0.50 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 80_000, cycleMsMax: 130_000, sizePct: 0.30 };
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

export function calcAtrRegime(atr5m: number, confidence: number): AtrRegime {
    let regime: AtrRegime;

    if (atr5m > 8) {
        const tp = Math.min(atr5m * 1.2, 12);
        regime   = { label: 'HIGH', leverage: 40, tp, sl: tp, baseSizePct: 0.60, minFeeMultiple: 3 };
    } else if (atr5m >= 4) {
        const tp = Math.min(atr5m * 1.5, 8);
        regime   = { label: 'MED',  leverage: 40, tp, sl: tp, baseSizePct: 0.80, minFeeMultiple: 3 };
    } else {
        const tp = Math.min(atr5m * 2.0, 4);
        regime   = { label: 'LOW',  leverage: 40, tp, sl: tp, baseSizePct: 0.95, minFeeMultiple: 3 };
    }

    regime.tp = Math.max(regime.tp, 1.50);
    regime.sl = regime.tp;

    if (confidence < 0.55 && regime.leverage > 10) {
        regime.leverage = Math.max(10, regime.leverage - 5);
    }

    return regime;
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

    if (ind.momentum30m > 0.025)        { bull++; reasons.push(`30m +${ind.momentum30m.toFixed(3)}%`); }
    else if (ind.momentum30m < -0.025)  { bear++; reasons.push(`30m ${ind.momentum30m.toFixed(3)}%`); }

    if (ind.momentum1h > 0.07)          { bull++; reasons.push(`1h +${ind.momentum1h.toFixed(3)}%`); }
    else if (ind.momentum1h < -0.07)    { bear++; reasons.push(`1h ${ind.momentum1h.toFixed(3)}%`); }

    if (ind.trendBias4h === 'bull')      { bull++; reasons.push('4h bull'); }
    else if (ind.trendBias4h === 'bear') { bear++; reasons.push('4h bear'); }

    if (ind.adx > 18) {
        if (bull > bear)       { bull++; reasons.push(`ADX ${ind.adx.toFixed(0)} bull`); }
        else if (bear > bull)  { bear++; reasons.push(`ADX ${ind.adx.toFixed(0)} bear`); }
    }

    if (ind.obImbalance > 0.15)       { bull++; reasons.push(`OB +${(ind.obImbalance * 100).toFixed(0)}% buy`); }
    else if (ind.obImbalance < -0.15) { bear++; reasons.push(`OB ${(ind.obImbalance * 100).toFixed(0)}% sell`); }

    if (ind.distanceToSupport < 3.0)    { bull++; reasons.push(`Near sup $${ind.nearestSupport.toFixed(1)}`); }
    if (ind.distanceToResistance < 3.0) { bear++; reasons.push(`Near res $${ind.nearestResistance.toFixed(1)}`); }

    // ── Funding rate: negative = shorts paying longs = bull pressure ──────
    if (ind.fundingRate !== null) {
        if (ind.fundingRate < -0.0002) { bull++; reasons.push(`Funding ${(ind.fundingRate * 100).toFixed(4)}% short-bias`); }
        if (ind.fundingRate >  0.0002) { bear++; reasons.push(`Funding ${(ind.fundingRate * 100).toFixed(4)}% long-bias`); }
    }

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
    // Demo environment has wider spreads than live (~$2-3 vs $0.01-0.10).
    // Gate: spread must be less than 50% of TP target to be worth trading.
    // We check this relative to ATR rather than a fixed threshold.
    const maxSpread = ind.atr5m * 0.60;
    const tooWide   = ind.spreadUsd >= maxSpread;
    if (tooWide) console.log(`[Signal] ⚠️ Spread $${ind.spreadUsd.toFixed(2)} ≥ ATR×0.6 ($${maxSpread.toFixed(2)}) — skip.`);
    return tooWide;
}

// ─── LOCAL FALLBACK ───────────────────────────────────────────────────────────

function computeLocalDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
    score:     number;
} {
    const bias = computeBias(ind, price);
    let dir: SignalDirection;

    if (bias.direction === 'LONG')       dir = 'long';
    else if (bias.direction === 'SHORT') dir = 'short';
    else if (Math.abs(ind.obImbalance) > 0.1) dir = ind.obImbalance > 0 ? 'long' : 'short';
    else if (Math.abs(ind.momentum5m) > 0.005) dir = ind.momentum5m >= 0 ? 'long' : 'short';
    else {
        const mid = (ind.high24h + ind.low24h) / 2;
        dir = price < mid ? 'long' : 'short';
    }

    return {
        direction: dir,
        reasoning: `LOCAL ${dir.toUpperCase()}: ${bias.reasons.slice(0, 4).join(', ')} | ADX=${ind.adx.toFixed(0)} OBI=${(ind.obImbalance * 100).toFixed(0)}%`,
        score: bias.score,
    };
}

// ─── JSON EXTRACTOR ───────────────────────────────────────────────────────────

function extractJSON(text: string): any[] | null {
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    const objMatch   = text.match(/\{[\s\S]*?\}/);
    let candidate: string | null = null;
    if (arrayMatch && objMatch) {
        candidate = (arrayMatch.index! <= objMatch.index!) ? arrayMatch[0] : objMatch[0];
    } else {
        candidate = arrayMatch?.[0] ?? objMatch?.[0] ?? null;
    }
    if (!candidate) return null;
    try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
        try {
            const fixed  = candidate.replace(/,\s*([}\]])/g, '$1');
            const parsed = JSON.parse(fixed);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object') return [parsed];
        } catch { /* give up */ }
    }
    return null;
}

// ─── GEMINI CALL ──────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<{ raw: string; model: string } | null> {
    for (const tier of MODEL_TIERS) {
        if (!tier.key) continue;
        try {
            const client = new GoogleGenerativeAI(tier.key);
            const model  = client.getGenerativeModel({ model: tier.model });
            const result = await model.generateContent(prompt);
            return { raw: result.response.text(), model: tier.model };
        } catch (err: any) {
            const isQuota = /429|quota|rate.?limit|exhausted|too.?many/i.test(String(err));
            console.warn(`[Signal] ${tier.model} failed${isQuota ? ' (quota)' : ''} — next tier`);
        }
    }
    return null;
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
            console.log(`[Signal] ⚠️ SPREAD $${ind.spreadUsd.toFixed(2)} ≥ $0.50 — skip.`);
            continue;
        }

        const bias   = computeBias(ind, price);
        const local  = computeLocalDirection(ind, price);

        const provisionalRegime = calcAtrRegime(ind.atr5m, 0.65);
        const safetyLev         = safeLeverage(provisionalRegime.leverage, price, ind.atr5m);

        console.log(`[Signal] ATR=$${ind.atr5m.toFixed(2)} Regime:${provisionalRegime.label} lev=${safetyLev}x TP=$${provisionalRegime.tp.toFixed(2)}`);
        console.log(`[Signal] Bias: ${bias.direction} ${bias.score}/9 choppy=${bias.isChoppy} | ${bias.reasons.slice(0, 5).join(', ')}`);

        if (bias.isChoppy) {
            console.log(`[Signal] 🚫 CHOPPY — local tiebreak: ${local.direction.toUpperCase()}`);
            const regime = calcAtrRegime(ind.atr5m, 0.50);
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: regime.tp, confidence: 0.50,
                reasoning:   `CHOPPY LOCAL ${local.direction.toUpperCase()}: ${ind.momentum30m.toFixed(3)}% 30m vs ${ind.momentum1h.toFixed(3)}% 1h`,
                suggested_tp:       regime.tp,
                suggested_leverage: safeLeverage(regime.leverage, price, ind.atr5m),
                session_size_pct:   session.sizePct * regime.baseSizePct,
            });
            continue;
        }

        if (bias.blockLong  && local.direction === 'long')  { console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} block long.`);  continue; }
        if (bias.blockShort && local.direction === 'short') { console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} block short.`); continue; }

        const rangePos = ind.high24h > ind.low24h
            ? ((price - ind.low24h) / (ind.high24h - ind.low24h) * 100).toFixed(0)
            : '50';

        const fundingNote = ind.fundingRate !== null
            ? `Funding: ${(ind.fundingRate * 100).toFixed(4)}% (${ind.fundingRate < 0 ? 'shorts pay longs → bull' : ind.fundingRate > 0 ? 'longs pay shorts → bear' : 'neutral'})`
            : 'Funding: N/A';

        // ── Gemini prompt — rich context, strict JSON output ──────────────
        const prompt = `You are the best gold futures scalper in the world. You are trading XAUUSDT perpetual on Binance USDM Futures.
Session: ${session.name} [${session.quality}]. Date: ${new Date().toISOString()}

LIVE MARKET DATA:
Price: $${price.toFixed(2)} | 24h range: $${ind.low24h.toFixed(2)}–$${ind.high24h.toFixed(2)} (position in range: ${rangePos}%)
EMA stack: ${ind.emaTrend} (EMA8=$${ind.ema8.toFixed(2)} EMA21=$${ind.ema21.toFixed(2)} EMA50=$${ind.ema50.toFixed(2)})
RSI(14): ${ind.rsi.toFixed(1)} | ADX(14): ${ind.adx.toFixed(1)} | Structure: ${ind.priceStructure}
Momentum: 5m=${ind.momentum5m.toFixed(4)}% | 30m=${ind.momentum30m.toFixed(4)}% | 1h=${ind.momentum1h.toFixed(4)}%
ATR(5m): $${ind.atr5m.toFixed(3)} | ATR%: ${ind.atrPct.toFixed(4)}% | Volume ratio: ${ind.volumeRatio.toFixed(2)}x
Spread: $${ind.spreadUsd.toFixed(3)} | 4h bias: ${ind.trendBias4h} | Weekly bias: ${ind.weeklyBias}
Order book imbalance: ${(ind.obImbalance * 100).toFixed(1)}% (>0=buy pressure, <0=sell pressure)
Price vs VWAP: ${ind.priceVsVwap.toFixed(3)}%
Support: $${ind.nearestSupport.toFixed(2)} (${ind.distanceToSupport.toFixed(2)} away) | Resistance: $${ind.nearestResistance.toFixed(2)} (${ind.distanceToResistance.toFixed(2)} away)
Swing high: $${ind.recentSwingHigh.toFixed(2)} | Swing low: $${ind.recentSwingLow.toFixed(2)}
${fundingNote}
Pre-computed bias: ${bias.direction} score=${bias.score}/9 | Signals: ${bias.reasons.join(', ')}

BINANCE FEE STRUCTURE (XAUUSDT Perp):
  Taker (market): 0.0500% — used for entry and SL
  Maker (GTC limit): 0.0200% — used for TP

ATR REGIME RULES — MUST FOLLOW EXACTLY:
  ATR > $8.00  (HIGH vol): leverage=40x, TP=min(ATR×1.2, $12.00), size=60% of balance
  ATR $4–$8    (MED vol):  leverage=40x, TP=min(ATR×1.5, $8.00),  size=80% of balance
  ATR < $4.00  (LOW vol):  leverage=40x, TP=min(ATR×2.0, $4.00),  size=95% of balance
Current ATR=$${ind.atr5m.toFixed(3)} → base regime: ${provisionalRegime.label} | base lev=${safetyLev}x | base TP=$${provisionalRegime.tp.toFixed(2)}

TRADING RULES:
1. TP floor: $1.50 minimum. TP ceiling: min(ATR×2, $15). Never exceed ceiling.
2. SL always equals TP — strict 1:1 Risk:Reward (SL is monitored externally).
3. Liquidation buffer: entry_price / leverage must be > ATR×2. Reduce leverage if not.
4. Fee gate: (size × TP) must be > (taker_fee + maker_fee) × 3. Skip if not.
5. confidence < 0.55 → drop leverage by 5 (25→20, 20→15, 15→10, 10→10).
6. Near support (<$3.00 away) = favour LONG. Near resistance (<$3.00 away) = favour SHORT.
7. ADX < 15 = ranging market — scalp both directions. ADX > 30 = trending — follow trend only.
8. RSI > 82 = block long. RSI < 18 = block short.
9. ONLY output neutral if: 30m AND 1h momentum conflict AND RSI is 48–52.
10. Funding rate: negative = shorts paying longs = bullish pressure. Positive = bearish.
11. Weekend/off-hours: tighter TP, lower leverage, smaller size.

QUALITY STANDARDS:
- Only signal when at least 5 of 9 bias factors agree.
- If bias score < 5, reduce confidence below 0.55 to trigger leverage reduction.
- Prefer entries near support/resistance for better R:R.
- Confirm with 30m and 1h momentum alignment for higher confidence.

Reply with a JSON array ONLY. No markdown, no explanation, no text outside the array:
[{"symbol":"XAU/USDT","direction":"long","market_price":${price.toFixed(2)},"target_move":${provisionalRegime.tp.toFixed(2)},"confidence":0.72,"reasoning":"max 120 chars","suggested_tp":${provisionalRegime.tp.toFixed(2)},"suggested_leverage":${safetyLev},"session_size_pct":${(session.sizePct * provisionalRegime.baseSizePct).toFixed(2)}}]`;

        const geminiResult = await callGemini(prompt);

        const buildFallback = (conf: number, dir: SignalDirection): GeneratedSignal => {
            const regime = calcAtrRegime(ind.atr5m, conf);
            const lev    = safeLeverage(regime.leverage, price, ind.atr5m);
            return {
                symbol, direction: dir, market_price: price,
                target_move:        regime.tp,
                confidence:         conf,
                reasoning:          local.reasoning,
                suggested_tp:       regime.tp,
                suggested_leverage: lev,
                session_size_pct:   session.sizePct * regime.baseSizePct,
            };
        };

        if (!geminiResult) {
            console.log(`[Signal] ⚙️ Gemini unavailable — local fallback: ${local.direction.toUpperCase()}`);
            signals.push(buildFallback(0.55, local.direction));
            continue;
        }

        const parsed = extractJSON(geminiResult.raw);

        if (!parsed || parsed.length === 0) {
            console.warn(`[Signal] Bad JSON from ${geminiResult.model} — local fallback.`);
            signals.push(buildFallback(0.55, local.direction));
            continue;
        }

        for (const item of parsed) {
            let dir = String(item.direction ?? '').toLowerCase().trim();
            if (dir === 'buy')  dir = 'long';
            if (dir === 'sell') dir = 'short';

            if (dir === 'neutral' || !['long', 'short'].includes(dir)) {
                console.log(`[Signal] (${geminiResult.model}) Neutral → local: ${local.direction.toUpperCase()}`);
                dir = local.direction;
            }

            if (dir === 'long'  && bias.blockLong)  { console.log(`[Signal] RSI block long.`);  continue; }
            if (dir === 'short' && bias.blockShort) { console.log(`[Signal] RSI block short.`); continue; }

            const confidence = Math.min(1, Math.max(0, Number(item.confidence ?? 0.60)));

            if (confidence < 0.45) {
                console.log(`[Signal] conf=${confidence.toFixed(2)} too low → local fallback`);
                signals.push(buildFallback(0.55, local.direction as SignalDirection));
                continue;
            }

            const regime     = calcAtrRegime(ind.atr5m, confidence);
            const rawTp      = Number(item.suggested_tp ?? regime.tp);
            const rawLev     = Number(item.suggested_leverage ?? regime.leverage);
            const rawSizePct = Number(item.session_size_pct ?? session.sizePct * regime.baseSizePct);

            const tpCeiling      = Math.min(ind.atr5m * 2, 15);
            const suggested_tp   = Math.max(1.50, Math.min(rawTp, tpCeiling));
            const clampedLev     = Math.max(1, Math.min(40, Math.round(rawLev)));
            const suggested_leverage = safeLeverage(clampedLev, price, ind.atr5m);
            const session_size_pct   = Math.max(0.20, Math.min(0.95, rawSizePct));

            const reasoning = String(item.reasoning ?? local.reasoning).slice(0, 200);
            const mp        = Number(item.market_price ?? price);

            console.log(`[Signal] ✅ (${geminiResult.model}) ${dir.toUpperCase()} conf=${confidence.toFixed(2)} TP=$${suggested_tp.toFixed(2)} lev=${suggested_leverage}x size=${(session_size_pct * 100).toFixed(0)}%`);
            console.log(`[Signal]    ${reasoning}`);

            signals.push({
                symbol,
                direction:          dir as SignalDirection,
                market_price:       mp,
                target_move:        suggested_tp,
                confidence,
                reasoning,
                suggested_tp,
                suggested_leverage,
                session_size_pct,
            });
        }
    }

    return signals;
}
