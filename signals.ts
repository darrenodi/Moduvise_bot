import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── TWO-KEY SETUP ────────────────────────────────────────────────────────────
// Key 1 (GEMINI_API_KEY)  → exhausted first
// Key 2 (GEMINI_API_KEY2) → fallback when key 1 hits rate limits
//
// Model strings that are FREE and ACTIVE as of May 2026:
//   gemini-3.1-flash-lite  → 500 RPD, 15 RPM  (primary workhorse — highest quota)
//   gemini-3.5-flash       → 20 RPD,  5 RPM   (best quality among free models)
//   gemini-2.5-flash       → 20 RPD,  5 RPM   (strong reasoning)
//   gemini-2.5-flash-lite  → 20 RPD, 10 RPM   (lightweight backup)
//   gemini-3-flash         → 20 RPD,  5 RPM   (additional fallback)
//
// NOTE: gemini-2.0-flash and gemini-2.0-flash-lite are DEAD as of June 1 2026.
// They are NOT in this list.

const MODEL_TIERS: Array<{ key: string; model: string }> = [
    // ── KEY 1 — burn highest-quota model first ────────────────────────
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-3.1-flash-lite' },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-3.5-flash'       },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash'       },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash-lite'  },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-3-flash'         },
    // ── KEY 2 — full retry across all models on second key ───────────
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-3.1-flash-lite' },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-3.5-flash'       },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash'       },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash-lite'  },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-3-flash'         },
];

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type SignalDirection = 'long' | 'short' | 'neutral';

export interface TechnicalIndicators {
    emaTrend: 'bullish' | 'bearish' | 'neutral';
    ema8: number;
    ema21: number;
    ema50: number;
    rsi: number;
    rsiZone: 'oversold' | 'neutral' | 'overbought';
    momentum5m: number;
    momentum30m: number;
    momentum1h: number;
    priceStructure: 'uptrend' | 'downtrend' | 'ranging';
    weeklyBias: 'bullish' | 'bearish' | 'neutral';
    trendBias4h: 'bull' | 'bear' | 'neutral';
    atr5m: number;
    atrPct: number;
    volumeRatio: number;
    nearestResistance: number;
    nearestSupport: number;
    distanceToResistance: number;
    distanceToSupport: number;
    high24h: number;
    low24h: number;
    adx: number;
    fundingRate: number | null;
}

export interface MarketData {
    symbol: string;
    price: number;
    change_24h: number;
    indicators: TechnicalIndicators;
    orderBook: {
        bidWalls: Array<{ price: number; notionalUsd: number }>;
        askWalls: Array<{ price: number; notionalUsd: number }>;
    };
}

export interface GeneratedSignal {
    symbol: string;
    direction: SignalDirection;
    market_price: number;
    target_move: number;
    confidence: number;
    reasoning: string;
}

// ─── SESSION ──────────────────────────────────────────────────────────────────

function getSession(): { name: string; quality: 'PEAK' | 'HIGH' | 'CAUTION' | 'LOW' | 'DANGER'; minConf: number; minBias: number } {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 17) return { name: 'London/NY Overlap', quality: 'PEAK',    minConf: 0.60, minBias: 2 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH',    minConf: 0.62, minBias: 2 };
    if (h >= 17 && h < 21) return { name: 'New York',          quality: 'CAUTION', minConf: 0.72, minBias: 3 };
    if (h === 8)            return { name: 'London Open',       quality: 'DANGER',  minConf: 1.1,  minBias: 4 };
    return                         { name: 'Asia/Off-Hours',    quality: 'LOW',     minConf: 0.75, minBias: 3 };
}

// ─── BIAS PRE-COMPUTATION ─────────────────────────────────────────────────────

interface BiasResult {
    direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    score: number;
    reasons: string[];
    isChoppy: boolean;
    blockLong: string | null;
    blockShort: string | null;
}

function computeBias(ind: TechnicalIndicators, price: number): BiasResult {
    const reasons: string[] = [];
    let bull = 0, bear = 0;

    // 1. EMA stack
    if (ind.emaTrend === 'bullish') { bull++; reasons.push(`EMA bullish (8>21>50): ${ind.ema8.toFixed(0)}>${ind.ema21.toFixed(0)}>${ind.ema50.toFixed(0)}`); }
    else if (ind.emaTrend === 'bearish') { bear++; reasons.push(`EMA bearish (8<21<50): ${ind.ema8.toFixed(0)}<${ind.ema21.toFixed(0)}<${ind.ema50.toFixed(0)}`); }
    else reasons.push(`EMA neutral`);

    // 2. RSI
    if (ind.rsi < 40)      { bull++; reasons.push(`RSI ${ind.rsi.toFixed(1)} oversold zone — buy pressure`); }
    else if (ind.rsi > 60) { bear++; reasons.push(`RSI ${ind.rsi.toFixed(1)} overbought zone — sell pressure`); }
    else reasons.push(`RSI ${ind.rsi.toFixed(1)} neutral`);

    // 3. 30m + 1h momentum (the only meaningful timeframes — 1m is noise)
    const m30s = ind.momentum30m > 0.05 ? 1 : ind.momentum30m < -0.05 ? -1 : 0;
    const m1hs = ind.momentum1h  > 0.10 ? 1 : ind.momentum1h  < -0.10 ? -1 : 0;
    if      (m30s === 1  && m1hs === 1)  { bull++; reasons.push(`Momentum BULL: 30m=${ind.momentum30m.toFixed(3)}% 1h=${ind.momentum1h.toFixed(3)}%`); }
    else if (m30s === -1 && m1hs === -1) { bear++; reasons.push(`Momentum BEAR: 30m=${ind.momentum30m.toFixed(3)}% 1h=${ind.momentum1h.toFixed(3)}%`); }
    else if (m30s !== 0 && m1hs !== 0 && m30s !== m1hs) {
        reasons.push(`⚠ MOMENTUM CONFLICT: 30m=${ind.momentum30m.toFixed(3)}% vs 1h=${ind.momentum1h.toFixed(3)}% — oscillating`);
    }

    // 4. Weekly + 4h alignment
    if (ind.weeklyBias === 'bullish' && ind.trendBias4h === 'bull') { bull++; reasons.push(`HTF aligned BULL: weekly=bullish 4h=bull`); }
    if (ind.weeklyBias === 'bearish' && ind.trendBias4h === 'bear') { bear++; reasons.push(`HTF aligned BEAR: weekly=bearish 4h=bear`); }
    if (ind.weeklyBias !== 'neutral' && ind.trendBias4h !== 'neutral') {
        const htfBull = ind.weeklyBias === 'bullish' && ind.trendBias4h === 'bull';
        const htfBear = ind.weeklyBias === 'bearish' && ind.trendBias4h === 'bear';
        if (!htfBull && !htfBear) reasons.push(`⚠ HTF CONFLICT: weekly=${ind.weeklyBias} vs 4h=${ind.trendBias4h}`);
    }

    // 5. Nearest S/R
    const dResP = (ind.nearestResistance - price) / price * 100;
    const dSupP = (price - ind.nearestSupport)    / price * 100;
    if (dResP > 0 && dResP < 0.10) { bear++; reasons.push(`${dResP.toFixed(3)}% from resistance — likely cap`); }
    if (dSupP > 0 && dSupP < 0.10) { bull++; reasons.push(`${dSupP.toFixed(3)}% from support — likely bounce`); }

    const momentumConflict = m30s !== 0 && m1hs !== 0 && m30s !== m1hs;
    const isChoppy = momentumConflict || ind.priceStructure === 'ranging';
    const blockLong  = ind.rsi >= 75 ? `RSI ${ind.rsi.toFixed(1)} EXTREME OVERBOUGHT — no longs` : null;
    const blockShort = ind.rsi <= 25 ? `RSI ${ind.rsi.toFixed(1)} EXTREME OVERSOLD — no shorts`  : null;
    const score = Math.max(bull, bear);
    const direction = bull > bear ? 'LONG' : bear > bull ? 'SHORT' : 'NEUTRAL';

    return { direction, score, reasons, isChoppy, blockLong, blockShort };
}

// ─── JSON EXTRACTION ──────────────────────────────────────────────────────────
// These are text-out models. They may wrap JSON in markdown fences, add
// explanatory text before/after, or return a JSON object instead of an array.
// This function handles all of those cases robustly.

function extractJSON(raw: string): Array<Record<string, unknown>> | null {
    // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
    let text = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();

    // 2. Find the first JSON structure in the text (array OR object)
    //    Models sometimes add a sentence before the JSON.
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    const objMatch   = text.match(/\{[\s\S]*\}/);

    let candidate: string | null = null;

    if (arrayMatch && objMatch) {
        // Take whichever starts first
        candidate = arrayMatch.index! <= objMatch.index! ? arrayMatch[0] : objMatch[0];
    } else {
        candidate = arrayMatch?.[0] ?? objMatch?.[0] ?? null;
    }

    if (!candidate) return null;

    try {
        const parsed = JSON.parse(candidate);
        // Normalise to array
        if (Array.isArray(parsed))       return parsed;
        if (parsed.signals && Array.isArray(parsed.signals)) return parsed.signals;
        if (typeof parsed === 'object')  return [parsed];
        return null;
    } catch {
        // Last resort: attempt to fix common model mistakes
        // (trailing comma before closing bracket/brace)
        try {
            const fixed = candidate
                .replace(/,\s*([}\]])/g, '$1')   // trailing commas
                .replace(/([{,]\s*)(\w+):/g, '$1"$2":'); // unquoted keys
            const parsed = JSON.parse(fixed);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object') return [parsed];
        } catch { /* give up */ }
        return null;
    }
}

// ─── VALIDATE SIGNAL FIELDS ───────────────────────────────────────────────────
// Models occasionally hallucinate field names or swap TP/SL.
// Validate and normalise before using.

function validateSignal(raw: Record<string, unknown>, price: number, symbol: string): {
    direction: SignalDirection;
    confidence: number;
    reasoning: string;
} | null {
    // Direction — accept common variations models produce
    let dir = String(raw.direction ?? raw.dir ?? raw.side ?? '').toLowerCase().trim();
    if (dir === 'buy')  dir = 'long';
    if (dir === 'sell') dir = 'short';
    if (!['long', 'short', 'neutral'].includes(dir)) {
        console.warn(`[Signal] Unrecognised direction "${raw.direction}" — dropping`);
        return null;
    }

    // Confidence — models sometimes return as string "0.75" or percent "75"
    let conf = 0;
    const rawConf = raw.confidence ?? raw.conf ?? raw.score;
    if (typeof rawConf === 'number') {
        conf = rawConf > 1 ? rawConf / 100 : rawConf; // handle percentage
    } else if (typeof rawConf === 'string') {
        conf = parseFloat(rawConf);
        if (conf > 1) conf /= 100;
    }
    conf = Math.max(0, Math.min(1, isNaN(conf) ? 0 : conf));

    // Reasoning — fall back gracefully
    const reasoning = String(raw.reasoning ?? raw.reason ?? raw.rationale ?? raw.explanation ?? 'No reasoning provided').slice(0, 300);

    // Market price sanity — model might echo a wildly wrong price
    const mp = Number(raw.market_price ?? raw.price ?? price);
    if (Math.abs(mp - price) / price > 0.05) {
        console.warn(`[Signal] Model returned price $${mp.toFixed(2)} vs live $${price.toFixed(2)} — using live price`);
    }

    return { direction: dir as SignalDirection, confidence: conf, reasoning };
}

// ─── LOCAL FALLBACK ───────────────────────────────────────────────────────────

function localFallback(asset: MarketData, bias: BiasResult, session: ReturnType<typeof getSession>): GeneratedSignal {
    const { price, symbol, indicators: ind } = asset;
    let direction: SignalDirection = 'neutral';
    let reasoning = 'LOCAL fallback';

    if (!bias.isChoppy && bias.score >= session.minBias && !bias.blockLong && !bias.blockShort) {
        if (bias.direction === 'LONG'  && ind.trendBias4h !== 'bear') {
            direction = 'long';
            reasoning = `LOCAL: ${bias.score}/5 bull — ${bias.reasons[0]}`;
        } else if (bias.direction === 'SHORT' && ind.trendBias4h !== 'bull') {
            direction = 'short';
            reasoning = `LOCAL: ${bias.score}/5 bear — ${bias.reasons[0]}`;
        }
    } else {
        reasoning = bias.isChoppy
            ? `LOCAL: choppy market (${ind.priceStructure}) — skip`
            : `LOCAL: score ${bias.score} < min ${session.minBias} — skip`;
    }

    const confidence = direction === 'neutral' ? 0 : 0.45;
    console.log(`[Signal] ⚙️  LOCAL → ${direction.toUpperCase()} conf=${confidence} | ${reasoning}`);
    return { symbol, direction, market_price: price, target_move: 70, confidence, reasoning };
}

// ─── PROMPT ───────────────────────────────────────────────────────────────────

function buildPrompt(asset: MarketData, bias: BiasResult, session: ReturnType<typeof getSession>): string {
    const { price, symbol, indicators: ind, orderBook } = asset;
    const p = (n: number) => n.toFixed(2);

    const volLabel = ind.volumeRatio >= 1.5 ? `🔥 HIGH (${ind.volumeRatio.toFixed(2)}x)` :
                     ind.volumeRatio <= 0.6 ? `⚠ LOW (${ind.volumeRatio.toFixed(2)}x)` :
                     `normal (${ind.volumeRatio.toFixed(2)}x)`;

    const fundLine = ind.fundingRate === null ? 'n/a' : (() => {
        const r = ind.fundingRate;
        const interp = r > 0.0003 ? 'elevated longs — bearish pressure' :
                       r < -0.0003 ? 'elevated shorts — bullish pressure' : 'neutral';
        return `${r >= 0 ? '+' : ''}${(r * 100).toFixed(4)}% per 8h (${interp})`;
    })();

    // TP levels and wall warnings
    const tpLong  = price + 70, tpShort = price - 70;
    const nearAsk = orderBook.askWalls[0], nearBid = orderBook.bidWalls[0];
    const warnLong  = nearAsk && tpLong  > nearAsk.price
        ? `⚠ LONG TP $${p(tpLong)} hits through ask wall $${p(nearAsk.price)} ($${(nearAsk.notionalUsd/1000).toFixed(0)}K)` : `✓ Long TP $${p(tpLong)} clears nearest ask`;
    const warnShort = nearBid && tpShort < nearBid.price
        ? `⚠ SHORT TP $${p(tpShort)} hits through bid wall $${p(nearBid.price)} ($${(nearBid.notionalUsd/1000).toFixed(0)}K)` : `✓ Short TP $${p(tpShort)} clears nearest bid`;

    const choppyLine = bias.isChoppy
        ? `\n🚫 CHOPPY: momentum conflict or ranging — confidence=0.0 required unless strong news\n` : '';
    const blockLines = [bias.blockLong ? `⛔ ${bias.blockLong}` : '', bias.blockShort ? `⛔ ${bias.blockShort}` : ''].filter(Boolean).join('\n');

    const sessionNote =
        session.quality === 'PEAK'    ? '79% historical WR — trust momentum breakouts' :
        session.quality === 'HIGH'    ? '71% WR — trend-follow the established direction' :
        session.quality === 'CAUTION' ? '54% WR — BELOW breakeven for 1:1 R/R. Need 3+/5 signals. Prefer skip over marginal setup.' :
        session.quality === 'DANGER'  ? 'Stop-hunt hour — skip all entries' :
                                        'Thin volume — 3+/5 signals required, prefer skip';

    return `You are a professional BTC perp scalper on Hyperliquid. 40x leverage. TP=$70, SL=$70 (1:1 R/R).

SESSION: ${session.name} [${session.quality}] — ${sessionNote}

PRE-COMPUTED BIAS (${bias.score}/5 signals → ${bias.direction}):
${bias.reasons.map(r => `  • ${r}`).join('\n')}
${choppyLine}${blockLines ? blockLines + '\n' : ''}
MARKET:
  Price: $${p(price)} | 24h: ${asset.change_24h >= 0 ? '+' : ''}${asset.change_24h.toFixed(3)}%
  EMA8=$${p(ind.ema8)} EMA21=$${p(ind.ema21)} EMA50=$${p(ind.ema50)} → ${ind.emaTrend.toUpperCase()}
  RSI(14): ${ind.rsi.toFixed(1)} [${ind.rsiZone.toUpperCase()}]
  Mom: 5m=${ind.momentum5m.toFixed(4)}% | 30m=${ind.momentum30m.toFixed(4)}% | 1h=${ind.momentum1h.toFixed(4)}%
  ATR(5m): $${p(ind.atr5m)} | Volume: ${volLabel} | ADX: ${ind.adx.toFixed(1)}${ind.adx > 25 ? ' (trending)' : ''}
  Funding: ${fundLine}
  Weekly: ${ind.weeklyBias.toUpperCase()} | 4h: ${ind.trendBias4h.toUpperCase()}
  24h range: $${p(ind.low24h)}–$${p(ind.high24h)} | Structure: ${ind.priceStructure.toUpperCase()}
  Support: $${p(ind.nearestSupport)} (${ind.distanceToSupport.toFixed(0)} away)
  Resistance: $${p(ind.nearestResistance)} (${ind.distanceToResistance.toFixed(0)} away)
  Bid walls: ${orderBook.bidWalls.slice(0,3).map(w=>`$${p(w.price)}(${(w.notionalUsd/1000).toFixed(0)}K)`).join(' | ')||'none'}
  Ask walls: ${orderBook.askWalls.slice(0,3).map(w=>`$${p(w.price)}(${(w.notionalUsd/1000).toFixed(0)}K)`).join(' | ')||'none'}
  ${warnLong}
  ${warnShort}

TP/SL:
  LONG:  TP=$${p(tpLong)} | SL=$${p(price-70)}
  SHORT: TP=$${p(tpShort)} | SL=$${p(price+70)}

RULES:
  1. Choppy block → confidence=0.0, no exceptions
  2. Weekly+4h both agree → primary direction
  3. EMA stack confirms → +1 conviction
  4. RSI ≥70 = short pressure; ≤30 = long pressure
  5. 30m+1h momentum BOTH aligned → confirms; conflicting → reduces confidence
  6. Order book wall in TP path → reduce confidence 0.05
  7. SHORT wins 72% vs LONG 61% historically — marginal long = skip
  8. NY session (CAUTION): skip unless 3+/5 agree
  Bias score: ${bias.score}/5 → ${bias.direction}

CONFIDENCE: 0.0=skip | 0.50–0.64=weak | 0.65–0.79=solid | 0.80–1.0=strong

CRITICAL OUTPUT RULES:
  - Reply with a JSON array only. No explanation. No markdown. No text before or after.
  - Use exactly these field names: symbol, direction, market_price, target_move, confidence, reasoning
  - direction must be exactly: "long", "short", or "neutral"
  - confidence must be a number between 0.0 and 1.0
  - reasoning must be one sentence under 100 characters

Example of the ONLY acceptable output format:
[{"symbol":"BTC/USDC:USDC","direction":"short","market_price":${p(price)},"target_move":70,"confidence":0.72,"reasoning":"EMA bearish, RSI 63 falling, 30m+1h momentum aligned down."}]`;
}

// ─── MAIN SIGNAL ENGINE ───────────────────────────────────────────────────────

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];
    const session = getSession();

    for (const asset of assets) {
        try {
            const { indicators: ind, price } = asset;
            const bias = computeBias(ind, price);

            console.log(`[Signal] ${session.name}[${session.quality}] | Bias:${bias.direction} ${bias.score}/5 | Choppy:${bias.isChoppy} | RSI:${ind.rsi.toFixed(1)}`);

            // Pre-filter: save quota on obvious skips
            if (bias.isChoppy && (session.quality === 'LOW' || session.quality === 'DANGER')) {
                console.log(`[Signal] Pre-filter: choppy + low session — skip API call`);
                signals.push({ symbol: asset.symbol, direction: 'neutral', market_price: price, target_move: 70, confidence: 0, reasoning: 'Choppy + low session' });
                continue;
            }

            const prompt = buildPrompt(asset, bias, session);

            // ── MODEL + KEY FAILOVER ──────────────────────────────────────
            let raw: string | null = null;
            let activeTag = '';

            for (const tier of MODEL_TIERS) {
                if (!tier.key) continue; // skip if env var not set

                try {
                    const client = new GoogleGenerativeAI(tier.key);
                    const model  = client.getGenerativeModel({ model: tier.model });
                    const result = await model.generateContent(prompt);
                    raw       = result.response.text();
                    activeTag = `${tier.model}[key${tier.key === process.env.GEMINI_API_KEY ? '1' : '2'}]`;
                    break;
                } catch (err: any) {
                    const code = err?.status ?? err?.code ?? '';
                    const isRateLimit = String(err).toLowerCase().match(/429|quota|rate.?limit|resource.?exhausted|too.?many/);
                    console.warn(`[Signal] ${tier.model}[key${tier.key === process.env.GEMINI_API_KEY ? '1' : '2'}] failed (${code})${isRateLimit ? ' — rate limit, trying next' : ''}`);
                }
            }

            // All API options exhausted — local fallback
            if (!raw) {
                console.warn(`[Signal] ⚠️ All keys+models exhausted — local fallback`);
                signals.push(localFallback(asset, bias, session));
                continue;
            }

            // ── PARSE — handle all text-out model quirks ──────────────────
            const parsed = extractJSON(raw);

            if (!parsed) {
                console.error(`[Signal] (${activeTag}) Could not extract JSON from: "${raw.slice(0, 150)}"`);
                signals.push(localFallback(asset, bias, session));
                continue;
            }

            for (const item of parsed) {
                const validated = validateSignal(item, price, asset.symbol);
                if (!validated) continue;

                const { direction, confidence, reasoning } = validated;

                // Direction hard blocks (applied after model response)
                if (direction === 'long'  && bias.blockLong)  { console.warn(`[Signal] LONG blocked: ${bias.blockLong}`);  continue; }
                if (direction === 'short' && bias.blockShort) { console.warn(`[Signal] SHORT blocked: ${bias.blockShort}`); continue; }

                // Session confidence gate
                if (confidence < session.minConf) {
                    console.log(`[Signal] (${activeTag}) SKIP ${direction.toUpperCase()} conf=${confidence.toFixed(2)} < min=${session.minConf} [${session.name}]`);
                    signals.push({ symbol: asset.symbol, direction: 'neutral', market_price: price, target_move: 70, confidence: 0, reasoning: `conf ${confidence.toFixed(2)} below session min` });
                    continue;
                }

                console.log(`[Signal] (${activeTag}) ${direction.toUpperCase()} | conf=${confidence.toFixed(2)} | ${reasoning}`);
                signals.push({ symbol: asset.symbol, direction, market_price: price, target_move: 70, confidence, reasoning });
            }

        } catch (err) {
            console.error(`[Signal] Unexpected error: ${err}`);
        }
    }

    return signals;
}
