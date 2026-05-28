import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── GEMINI CLIENT ────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * MODEL TIERS — ordered by daily quota (highest first) so we preserve
 * the smarter models for when we need them.
 *
 * Actual API model strings (as of May 2025):
 *   gemini-2.0-flash-lite  → maps to what the dashboard calls "3.1 Flash Lite" (500 RPD, 15 RPM)
 *   gemini-2.0-flash       → 20 RPD, 15 RPM (smart, fast)
 *   gemini-1.5-flash       → 20 RPD, 15 RPM (fallback)
 *
 * We burn the high-quota model first, fall to smarter ones only when needed.
 */
// Strict 3.x Model Tiers with 2.5 Fallback
const MODEL_TIERS = [
    'gemini-3.1-flash-lite', // Tier 1: Primary high-volume workhorse (~500 RPD)
    'gemini-3.1-flash',      // Tier 2: Balanced mid-tier backup
    'gemini-3.5-flash',      // Tier 3: Emergency frontier backup (~20 RPD)
    'gemini-2.5-flash'       // Tier 4: Legacy stable fallback
];

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type SignalDirection = 'long' | 'short' | 'neutral';
export type MarketRegime = 'trending_bull' | 'trending_bear' | 'range_scalp' | 'breakout_pause';

export interface TechnicalIndicators {
    emaTrend: 'bullish' | 'bearish' | 'neutral';
    ema8: number;
    ema21: number;
    ema50: number;
    momentum1m: number;
    momentum5m: number;
    priceStructure: 'uptrend' | 'downtrend' | 'ranging';
    atr1m: number;
    atrPct: number;
    nearestResistance: number;
    nearestSupport: number;
    distanceToResistance: number;
    distanceToSupport: number;
    high24h: number;
    low24h: number;
    regime: MarketRegime;
    adx: number;
    volumeSpike: boolean;
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
    regime: MarketRegime;
    target_move: number;
    confidence: number;  // 0.0 = skip, 0.5-1.0 = trade
    reasoning: string;
}

// ─── REGIME CLASSIFIER ────────────────────────────────────────────────────────

function classifyRegime(indicators: TechnicalIndicators): MarketRegime {
    const { adx, atr1m, momentum5m, volumeSpike, priceStructure } = indicators;

    if (volumeSpike && atr1m > 150 && Math.abs(momentum5m) > 0.3) {
        return 'breakout_pause';
    }
    if (adx > 25 && priceStructure === 'uptrend')   return 'trending_bull';
    if (adx > 25 && priceStructure === 'downtrend') return 'trending_bear';
    return 'range_scalp';
}

// ─── LOCAL SIGNAL FALLBACK ────────────────────────────────────────────────────
/**
 * Pure-math fallback — no API required.
 * Called when every Gemini tier is exhausted or rate-limited.
 *
 * Logic:
 *  - trending_bull  → long on any pullback (momentum1m > -0.05)
 *  - trending_bear  → short on any bounce  (momentum1m < +0.05)
 *  - range_scalp    → buy near support, sell near resistance, mid = follow 1m momentum
 */
function localFallbackSignal(
    asset: MarketData,
    regime: MarketRegime
): GeneratedSignal {
    const { indicators, price, symbol } = asset;
    let direction: SignalDirection = 'neutral';
    let reasoning = '';

    if (regime === 'breakout_pause') {
        reasoning = 'LOCAL: Breakout pause — standing down';
    } else if (regime === 'trending_bull') {
        direction = 'long';
        reasoning = `LOCAL: Bull trend (ADX ${indicators.adx.toFixed(1)}) — riding uptrend`;
    } else if (regime === 'trending_bear') {
        direction = 'short';
        reasoning = `LOCAL: Bear trend (ADX ${indicators.adx.toFixed(1)}) — riding downtrend`;
    } else {
        // range_scalp
        const nearSupport = indicators.distanceToSupport < 30;
        const nearResistance = indicators.distanceToResistance < 30;
        if (nearSupport && !nearResistance) {
            direction = 'long';
            reasoning = `LOCAL: Near support $${indicators.nearestSupport.toFixed(0)} — scalp long`;
        } else if (nearResistance && !nearSupport) {
            direction = 'short';
            reasoning = `LOCAL: Near resistance $${indicators.nearestResistance.toFixed(0)} — fade spike`;
        } else {
            // mid-range: follow 1m momentum
            direction = indicators.momentum1m > 0 ? 'long' : 'short';
            reasoning = `LOCAL: Mid-range, momentum ${indicators.momentum1m.toFixed(4)}%`;
        }
    }

    // Target: $70 move for 40x leverage on small balance
    const target_move = 70.00;  // $70 = 0.10% move, sustainable with 40x
    const confidence = direction === 'neutral' ? 0.0 : 0.4;  // Local fallback = low confidence

    console.log(`[Signal] ⚙️  LOCAL fallback → ${direction.toUpperCase()} | $${target_move.toFixed(2)} target | conf=${confidence.toFixed(2)} | ${reasoning}`);

    return { symbol, direction, market_price: price, regime, target_move, confidence, reasoning };
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        try {
            const { indicators, price } = asset;
            const regime = classifyRegime(indicators);

            // ── HARD STOP: breakout pause ──────────────────────────────────
            if (regime === 'breakout_pause') {
                console.log(`[Signal] 🔴 BREAKOUT PAUSE — ATR $${indicators.atr1m.toFixed(0)}, volume spike. Standing down.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
                    target_move: 70,
                    confidence: 0.0,
                    regime,
                    reasoning: 'Macro breakout in progress — pausing to protect capital',
                });
                continue;
            }

            // ── PRE-FILTER: minimum ATR ────────────────────────────────────
            if (indicators.atr1m < 5) {
                console.log(`[Signal] ⏸️ ATR too low ($${indicators.atr1m.toFixed(2)}). Need > $5. Skipping.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
                    target_move: 70,
                    confidence: 0.0,
                    regime,
                    reasoning: 'ATR below minimum for $70 target',
                });
                continue;
            }

            // ── REGIME PROMPT BLOCK ───────────────────────────────────────
            let regimeInstructions = '';
            if (regime === 'range_scalp') {
                regimeInstructions = `
REGIME: RANGE SCALP
- Near support (within $${Math.min(20, indicators.distanceToSupport).toFixed(0)}): LONG
- Near resistance (within $${Math.min(20, indicators.distanceToResistance).toFixed(0)}): SHORT
- Mid-range: follow 1m momentum (positive=long, negative=short)
- NEVER return neutral in range scalp mode`;
            } else if (regime === 'trending_bull') {
                regimeInstructions = `REGIME: TRENDING BULL — only LONG on micro-pullbacks to EMA8`;
            } else if (regime === 'trending_bear') {
                regimeInstructions = `REGIME: TRENDING BEAR — only SHORT on micro-bounces to EMA8`;
            }

            // Session context: London peak (79% WR) vs NY (54% WR) vs Asia (low WR)
            const hour = new Date().getUTCHours();
            let sessionNote = '';
            if (hour >= 13 && hour < 16) sessionNote = 'LONDON/NY OVERLAP (79% WR) — strong momentum expected';
            else if (hour >= 16 && hour < 21) sessionNote = 'NEW YORK (54% WR—LOW) — require strong confluence only';
            else if (hour >= 9 && hour < 13) sessionNote = 'LONDON (71% WR) — trend-follow';
            else if (hour === 8) sessionNote = 'LONDON OPEN (DANGER) — stop hunts, avoid';
            else if (hour >= 21 || hour < 2) sessionNote = 'POST-NY/PRE-ASIA (LOW) — choppy, avoid breakouts';
            else sessionNote = 'ASIA (LOW WR) — tight ranges, avoid';

            // Keep prompt compact — every token costs quota
            const prompt = `You are a BTC perp scalper on Hyperliquid (40x leverage, $70 TP target, $140-200 SL).
SESSION: ${sessionNote}
DATA: Price=$${price.toFixed(2)} EMA8=$${indicators.ema8.toFixed(2)} EMA21=$${indicators.ema21.toFixed(2)} Mom1m=${indicators.momentum1m.toFixed(4)}% Mom5m=${indicators.momentum5m.toFixed(4)}% ATR=$${indicators.atr1m.toFixed(2)} Support=$${indicators.nearestSupport.toFixed(2)}(dist=$${indicators.distanceToSupport.toFixed(2)}) Resist=$${indicators.nearestResistance.toFixed(2)}(dist=$${indicators.distanceToResistance.toFixed(2)})
${regimeInstructions}
TARGET: $70 move (0.10% at ~$72k BTC). CONFIDENCE: output 0.0 to skip, 0.7-1.0 to trade.
Reply ONLY valid JSON array, no markdown:
[{"symbol":"${asset.symbol}","direction":"long","market_price":${price},"target_move":70.00,"confidence":0.75,"reasoning":"brief"}]`;

            // ── MODEL FAILOVER ────────────────────────────────────────────
            let result = null;
            let activeModel = '';

            for (const modelName of MODEL_TIERS) {
                try {
                    const m = genAI.getGenerativeModel({ model: modelName });
                    result = await m.generateContent(prompt);
                    activeModel = modelName;
                    break;
                } catch (apiErr: any) {
                    const code = apiErr?.status || apiErr?.code || '';
                    console.warn(`[Signal] ${modelName} unavailable (${code}). Trying next tier...`);
                }
            }

            // ── LOCAL FALLBACK when all API tiers exhausted ───────────────
            if (!result) {
                console.warn(`[Signal] ⚠️  All Gemini tiers exhausted — using local math fallback`);
                signals.push(localFallbackSignal(asset, regime));
                continue;
            }

            // ── PARSE RESPONSE ────────────────────────────────────────────
            const raw = result.response.text().trim();
            // Strip any markdown fences the model may emit despite instructions
            const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

            let parsed: Array<{
                symbol: string;
                direction: string;
                market_price: number;
                target_move?: number;
                confidence?: number;
                reasoning: string;
            }>;

            try {
                const maybeObj = JSON.parse(clean);
                // Model might return an object instead of array
                parsed = Array.isArray(maybeObj) ? maybeObj : [maybeObj];
            } catch {
                console.error(`[Signal] JSON parse failed via ${activeModel}: "${clean.slice(0, 120)}"`);
                // Fall through to local fallback rather than dropping the cycle
                signals.push(localFallbackSignal(asset, regime));
                continue;
            }

            for (const sig of parsed) {
                const dir = sig.direction as SignalDirection;
                if (!['long', 'short', 'neutral'].includes(dir)) {
                    console.warn(`[Signal] Invalid direction "${sig.direction}" — falling back locally`);
                    signals.push(localFallbackSignal(asset, regime));
                    continue;
                }

                // Enforce $70 TP from Gemini (or fallback to $70)
                const targetMove = 70.00;
                const conf = typeof sig.confidence === 'number' ? Math.max(0, Math.min(1, sig.confidence)) : 0.5;

                // Skip if confidence is 0.0
                if (conf === 0.0) {
                    console.log(`[Signal] [${activeModel}] SKIPPED ${dir.toUpperCase()} (confidence=0.0) — ${sig.reasoning}`);
                    continue;
                }

                console.log(`[Signal] [${activeModel}] ${dir.toUpperCase()} +$${targetMove.toFixed(2)} | conf=${conf.toFixed(2)} | ${sig.reasoning}`);

                signals.push({
                    symbol: sig.symbol,
                    direction: dir,
                    market_price: sig.market_price,
                    target_move: targetMove,
                    confidence: conf,
                    regime,
                    reasoning: sig.reasoning,
                });
            }

        } catch (error) {
            console.error(`[Signal] Error processing ${asset.symbol}:`, error);
        }
    }

    return signals;
}
