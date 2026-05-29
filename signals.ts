import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XYZ-GOLD/USDC:USDC';
export const DISPLAY_SYMBOL = 'XAU/USDC';
export const TARGET_MOVE    = 6.00;   // $6.00 TP — covers taker fees + net profit

// ─── MODEL FAILOVER ───────────────────────────────────────────────────────────

const MODEL_TIERS: Array<{ key: string; model: string }> = [
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash'      },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash-lite' },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.0-flash'      },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash'      },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash-lite' },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.0-flash'      },
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

// ─── SESSION QUALITY ─────────────────────────────────────────────────────────
// $6 TP needs real momentum. Only trade in sessions where Gold moves reliably.

function getSession(): { name: string; quality: 'PEAK' | 'HIGH' | 'LOW' | 'SKIP' } {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK' };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH' };
    if (h >= 16 && h < 19) return { name: 'New York Early',    quality: 'HIGH' };
    if (h === 8)            return { name: 'London Open',       quality: 'LOW'  }; // stop-hunt hour
    if (h >= 19 && h < 21) return { name: 'New York Late',     quality: 'LOW'  };
    return { name: 'Asia/Off-hours', quality: 'SKIP' }; // thin liquidity — $6 rarely completes
}

// ─── BIAS SCORING (ported from ModuVise) ─────────────────────────────────────

function computeBias(ind: TechnicalIndicators, price: number): {
    direction:  'LONG' | 'SHORT' | 'NEUTRAL';
    score:      number;   // 0–5
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

    // 3. Momentum — both 30m AND 1h must agree for a point (critical for $6 move)
    const mom30Pos = ind.momentum30m > 0.05;
    const mom30Neg = ind.momentum30m < -0.05;
    const mom1hPos = ind.momentum1h  > 0.10;
    const mom1hNeg = ind.momentum1h  < -0.10;

    if (mom30Pos && mom1hPos) { bull++; reasons.push(`Mom aligned bull: 30m+${ind.momentum30m.toFixed(3)}% 1h+${ind.momentum1h.toFixed(3)}%`); }
    else if (mom30Neg && mom1hNeg) { bear++; reasons.push(`Mom aligned bear: 30m${ind.momentum30m.toFixed(3)}% 1h${ind.momentum1h.toFixed(3)}%`); }
    else reasons.push(`Mom mixed: 30m${ind.momentum30m.toFixed(3)}% 1h${ind.momentum1h.toFixed(3)}%`);

    // 4. 4h bias
    if (ind.trendBias4h === 'bull') { bull++; reasons.push('4h bull'); }
    else if (ind.trendBias4h === 'bear') { bear++; reasons.push('4h bear'); }

    // 5. ADX trend strength — $6 needs a trending market
    if (ind.adx > 25) { 
        if (bull > bear) { bull++; reasons.push(`ADX ${ind.adx.toFixed(0)} trending`); }
        else if (bear > bull) { bear++; reasons.push(`ADX ${ind.adx.toFixed(0)} trending`); }
    } else {
        reasons.push(`ADX ${ind.adx.toFixed(0)} weak trend`);
    }

    // Choppy: momentum timeframes conflict OR ranging AND weak ADX
    const momentumConflict = (mom30Pos && mom1hNeg) || (mom30Neg && mom1hPos);
    const isChoppy = momentumConflict || (ind.priceStructure === 'ranging' && ind.adx < 20);

    // Hard RSI blocks
    const blockLong  = ind.rsi >= 75;
    const blockShort = ind.rsi <= 25;

    const score = Math.max(bull, bear);
    const direction = bull > bear ? 'LONG' : bear > bull ? 'SHORT' : 'NEUTRAL';

    return { direction, score, isChoppy, blockLong, blockShort, reasons };
}

// ─── EXTREME VOLATILITY GUARD ─────────────────────────────────────────────────

function isExtremeVolatility(ind: TechnicalIndicators): boolean {
    return ind.atr5m > 8.0 && ind.volumeRatio > 3.0;
}

// ─── LOCAL FALLBACK ENGINE ────────────────────────────────────────────────────

function computeLocalDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
    score: number;
} {
    const bias = computeBias(ind, price);
    const dir: SignalDirection = bias.direction === 'LONG' ? 'long'
                               : bias.direction === 'SHORT' ? 'short'
                               : 'neutral';
    return {
        direction: dir,
        reasoning: `LOCAL ${bias.direction}: ${bias.reasons.slice(0, 3).join(', ')}`,
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

    // ── SKIP off-hours entirely — $6 on Gold needs real volume ───────────
    if (session.quality === 'SKIP') {
        console.log(`[Signal] 🌙 Off-hours session — skipping all signals.`);
        return [];
    }

    for (const asset of assets) {
        const { indicators: ind, price, symbol } = asset;

        // ── HARD STOP: extreme volatility ─────────────────────────────────
        if (isExtremeVolatility(ind)) {
            console.log(`[Signal] 🔴 EXTREME VOLATILITY ATR=$${ind.atr5m.toFixed(2)} vol=${ind.volumeRatio.toFixed(1)}x — skipping.`);
            continue;
        }

        // ── BIAS SCORE ────────────────────────────────────────────────────
        const bias = computeBias(ind, price);
        const local = computeLocalDirection(ind, price);

        console.log(`[Signal] Bias: ${bias.direction} score=${bias.score}/5 choppy=${bias.isChoppy} | ${bias.reasons.slice(0,3).join(', ')}`);

        // ── HARD SKIP: choppy market ──────────────────────────────────────
        if (bias.isChoppy) {
            console.log(`[Signal] 🚫 CHOPPY — momentum conflict or ranging+weak ADX. Skipping.`);
            continue;
        }

        // ── HARD SKIP: weak bias in LOW session ───────────────────────────
        if (bias.score < 3 && session.quality === 'LOW') {
            console.log(`[Signal] ⚠ Weak bias (${bias.score}/5) in LOW session — skipping.`);
            continue;
        }

        // ── HARD SKIP: weak bias always — $6 needs conviction ────────────
        if (bias.score < 2) {
            console.log(`[Signal] ⚠ Bias too weak (${bias.score}/5) for $6 TP — skipping.`);
            continue;
        }

        // ── RSI hard blocks ───────────────────────────────────────────────
        if (bias.blockLong && local.direction === 'long') {
            console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} EXTREME OVERBOUGHT — blocking long.`);
            continue;
        }
        if (bias.blockShort && local.direction === 'short') {
            console.log(`[Signal] ⛔ RSI ${ind.rsi.toFixed(0)} EXTREME OVERSOLD — blocking short.`);
            continue;
        }

        // ── BUILD GEMINI PROMPT ───────────────────────────────────────────
        const prompt = `You are an XAU/USDC (Gold) perp scalper on Hyperliquid. 25x leverage, taker entry.
TP=$6.00 fixed. SL=scaled. Session: ${session.name} [${session.quality}].
Target: 50 trades/day in HIGH/PEAK sessions only.

LIVE XAU/USDC DATA:
Price: $${price.toFixed(2)}
EMA: ${ind.emaTrend} | RSI: ${ind.rsi.toFixed(1)} | ADX: ${ind.adx.toFixed(1)}
Mom 5m: ${ind.momentum5m.toFixed(4)}% | 30m: ${ind.momentum30m.toFixed(4)}% | 1h: ${ind.momentum1h.toFixed(4)}%
ATR(5m): $${ind.atr5m.toFixed(2)} | Structure: ${ind.priceStructure} | 4h: ${ind.trendBias4h} | Weekly: ${ind.weeklyBias}
Vol ratio: ${ind.volumeRatio.toFixed(2)}x | Spread: $${ind.spreadUsd.toFixed(2)}
Support: $${ind.nearestSupport.toFixed(2)} | Resistance: $${ind.nearestResistance.toFixed(2)}
Bias engine: ${bias.direction} score=${bias.score}/5 | ${bias.reasons.join(', ')}

RULES FOR $6 TP:
- $6 requires a trending move, not a scalp. ADX>25 + aligned momentum = go.
- If 30m and 1h momentum conflict → NEUTRAL. No exceptions.
- If RSI>75 → only SHORT. If RSI<25 → only LONG.
- Weekly bias + 4h bias agreement = high confidence. Disagreement = reduce confidence.
- Volume <0.5x average = low conviction, reduce confidence or skip.
- PEAK/HIGH session: trust momentum. LOW session: only extreme RSI setups.
- Return NEUTRAL if no clear $6 move setup exists. Better to skip than lose.

Reply JSON array ONLY. No markdown.
[{"symbol":"XAU/USDC","direction":"long","market_price":${price.toFixed(2)},"target_move":6.00,"confidence":0.75,"reasoning":"one sentence max 120 chars"}]`;

        // ── CALL GEMINI ───────────────────────────────────────────────────
        const geminiResult = await callGemini(prompt);

        if (!geminiResult) {
            // Local fallback — only if score is strong enough
            if (local.score >= 3 && local.direction !== 'neutral') {
                console.log(`[Signal] ⚙️ Gemini unavailable — using local fallback: ${local.direction.toUpperCase()}`);
                signals.push({
                    symbol, direction: local.direction, market_price: price,
                    target_move: TARGET_MOVE, confidence: 0.55, reasoning: local.reasoning,
                });
            } else {
                console.log(`[Signal] ⚙️ Gemini unavailable + weak local score — skipping.`);
            }
            continue;
        }

        // ── PARSE RESPONSE ────────────────────────────────────────────────
        const parsed = extractJSON(geminiResult.raw);

        if (!parsed || parsed.length === 0) {
            console.warn(`[Signal] Bad JSON from ${geminiResult.model} — skipping.`);
            continue;
        }

        for (const item of parsed) {
            let dir = String(item.direction ?? '').toLowerCase().trim();
            if (dir === 'buy')  dir = 'long';
            if (dir === 'sell') dir = 'short';

            // Respect neutral — unlike before, we do NOT override neutral
            if (!['long', 'short'].includes(dir)) {
                console.log(`[Signal] (${geminiResult.model}) Neutral/invalid — skipping trade.`);
                continue;
            }

            // Respect RSI hard blocks even on Gemini output
            if (dir === 'long'  && bias.blockLong)  { console.log(`[Signal] RSI block overrides Gemini long.`);  continue; }
            if (dir === 'short' && bias.blockShort) { console.log(`[Signal] RSI block overrides Gemini short.`); continue; }

            const confidence = Math.min(1, Math.max(0, Number(item.confidence ?? 0.60)));

            // Skip low-confidence signals — $6 TP needs conviction
            if (confidence < 0.55) {
                console.log(`[Signal] (${geminiResult.model}) Confidence ${confidence.toFixed(2)} too low for $6 TP — skipping.`);
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