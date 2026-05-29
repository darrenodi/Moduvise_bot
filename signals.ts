import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XYZ-GOLD/USDC:USDC';   // Changed ':' to '-' inside the asset name
export const DISPLAY_SYMBOL = 'XAU/USDC';
export const TARGET_MOVE    = 2.00;
              // $2.00 TP move (Gold tick scale)

// ─── MODEL FAILOVER ───────────────────────────────────────────────────────────
// Two API keys × multiple models. Burns highest-quota first.

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
    atr5m:                number;   // In Gold $ terms
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
    spreadUsd:            number;   // Live BBO spread in $
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

// ─── GOLD VOLATILITY GUARD ────────────────────────────────────────────────────
// Pause ONLY during flash spikes: ATR > $8 on 5m AND volume > 3x normal.
// Gold ATR on 5m is typically $0.50–$2.00. >$8 = news/macro event.
// This protects capital during FOMC, CPI, NFP, geopolitical shocks.

function isExtremeVolatility(ind: TechnicalIndicators): boolean {
    return ind.atr5m > 8.0 && ind.volumeRatio > 3.0;
}

// ─── LOCAL DIRECTION ENGINE ───────────────────────────────────────────────────
// Pure math fallback when Gemini is unavailable.
// Gold always has a micro-direction for $2 moves.

export function computeLocalDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
    score: number;
} {
    let bull = 0, bear = 0;
    const reasons: string[] = [];

    // 1. EMA trend (1h)
    if (ind.emaTrend === 'bullish') { bull += 2; reasons.push('EMA bullish stack'); }
    else if (ind.emaTrend === 'bearish') { bear += 2; reasons.push('EMA bearish stack'); }

    // 2. RSI zones
    if (ind.rsi < 40) { bull += 2; reasons.push(`RSI ${ind.rsi.toFixed(0)} oversold`); }
    else if (ind.rsi > 60) { bear += 2; reasons.push(`RSI ${ind.rsi.toFixed(0)} overbought`); }

    // 3. 30m momentum (core signal for $2 Gold moves)
    if (ind.momentum30m > 0.02)  { bull += 2; reasons.push(`30m mom +${ind.momentum30m.toFixed(3)}%`); }
    if (ind.momentum30m < -0.02) { bear += 2; reasons.push(`30m mom ${ind.momentum30m.toFixed(3)}%`); }

    // 4. 1h momentum
    if (ind.momentum1h > 0.05)  { bull += 1; reasons.push(`1h mom +${ind.momentum1h.toFixed(3)}%`); }
    if (ind.momentum1h < -0.05) { bear += 1; reasons.push(`1h mom ${ind.momentum1h.toFixed(3)}%`); }

    // 5. Support / resistance proximity
    if (ind.distanceToSupport < ind.distanceToResistance * 0.5) {
        bull += 1; reasons.push(`near support $${ind.nearestSupport.toFixed(2)}`);
    } else if (ind.distanceToResistance < ind.distanceToSupport * 0.5) {
        bear += 1; reasons.push(`near resistance $${ind.nearestResistance.toFixed(2)}`);
    }

    // 6. 4h bias
    if (ind.trendBias4h === 'bull') { bull += 1; reasons.push('4h bull'); }
    else if (ind.trendBias4h === 'bear') { bear += 1; reasons.push('4h bear'); }

    // 7. 5m tiebreaker
    if (bull === bear) {
        if (ind.momentum5m > 0) { bull += 1; reasons.push('5m positive tiebreak'); }
        else { bear += 1; reasons.push('5m negative tiebreak'); }
    }

    const direction: SignalDirection = bull > bear ? 'long' : 'short';
    const score = Math.max(bull, bear);
    const reasoning = `LOCAL ${direction.toUpperCase()}: ${reasons.slice(0, 3).join(', ')}`;

    return { direction, reasoning, score };
}

// ─── JSON EXTRACTOR ───────────────────────────────────────────────────────────

function extractJSON(raw: string): Array<Record<string, unknown>> | null {
    let text = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
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

// ─── GEMINI CALL WITH FAILOVER ────────────────────────────────────────────────

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

    for (const asset of assets) {
        const { indicators: ind, price, symbol } = asset;

        // ── HARD STOP: extreme volatility (news/macro spike) ──────────────
        if (isExtremeVolatility(ind)) {
            console.log(`[Signal] 🔴 EXTREME VOLATILITY — ATR $${ind.atr5m.toFixed(2)} vol ${ind.volumeRatio.toFixed(1)}x. Pausing.`);
            signals.push({
                symbol, direction: 'neutral', market_price: price,
                target_move: TARGET_MOVE, confidence: 0,
                reasoning: 'Extreme volatility pause — ATR spike + vol surge'
            });
            continue;
        }

        // ── LOCAL DIRECTION (always computed as baseline) ──────────────────
        const local = computeLocalDirection(ind, price);
        console.log(`[Signal] Local: ${local.direction.toUpperCase()} score=${local.score} | ${local.reasoning}`);

        // ── BUILD COMPACT GEMINI PROMPT (Gold-specific) ────────────────────
        const prompt = `You are an XAU/USDC (Gold) perp scalper on Hyperliquid. 25x leverage. TP=$2.00, dynamic SL.
Target: 100+ trades/day. Trade 24/7 except during macro spikes (ATR>$8 + vol>3x).
Gold moves $2 every few minutes in normal conditions. ALWAYS have a direction.

LIVE XAU/USDC DATA:
Price: $${price.toFixed(2)}
EMA trend: ${ind.emaTrend} | RSI: ${ind.rsi.toFixed(1)}
Mom 5m: ${ind.momentum5m.toFixed(4)}% | 30m: ${ind.momentum30m.toFixed(4)}% | 1h: ${ind.momentum1h.toFixed(4)}%
ATR(5m): $${ind.atr5m.toFixed(2)} | ADX: ${ind.adx.toFixed(1)} | Structure: ${ind.priceStructure}
Spread: $${ind.spreadUsd.toFixed(2)} | 4h bias: ${ind.trendBias4h} | Weekly: ${ind.weeklyBias}
Support: $${ind.nearestSupport.toFixed(2)} (${ind.distanceToSupport.toFixed(1)} away)
Resistance: $${ind.nearestResistance.toFixed(2)} (${ind.distanceToResistance.toFixed(1)} away)
Local engine says: ${local.direction.toUpperCase()} (score ${local.score}/9)

RULES:
- Gold always has micro-direction. NEVER return neutral.
- A $2 move happens every 5-20 min in normal Gold conditions.
- Confirm local direction OR override with strong counter-evidence only.
- RSI>70 = prefer short. RSI<30 = prefer long. Otherwise follow momentum.
- If spread > $1.50, lower confidence slightly (fill harder).
- Reply with JSON array ONLY. No markdown. No text outside JSON.

[{"symbol":"GOLD/USDC:USDC","direction":"long","market_price":${price.toFixed(2)},"target_move":2.00,"confidence":0.72,"reasoning":"one sentence max 100 chars"}]`;

        // ── CALL GEMINI ────────────────────────────────────────────────────
        const geminiResult = await callGemini(prompt);

        if (!geminiResult) {
            console.log(`[Signal] ⚙️ Gemini unavailable — using local: ${local.direction.toUpperCase()}`);
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: TARGET_MOVE, confidence: 0.50, reasoning: local.reasoning,
            });
            continue;
        }

        // ── PARSE GEMINI RESPONSE ──────────────────────────────────────────
        const parsed = extractJSON(geminiResult.raw);

        if (!parsed || parsed.length === 0) {
            console.warn(`[Signal] (${geminiResult.model}) Bad JSON — using local: ${local.direction.toUpperCase()}`);
            signals.push({
                symbol, direction: local.direction, market_price: price,
                target_move: TARGET_MOVE, confidence: 0.50, reasoning: local.reasoning,
            });
            continue;
        }

        for (const item of parsed) {
            let dir = String(item.direction ?? '').toLowerCase().trim();
            if (dir === 'buy')  dir = 'long';
            if (dir === 'sell') dir = 'short';
            if (!['long', 'short', 'neutral'].includes(dir)) dir = local.direction;

            // Never skip — always trade
            if (dir === 'neutral') {
                console.log(`[Signal] (${geminiResult.model}) Said neutral — overriding with local: ${local.direction.toUpperCase()}`);
                dir = local.direction;
            }

            const confidence = Math.min(1, Math.max(0, Number(item.confidence ?? 0.60)));
            const reasoning  = String(item.reasoning ?? local.reasoning).slice(0, 200);
            const mp         = Number(item.market_price ?? price);

            console.log(`[Signal] (${geminiResult.model}) ${dir.toUpperCase()} conf=${confidence.toFixed(2)} | ${reasoning}`);

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