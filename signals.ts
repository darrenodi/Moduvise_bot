import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XYZ-GOLD/USDC:USDC';
export const DISPLAY_SYMBOL = 'XAU/USDC';
export const TARGET_MOVE    = 2.00;

// ─── MODEL FAILOVER ───────────────────────────────────────────────────────────
// Tier order: cheapest fast models first, escalate on quota hit.
// gemini-2.0-flash is current stable free tier as of June 2026.

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
    // ── NEW: micro-structure signals ───────────────────────────────────────
    obImbalance:          number;   // (bidVol - askVol) / totalVol — positive = buy pressure
    priceVsVwap:          number;   // positive = price above VWAP (bullish micro)
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
    symbol:       string;
    direction:    SignalDirection;
    market_price: number;
    target_move:  number;
    confidence:   number;
    reasoning:    string;
}

// ─── SESSION ──────────────────────────────────────────────────────────────────
// No dead hours — Gold trades 23/5 (closed Sat ~21 UTC to Sun ~21 UTC).
// Session quality drives cycle speed in main.ts, not signal gating.

export function getSession(): {
    name: string;
    quality: 'PEAK' | 'HIGH' | 'LOW';
    cycleMsMin: number;
    cycleMsMax: number;
} {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 45_000, cycleMsMax: 75_000  };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 55_000, cycleMsMax: 90_000  };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 55_000, cycleMsMax: 90_000  };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 70_000, cycleMsMax: 120_000 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 80_000, cycleMsMax: 130_000 };
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

    // 1. EMA stack (1h)
    if (ind.emaTrend === 'bullish') { bull++;  reasons.push('EMA8>21>50 bull'); }
    else if (ind.emaTrend === 'bearish') { bear++; reasons.push('EMA8<21<50 bear'); }
    else reasons.push('EMA neutral');

    // 2. RSI zone — only extremes matter for a $2 scalp
    if (ind.rsi < 42)       { bull++; reasons.push(`RSI ${ind.rsi.toFixed(0)} low`); }
    else if (ind.rsi > 58)  { bear++; reasons.push(`RSI ${ind.rsi.toFixed(0)} high`); }
    else reasons.push(`RSI ${ind.rsi.toFixed(0)} mid`);

    // 3. 30m momentum — primary short-term signal
    if (ind.momentum30m > 0.025)        { bull++; reasons.push(`30m +${ind.momentum30m.toFixed(3)}%`); }
    else if (ind.momentum30m < -0.025)  { bear++; reasons.push(`30m ${ind.momentum30m.toFixed(3)}%`); }

    // 4. 1h momentum — bonus confirmation
    if (ind.momentum1h > 0.07)          { bull++; reasons.push(`1h +${ind.momentum1h.toFixed(3)}%`); }
    else if (ind.momentum1h < -0.07)    { bear++; reasons.push(`1h ${ind.momentum1h.toFixed(3)}%`); }

    // 5. 4h trend
    if (ind.trendBias4h === 'bull')     { bull++; reasons.push('4h bull'); }
    else if (ind.trendBias4h === 'bear'){ bear++; reasons.push('4h bear'); }

    // 6. ADX trend confirmation
    if (ind.adx > 18) {
        if (bull > bear)        { bull++; reasons.push(`ADX ${ind.adx.toFixed(0)} bull`); }
        else if (bear > bull)   { bear++; reasons.push(`ADX ${ind.adx.toFixed(0)} bear`); }
    }

    // 7. Order book imbalance (new micro signal)
    if (ind.obImbalance > 0.15)         { bull++; reasons.push(`OB +${(ind.obImbalance*100).toFixed(0)}% buy pressure`); }
    else if (ind.obImbalance < -0.15)   { bear++; reasons.push(`OB ${(ind.obImbalance*100).toFixed(0)}% sell pressure`); }

    // 8. Price vs support/resistance (key for range scalping)
    if (ind.distanceToSupport < 3.0)    { bull++; reasons.push(`Near support $${ind.nearestSupport.toFixed(1)}`); }
    if (ind.distanceToResistance < 3.0) { bear++; reasons.push(`Near resistance $${ind.nearestResistance.toFixed(1)}`); }

    // Choppy = 30m and 1h actively pointing opposite directions
    const activeConflict =
        (ind.momentum30m > 0.025 && ind.momentum1h < -0.07) ||
        (ind.momentum30m < -0.025 && ind.momentum1h > 0.07);
    const isChoppy = activeConflict;

    // Hard RSI blocks — only extreme levels
    const blockLong  = ind.rsi >= 82;
    const blockShort = ind.rsi <= 18;

    const score     = Math.max(bull, bear);
    const direction = bull > bear ? 'LONG' : bear > bull ? 'SHORT' : 'NEUTRAL';

    return { direction, score, isChoppy, blockLong, blockShort, reasons };
}

// ─── EXTREME VOLATILITY GUARD ─────────────────────────────────────────────────
// Only pause when ATR is massive AND volume spiking — true news event.
// Normal volatility is fine; a $2 move still happens in it.

function isExtremeVolatility(ind: TechnicalIndicators): boolean {
    return ind.atr5m > 10.0 && ind.volumeRatio > 3.5;
}

// ─── SPREAD GUARD ─────────────────────────────────────────────────────────────
// A wide spread kills maker fill probability and eats into the $2 TP.
// Skip if spread >= $0.60 (30% of our $2 target).

function isSpreadTooWide(ind: TechnicalIndicators): boolean {
    return ind.spreadUsd >= 0.60;
}

// ─── LOCAL FALLBACK ───────────────────────────────────────────────────────────
// Always produces a direction — 5m momentum tiebreaker.
// "Gold always has a micro-direction." — World's best scalper

function computeLocalDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
    score: number;
} {
    const bias = computeBias(ind, price);

    let dir: SignalDirection;
    if (bias.direction === 'LONG') {
        dir = 'long';
    } else if (bias.direction === 'SHORT') {
        dir = 'short';
    } else {
        // Tiebreak: 5m momentum > OB imbalance > price vs range midpoint
        if (Math.abs(ind.obImbalance) > 0.1) {
            dir = ind.obImbalance > 0 ? 'long' : 'short';
        } else if (Math.abs(ind.momentum5m) > 0.005) {
            dir = ind.momentum5m >= 0 ? 'long' : 'short';
        } else {
            // Range tiebreak: below midpoint = long, above = short
            const mid = (ind.high24h + ind.low24h) / 2;
            dir = price < mid ? 'long' : 'short';
        }
    }

    return {
        direction: dir,
        reasoning: `LOCAL ${dir.toUpperCase()}: ${bias.reasons.slice(0, 4).join(', ')} | ADX=${ind.adx.toFixed(0)} OBI=${(ind.obImbalance*100).toFixed(0)}%`,
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
            const fixed = candidate.replace(/,\s*([}\]])/g, '$1');
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

    console.log(`[Signal] Session: ${session.name} [${session.quality}]`);

    for (const asset of assets) {
        const { indicators: ind, price, symbol } = asset;

        // ── Hard stops ────────────────────────────────────────────────────
        if (isExtremeVolatility(ind)) {
            console.log(`[Signal] 🔴 EXTREME VOLATILITY ATR=$${ind.atr5m.toFixed(2)} vol=${ind.volumeRatio.toFixed(1)}x — pausing.`);
            continue;
        }
        if (isSpreadTooWide(ind)) {
            console.log(`[Signal] ⚠️ SPREAD $${ind.spreadUsd.toFixed(2)} ≥ $0.60 — maker fill unlikely, skip.`);
            continue;
        }

        const bias  = computeBias(ind, price);
        const local = computeLocalDirection(ind, price);

        console.log(`[Signal] Bias: ${bias.direction} ${bias.score}/8 choppy=${bias.isChoppy} | ${bias.reasons.slice(0,4).join(', ')}`);

        if (bias.isChoppy) {
            console.log(`[Signal] 🚫 CHOPPY — 30m/1h conflict. Local tiebreak: ${local.direction.toUpperCase()}`);
            // Don't skip — use local direction but lower confidence
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: TARGET_MOVE, confidence: 0.50,
                reasoning: `CHOPPY LOCAL ${local.direction.toUpperCase()}: ${ind.momentum30m.toFixed(3)}% 30m vs ${ind.momentum1h.toFixed(3)}% 1h — micro bias wins`,
            });
            continue;
        }

        if (bias.blockLong  && local.direction === 'long')  { console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} extreme OB — block long.`);  continue; }
        if (bias.blockShort && local.direction === 'short') { console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} extreme OS — block short.`); continue; }

        // ── Gemini prompt — world-class scalper brief ─────────────────────
        const rangePos = ind.high24h > ind.low24h
            ? ((price - ind.low24h) / (ind.high24h - ind.low24h) * 100).toFixed(0)
            : '50';

        const prompt = `You are the best gold scalper in the world. 25x leverage on Hyperliquid GOLD/USDC perp.
TP = $2.00 fixed move. Maker PostOnly entry at bid (long) or ask (short).
Target: 100+ fills/day. Session: ${session.name} [${session.quality}].

LIVE DATA — ${new Date().toISOString()}:
Price: $${price.toFixed(2)} | Range position: ${rangePos}% of 24h range [$${ind.low24h.toFixed(2)}–$${ind.high24h.toFixed(2)}]
EMA: ${ind.emaTrend} (8=$${ind.ema8.toFixed(2)} 21=$${ind.ema21.toFixed(2)} 50=$${ind.ema50.toFixed(2)})
RSI: ${ind.rsi.toFixed(1)} | ADX: ${ind.adx.toFixed(1)} | Structure: ${ind.priceStructure}
Momentum: 5m ${ind.momentum5m.toFixed(4)}% | 30m ${ind.momentum30m.toFixed(4)}% | 1h ${ind.momentum1h.toFixed(4)}%
ATR(5m): $${ind.atr5m.toFixed(2)} | Vol ratio: ${ind.volumeRatio.toFixed(2)}x | Spread: $${ind.spreadUsd.toFixed(3)}
4h bias: ${ind.trendBias4h} | Weekly: ${ind.weeklyBias}
OB imbalance: ${(ind.obImbalance*100).toFixed(1)}% (positive=buy pressure) | Price vs VWAP: ${ind.priceVsVwap.toFixed(3)}%
Support: $${ind.nearestSupport.toFixed(2)} (${ind.distanceToSupport.toFixed(2)} away) | Resistance: $${ind.nearestResistance.toFixed(2)} (${ind.distanceToResistance.toFixed(2)} away)
Swing high: $${ind.recentSwingHigh.toFixed(2)} | Swing low: $${ind.recentSwingLow.toFixed(2)}
Local bias engine: ${bias.direction} score=${bias.score}/8 | ${bias.reasons.join(', ')}

WORLD-CLASS SCALPING RULES FOR $2 TARGET:
1. Range trading: near support (< $3) = LONG. Near resistance (< $3) = SHORT.
2. Mid-range: follow 30m momentum direction. 1h confirms.
3. OB imbalance > 15% in a direction = strong confirmation.
4. ADX < 15 = ranging = perfect. ADX > 30 = trending = follow trend.
5. Funding rate positive = shorts pay longs = slight long edge.
6. A $2 move happens every 3–10 minutes even in Asia. NEVER be neutral without strong reason.
7. Only NEUTRAL if 30m AND 1h momentum actively point opposite directions AND RSI is 48-52.

Reply JSON array ONLY — no markdown, no text outside array:
[{"symbol":"XAU/USDC","direction":"long","market_price":${price.toFixed(2)},"target_move":2.00,"confidence":0.72,"reasoning":"≤120 chars"}]`;

        const geminiResult = await callGemini(prompt);

        if (!geminiResult) {
            console.log(`[Signal] ⚙️ Gemini unavailable — local fallback: ${local.direction.toUpperCase()}`);
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: TARGET_MOVE, confidence: 0.55, reasoning: local.reasoning,
            });
            continue;
        }

        const parsed = extractJSON(geminiResult.raw);

        if (!parsed || parsed.length === 0) {
            console.warn(`[Signal] Bad JSON from ${geminiResult.model} — local fallback.`);
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: TARGET_MOVE, confidence: 0.55, reasoning: local.reasoning,
            });
            continue;
        }

        for (const item of parsed) {
            let dir = String(item.direction ?? '').toLowerCase().trim();
            if (dir === 'buy')  dir = 'long';
            if (dir === 'sell') dir = 'short';

            // Gemini neutral → local tiebreak (never waste a cycle)
            if (dir === 'neutral' || !['long', 'short'].includes(dir)) {
                console.log(`[Signal] (${geminiResult.model}) Neutral → local: ${local.direction.toUpperCase()}`);
                dir = local.direction;
            }

            if (dir === 'long'  && bias.blockLong)  { console.log(`[Signal] RSI block long.`);  continue; }
            if (dir === 'short' && bias.blockShort) { console.log(`[Signal] RSI block short.`); continue; }

            const confidence = Math.min(1, Math.max(0, Number(item.confidence ?? 0.60)));

            // Low confidence → use local but don't skip
            if (confidence < 0.45) {
                console.log(`[Signal] (${geminiResult.model}) conf=${confidence.toFixed(2)} low → local: ${local.direction.toUpperCase()}`);
                signals.push({
                    symbol, direction: local.direction as SignalDirection,
                    market_price: price, target_move: TARGET_MOVE,
                    confidence: 0.55, reasoning: local.reasoning,
                });
                continue;
            }

            const reasoning = String(item.reasoning ?? local.reasoning).slice(0, 200);
            const mp        = Number(item.market_price ?? price);

            console.log(`[Signal] ✅ (${geminiResult.model}) ${dir.toUpperCase()} conf=${confidence.toFixed(2)} | ${reasoning}`);

            signals.push({
                symbol,
                direction: dir as SignalDirection,
                market_price: mp,
                target_move: TARGET_MOVE,
                confidence,
                reasoning,
            });
        }
    }

    return signals;
}
