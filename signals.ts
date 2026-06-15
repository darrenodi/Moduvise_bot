import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const MARKET_SYMBOL  = 'XAUUSDT';
export const DISPLAY_SYMBOL = 'XAU/USDT';
export const TARGET_MOVE    = 1.00;   // $1.00 TP — confirmed by user

// ─── MODEL FAILOVER ───────────────────────────────────────────────────────────
// Gemini kept but simplified: one prompt, one parse, local fallback on failure.
// No complex tier logic — just try KEY1 models then KEY2 models in sequence.

const MODEL_TIERS: Array<{ key: string; model: string }> = [
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash'      },
    { key: process.env.GEMINI_API_KEY  || '', model: 'gemini-2.5-flash-lite' },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash'      },
    { key: process.env.GEMINI_API_KEY2 || '', model: 'gemini-2.5-flash-lite' },
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
    if (h >= 13 && h < 16) return { name: 'London/NY Overlap', quality: 'PEAK', cycleMsMin: 30_000, cycleMsMax: 45_000,  sizePct: 1.00 };
    if (h >= 9  && h < 13) return { name: 'London',            quality: 'HIGH', cycleMsMin: 35_000, cycleMsMax: 55_000,  sizePct: 1.00 };
    if (h >= 16 && h < 19) return { name: 'New York',          quality: 'HIGH', cycleMsMin: 35_000, cycleMsMax: 55_000,  sizePct: 1.00 };
    if (h >= 19 && h < 21) return { name: 'NY Close',          quality: 'LOW',  cycleMsMin: 55_000, cycleMsMax: 80_000,  sizePct: 1.00 };
    return                         { name: 'Asia/Off-hours',   quality: 'LOW',  cycleMsMin: 70_000, cycleMsMax: 100_000, sizePct: 1.00 };
}
// sizePct is always 1.00 — 100% of balance used every trade, per user requirement.
// Cycle speed still varies by session to avoid poor-liquidity Asia fills.

// ─── ATR REGIME ───────────────────────────────────────────────────────────────

export interface AtrRegime {
    label:          'HIGH' | 'MED' | 'LOW';
    leverage:       number;
    tp:             number;
    sl:             number;
    baseSizePct:    number;
    minFeeMultiple: number;
}

export function calcAtrRegime(_atr5m: number, _confidence: number): AtrRegime {
    // Fixed TP = $1.00 | Fixed SL = $3.00
    // Breakeven win rate = SL/(SL+TP) = 3/(3+1) = 75%
    // User's observed win rate ~87% → 12pp margin above breakeven. Healthy.
    return {
        label:          'MED',
        leverage:       40,
        tp:             1.00,
        sl:             3.00,
        baseSizePct:    1.00,   // always 100%
        minFeeMultiple: 1,
    };
}

// ─── LIQUIDATION BUFFER ───────────────────────────────────────────────────────

export function safeLeverage(leverage: number, entryPrice: number, atr5m: number): number {
    // At 40x and ~$4250, liq distance ≈ $106. SL is $3.00. Safe by a wide margin.
    // This function only reduces leverage if liq distance < ATR×2 (extreme scenario).
    const minLiqDistance = atr5m * 2;
    let lev = leverage;
    while (lev > 1) {
        const liqDistance = entryPrice / lev;
        if (liqDistance >= minLiqDistance) break;
        lev = Math.max(1, lev - 5);
    }
    if (lev !== leverage) {
        console.log(`[Signal] ⚠️ Leverage reduced ${leverage}x→${lev}x — liq buffer check`);
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

    if (ind.emaTrend === 'bullish')      { bull++; reasons.push('EMA bull'); }
    else if (ind.emaTrend === 'bearish') { bear++; reasons.push('EMA bear'); }

    if (ind.rsi < 42)      { bull++; reasons.push(`RSI${ind.rsi.toFixed(0)} low`); }
    else if (ind.rsi > 58) { bear++; reasons.push(`RSI${ind.rsi.toFixed(0)} high`); }

    if (ind.momentum30m > 0.025)       { bull++; reasons.push(`30m+`); }
    else if (ind.momentum30m < -0.025) { bear++; reasons.push(`30m-`); }

    if (ind.momentum1h > 0.07)         { bull++; reasons.push(`1h+`); }
    else if (ind.momentum1h < -0.07)   { bear++; reasons.push(`1h-`); }

    if (ind.trendBias4h === 'bull')      { bull++; reasons.push(`4h+`); }
    else if (ind.trendBias4h === 'bear') { bear++; reasons.push(`4h-`); }

    if (ind.adx > 18) {
        if (bull > bear)      { bull++; reasons.push(`ADX${ind.adx.toFixed(0)}bull`); }
        else if (bear > bull) { bear++; reasons.push(`ADX${ind.adx.toFixed(0)}bear`); }
    }

    if (ind.obImbalance > 0.15)       { bull++; reasons.push(`OB+`); }
    else if (ind.obImbalance < -0.15) { bear++; reasons.push(`OB-`); }

    if (ind.distanceToSupport < 3.0)    { bull++; reasons.push(`NearSup`); }
    if (ind.distanceToResistance < 3.0) { bear++; reasons.push(`NearRes`); }

    if (ind.fundingRate !== null) {
        if (ind.fundingRate < -0.0002) { bull++; reasons.push(`Fund-`); }
        if (ind.fundingRate >  0.0002) { bear++; reasons.push(`Fund+`); }
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
    // Spread must be < 50% of TP to be worth trading ($0.50 max on a $1 TP).
    const maxSpread = 0.50;
    const tooWide   = ind.spreadUsd >= maxSpread;
    if (tooWide) console.log(`[Signal] ⚠️ Spread $${ind.spreadUsd.toFixed(3)} ≥ $${maxSpread} — skip.`);
    return tooWide;
}

// ─── LOCAL DIRECTION ──────────────────────────────────────────────────────────

function computeLocalDirection(ind: TechnicalIndicators, price: number): {
    direction: SignalDirection;
    reasoning: string;
} {
    const bias = computeBias(ind, price);
    let dir: SignalDirection;

    if (bias.direction === 'LONG'  && !bias.blockLong)  dir = 'long';
    else if (bias.direction === 'SHORT' && !bias.blockShort) dir = 'short';
    else if (Math.abs(ind.obImbalance) > 0.1) dir = ind.obImbalance > 0 ? 'long' : 'short';
    else if (Math.abs(ind.momentum5m) > 0.005) dir = ind.momentum5m >= 0 ? 'long' : 'short';
    else { const mid = (ind.high24h + ind.low24h) / 2; dir = price < mid ? 'long' : 'short'; }

    // Respect RSI blocks even after tiebreak
    if (dir === 'long'  && bias.blockLong)  dir = 'short';
    if (dir === 'short' && bias.blockShort) dir = 'long';

    return {
        direction: dir,
        reasoning: `LOCAL ${dir.toUpperCase()} score=${bias.score}/9 | ${bias.reasons.join(' ')}`,
    };
}

// ─── JSON EXTRACTOR ───────────────────────────────────────────────────────────

function extractJSON(text: string): any[] | null {
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    const objMatch   = text.match(/\{[\s\S]*?\}/);
    let candidate    = arrayMatch?.[0] ?? objMatch?.[0] ?? null;
    if (!candidate) return null;
    try {
        const parsed = JSON.parse(candidate);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        try {
            const fixed  = candidate.replace(/,\s*([}\]])/g, '$1');
            const parsed = JSON.parse(fixed);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch { return null; }
    }
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
            console.warn(`[Signal] ${tier.model} failed — ${String(err?.message ?? '').slice(0, 60)}`);
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

        if (isExtremeVolatility(ind)) {
            console.log(`[Signal] 🔴 Extreme volatility ATR=$${ind.atr5m.toFixed(2)} — skip.`);
            continue;
        }

        if (isSpreadTooWide(ind)) continue;

        const bias    = computeBias(ind, price);
        const local   = computeLocalDirection(ind, price);
        const regime  = calcAtrRegime(ind.atr5m, 0.65);
        const safetyLev = safeLeverage(regime.leverage, price, ind.atr5m);

        console.log(`[Signal] ATR=$${ind.atr5m.toFixed(2)} lev=${safetyLev}x TP=$${regime.tp} SL=$${regime.sl} | bias=${bias.direction} ${bias.score}/9`);

        const rangePos = ind.high24h > ind.low24h
            ? ((price - ind.low24h) / (ind.high24h - ind.low24h) * 100).toFixed(0) : '50';

        const fundingNote = ind.fundingRate !== null
            ? `Funding: ${(ind.fundingRate * 100).toFixed(4)}% (${ind.fundingRate < 0 ? 'shorts pay longs' : 'longs pay shorts'})`
            : 'Funding: N/A';

        // ── Gemini prompt — tight, fast, JSON only ────────────────────────────
        const prompt = `You are a gold futures scalper. Decide: LONG or SHORT on XAUUSDT now to catch a $1.00 move.

SNAPSHOT — ${new Date().toISOString()}:
Price: $${price.toFixed(2)} | Range: $${ind.low24h.toFixed(2)}–$${ind.high24h.toFixed(2)} | Pos: ${rangePos}%
EMA: ${ind.emaTrend} | RSI: ${ind.rsi.toFixed(1)} | ADX: ${ind.adx.toFixed(1)}
Mom: 5m=${ind.momentum5m.toFixed(3)}% 30m=${ind.momentum30m.toFixed(3)}% 1h=${ind.momentum1h.toFixed(3)}%
ATR: $${ind.atr5m.toFixed(2)} | Spread: $${ind.spreadUsd.toFixed(3)} | Vol: ${ind.volumeRatio.toFixed(2)}x
OB: ${(ind.obImbalance * 100).toFixed(1)}% buy | VWAP: ${ind.priceVsVwap.toFixed(3)}%
Sup: $${ind.nearestSupport.toFixed(2)} (${ind.distanceToSupport.toFixed(2)} away) | Res: $${ind.nearestResistance.toFixed(2)} (${ind.distanceToResistance.toFixed(2)} away)
4h: ${ind.trendBias4h} | Weekly: ${ind.weeklyBias} | ${fundingNote}

RULES:
- TP=$1.00 | SL=$3.00 | lev=${safetyLev}x | size=1.00 (100% of balance — fixed)
- LONG: near support, OB buy pressure, momentum up, RSI rising
- SHORT: near resistance, OB sell pressure, momentum down, RSI falling
- Never output neutral. If 50/50: follow OB imbalance → 5m momentum → go LONG
- RSI>82: no long. RSI<18: no short.

Reply JSON array only, no markdown:
[{"symbol":"XAU/USDT","direction":"long","market_price":${price.toFixed(2)},"target_move":1.00,"confidence":0.72,"reasoning":"max 80 chars","suggested_tp":1.00,"suggested_leverage":${safetyLev},"session_size_pct":1.00}]`;

        const geminiResult = await callGemini(prompt);

        const buildFallback = (): GeneratedSignal => ({
            symbol, direction: local.direction, market_price: price,
            target_move: regime.tp, confidence: 0.55,
            reasoning:   local.reasoning.slice(0, 100),
            suggested_tp: regime.tp, suggested_leverage: safetyLev, session_size_pct: 1.00,
        });

        if (!geminiResult) {
            console.log(`[Signal] Gemini unavailable — local: ${local.direction.toUpperCase()}`);
            signals.push(buildFallback());
            continue;
        }

        const parsed = extractJSON(geminiResult.raw);

        if (!parsed?.length) {
            console.warn(`[Signal] Bad JSON from ${geminiResult.model} — local fallback.`);
            signals.push(buildFallback());
            continue;
        }

        const item = parsed[0];
        let dir    = String(item.direction ?? '').toLowerCase().trim();
        if (dir === 'buy')  dir = 'long';
        if (dir === 'sell') dir = 'short';

        // Neutral → local
        if (!['long', 'short'].includes(dir)) dir = local.direction;

        // RSI blocks
        if (dir === 'long'  && bias.blockLong)  dir = local.direction === 'short' ? 'short' : 'long';
        if (dir === 'short' && bias.blockShort) dir = local.direction === 'long'  ? 'long'  : 'short';

        const confidence = Math.min(1, Math.max(0.50, Number(item.confidence ?? 0.60)));
        const reasoning  = String(item.reasoning ?? local.reasoning).slice(0, 100);

        console.log(`[Signal] ✅ (${geminiResult.model}) ${dir.toUpperCase()} conf=${confidence.toFixed(2)} | ${reasoning}`);

        signals.push({
            symbol,
            direction:          dir as SignalDirection,
            market_price:       price,
            target_move:        1.00,
            confidence,
            reasoning,
            suggested_tp:       1.00,
            suggested_leverage: safetyLev,
            session_size_pct:   1.00,   // always 1.00 — 100% balance
        });
    }

    return signals;
}