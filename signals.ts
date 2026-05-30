import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XYZ-GOLD/USDC:USDC';
export const DISPLAY_SYMBOL = 'XAU/USDC';
export const TARGET_MOVE    = 5.00;

// ─── MODEL FAILOVER ───────────────────────────────────────────────────────────

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
// CHANGE 1: Removed SKIP session entirely. Asia/off-hours now LOW.
// Gold oscillates 24/7. A $5 move happens even in thin markets.
// We only truly pause during extreme volatility — not based on clock.

function getSession(): { name: string; quality: 'PEAK' | 'HIGH' | 'LOW' } {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK' };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH' };
    if (h >= 16 && h < 19) return { name: 'New York Early',    quality: 'HIGH' };
    if (h >= 19 && h < 21) return { name: 'New York Late',     quality: 'LOW'  };
    return { name: 'Asia/Off-hours', quality: 'LOW' }; // trade but with lower bar
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

    // 1. EMA stack
    if (ind.emaTrend === 'bullish') { bull++; reasons.push('EMA bullish stack'); }
    else if (ind.emaTrend === 'bearish') { bear++; reasons.push('EMA bearish stack'); }
    else reasons.push('EMA neutral');

    // 2. RSI zone
    if (ind.rsi < 40)      { bull++; reasons.push(`RSI ${ind.rsi.toFixed(0)} oversold`); }
    else if (ind.rsi > 60) { bear++; reasons.push(`RSI ${ind.rsi.toFixed(0)} overbought`); }
    else reasons.push(`RSI ${ind.rsi.toFixed(0)} neutral`);

    // 3. Momentum — 30m alone is sufficient (removed requirement for 1h agreement)
    // CHANGE 2: 1h agreement was killing too many signals. 30m momentum is enough
    // for a $5 target. 1h adds a bonus point only.
    const mom30Pos = ind.momentum30m > 0.03;   // lowered from 0.05
    const mom30Neg = ind.momentum30m < -0.03;
    const mom1hPos = ind.momentum1h  > 0.08;   // lowered from 0.10
    const mom1hNeg = ind.momentum1h  < -0.08;

    if (mom30Pos) { bull++; reasons.push(`30m mom +${ind.momentum30m.toFixed(3)}%`); }
    if (mom30Neg) { bear++; reasons.push(`30m mom ${ind.momentum30m.toFixed(3)}%`); }
    if (mom1hPos) { bull++; reasons.push(`1h mom +${ind.momentum1h.toFixed(3)}%`); }
    if (mom1hNeg) { bear++; reasons.push(`1h mom ${ind.momentum1h.toFixed(3)}%`); }

    // 4. 4h bias
    if (ind.trendBias4h === 'bull') { bull++; reasons.push('4h bull'); }
    else if (ind.trendBias4h === 'bear') { bear++; reasons.push('4h bear'); }

    // 5. ADX
    if (ind.adx > 20) {  // CHANGE 3: lowered from 25
        if (bull > bear) { bull++; reasons.push(`ADX ${ind.adx.toFixed(0)} trending`); }
        else if (bear > bull) { bear++; reasons.push(`ADX ${ind.adx.toFixed(0)} trending`); }
    } else {
        reasons.push(`ADX ${ind.adx.toFixed(0)} weak`);
    }

    // CHANGE 4: Choppy definition narrowed significantly
    // Only truly choppy when BOTH 30m AND 1h actively conflict (opposite signs)
    // Ranging alone is NOT choppy anymore — we trade ranges for $5 moves
    const activeConflict = (mom30Pos && mom1hNeg) || (mom30Neg && mom1hPos);
    const isChoppy = activeConflict; // removed: ranging+weak ADX was blocking too many trades

    // RSI hard blocks — only extreme levels
    const blockLong  = ind.rsi >= 80; // CHANGE 5: raised from 75
    const blockShort = ind.rsi <= 20; // CHANGE 6: lowered from 25

    const score = Math.max(bull, bear);
    const direction = bull > bear ? 'LONG' : bear > bull ? 'SHORT' : 'NEUTRAL';

    return { direction, score, isChoppy, blockLong, blockShort, reasons };
}

// ─── EXTREME VOLATILITY GUARD ─────────────────────────────────────────────────

function isExtremeVolatility(ind: TechnicalIndicators): boolean {
    return ind.atr5m > 8.0 && ind.volumeRatio > 3.0;
}

// ─── LOCAL FALLBACK ───────────────────────────────────────────────────────────

function computeLocalDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
    score: number;
} {
    const bias = computeBias(ind, price);

    // CHANGE 7: If bias is NEUTRAL, use 5m momentum as tiebreaker
    // instead of returning neutral. Gold always has a micro-direction.
    let dir: SignalDirection;
    if (bias.direction === 'LONG') {
        dir = 'long';
    } else if (bias.direction === 'SHORT') {
        dir = 'short';
    } else {
        // tiebreak on 5m momentum
        dir = ind.momentum5m >= 0 ? 'long' : 'short';
    }

    return {
        direction: dir,
        reasoning: `LOCAL ${dir.toUpperCase()}: ${bias.reasons.slice(0, 3).join(', ')}`,
        score: bias.score,
    };
}

// ─── JSON EXTRACTOR ───────────────────────────────────────────────────────────

function extractJSON(raw: string): Array<Record<string, unknown>> | null {
    const text = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    const objMatch   = text.match(/\{[\s\S]*\}/);
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
            console.warn(`[Signal] ${tier.model} failed${isQuota ? ' (quota)' : ''} — trying next`);
        }
    }
    return null;
}

// ─── MAIN SIGNAL ENGINE ───────────────────────────────────────────────────────

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];
    const session = getSession();

    console.log(`[Signal] Session: ${session.name} [${session.quality}]`);

    // No more SKIP — removed entirely

    for (const asset of assets) {
        const { indicators: ind, price, symbol } = asset;

        // ── ONLY HARD STOP: extreme volatility ────────────────────────────
        if (isExtremeVolatility(ind)) {
            console.log(`[Signal] 🔴 EXTREME VOLATILITY ATR=$${ind.atr5m.toFixed(2)} vol=${ind.volumeRatio.toFixed(1)}x — pausing.`);
            continue;
        }

        const bias  = computeBias(ind, price);
        const local = computeLocalDirection(ind, price);

        console.log(`[Signal] Bias: ${bias.direction} ${bias.score}/5 choppy=${bias.isChoppy} | ${bias.reasons.slice(0,3).join(', ')}`);

        // ── CHANGE 8: Only skip if actively choppy (momentum conflict) ────
        if (bias.isChoppy) {
            console.log(`[Signal] 🚫 CHOPPY — 30m/1h momentum actively conflict. Skipping.`);
            continue;
        }

        // ── CHANGE 9: Removed weak-bias skip entirely ─────────────────────
        // Previous code skipped bias < 2 always, and < 3 in LOW sessions.
        // A $5 move does NOT need a strong bias — it just needs a direction.
        // Local engine always provides one. Let Gemini confirm or use local.

        // RSI hard blocks (now only at extremes 80/20)
        if (bias.blockLong  && local.direction === 'long')  {
            console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} extreme overbought — blocking long.`);
            continue;
        }
        if (bias.blockShort && local.direction === 'short') {
            console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} extreme oversold — blocking short.`);
            continue;
        }

        // ── BUILD GEMINI PROMPT ───────────────────────────────────────────
        const prompt = `You are an XAU/USDC (Gold) perp scalper on Hyperliquid. 25x leverage.
TP=$5.00 fixed. No stop loss for now. Session: ${session.name} [${session.quality}].
Target: 50-100 trades/day including Asia/off-hours. Gold oscillates 24/7.

LIVE XAU/USDC DATA:
Price: $${price.toFixed(2)}
EMA: ${ind.emaTrend} | RSI: ${ind.rsi.toFixed(1)} | ADX: ${ind.adx.toFixed(1)}
Mom 5m: ${ind.momentum5m.toFixed(4)}% | 30m: ${ind.momentum30m.toFixed(4)}% | 1h: ${ind.momentum1h.toFixed(4)}%
ATR(5m): $${ind.atr5m.toFixed(2)} | Structure: ${ind.priceStructure} | 4h: ${ind.trendBias4h} | Weekly: ${ind.weeklyBias}
Vol ratio: ${ind.volumeRatio.toFixed(2)}x | Spread: $${ind.spreadUsd.toFixed(2)}
Support: $${ind.nearestSupport.toFixed(2)} (${ind.distanceToSupport.toFixed(1)} away)
Resistance: $${ind.nearestResistance.toFixed(2)} (${ind.distanceToResistance.toFixed(1)} away)
Local bias engine: ${bias.direction} score=${bias.score}/5 | ${bias.reasons.join(', ')}

RULES:
- Gold moves $5 constantly. Even in slow markets this happens every 5-15 minutes.
- RANGING market = GOOD for us. Buy near support, sell near resistance.
- If price is within $3 of support → LONG. Within $3 of resistance → SHORT.
- Mid-range → follow 30m momentum direction.
- Only return NEUTRAL if 30m AND 1h momentum actively point opposite directions.
- Do NOT skip because session is slow. We trade 24/7.
- Confirm local bias direction unless you have strong counter evidence.

Reply JSON array ONLY. No markdown. No text outside array.
[{"symbol":"XAU/USDC","direction":"long","market_price":${price.toFixed(2)},"target_move":5.00,"confidence":0.70,"reasoning":"one sentence max 120 chars"}]`;

        // ── CALL GEMINI ───────────────────────────────────────────────────
        const geminiResult = await callGemini(prompt);

        if (!geminiResult) {
            // CHANGE 10: Local fallback always fires, no score gate
            console.log(`[Signal] ⚙️ Gemini unavailable — local fallback: ${local.direction.toUpperCase()}`);
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: TARGET_MOVE, confidence: 0.55, reasoning: local.reasoning,
            });
            continue;
        }

        // ── PARSE ─────────────────────────────────────────────────────────
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

            // CHANGE 11: Gemini neutral → use local direction instead of skipping
            if (dir === 'neutral' || !['long', 'short'].includes(dir)) {
                console.log(`[Signal] (${geminiResult.model}) Neutral — using local: ${local.direction.toUpperCase()}`);
                dir = local.direction;
            }

            // RSI hard blocks
            if (dir === 'long'  && bias.blockLong)  { console.log(`[Signal] RSI block long.`);  continue; }
            if (dir === 'short' && bias.blockShort) { console.log(`[Signal] RSI block short.`); continue; }

            const confidence = Math.min(1, Math.max(0, Number(item.confidence ?? 0.60)));

            // CHANGE 12: Lowered confidence gate from 0.55 to 0.45
            // A $5 move in a ranging market doesn't need high conviction
            if (confidence < 0.45) {
                console.log(`[Signal] (${geminiResult.model}) conf=${confidence.toFixed(2)} < 0.45 — using local instead.`);
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