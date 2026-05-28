import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const MODEL_TIERS = [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
];

export type SignalDirection = 'long' | 'short' | 'neutral';
export type MarketRegime = 'trending_bull' | 'trending_bear' | 'range_scalp' | 'breakout_pause';

export interface TechnicalIndicators {
    emaTrend: 'bullish' | 'bearish' | 'neutral';
    ema8: number;
    ema21: number;
    ema50: number;
    momentum1m: number;
    momentum5m: number;
    momentum15m: number;   // NEW: 15m trend context
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
    trendBias: 'bull' | 'bear' | 'neutral'; // NEW: 4h-level trend bias
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
    confidence: number;
    reasoning: string;
}

// ─── TRADING HOURS GATE ───────────────────────────────────────────────────────
// Based on empirical BTC session win rates. Only trade high-probability windows.
function getTradingSession(): { active: boolean; label: string } {
    const hour = new Date().getUTCHours();
    if (hour === 8) return { active: false, label: 'LONDON OPEN (stop hunts — skip)' };
    if (hour >= 9 && hour < 13)  return { active: true,  label: 'LONDON (71% WR)' };
    if (hour >= 13 && hour < 17) return { active: true,  label: 'LONDON/NY OVERLAP (79% WR)' };
    if (hour >= 17 && hour < 21) return { active: true,  label: 'NEW YORK (54% WR — conf≥0.75 only)' };
    return { active: false, label: 'ASIA/OFF-HOURS (low WR — skip)' };
}

// ─── REGIME CLASSIFIER ────────────────────────────────────────────────────────
function classifyRegime(indicators: TechnicalIndicators): MarketRegime {
    const { adx, atr1m, momentum5m, volumeSpike, priceStructure, trendBias } = indicators;
    if (volumeSpike && atr1m > 150 && Math.abs(momentum5m) > 0.3) return 'breakout_pause';
    // Use trendBias as tiebreaker — prevents calling ranging market a bull when 4h is bearish
    if (adx > 22 && priceStructure === 'uptrend'   && trendBias !== 'bear') return 'trending_bull';
    if (adx > 22 && priceStructure === 'downtrend' && trendBias !== 'bull') return 'trending_bear';
    if (adx > 22 && trendBias === 'bear') return 'trending_bear'; // macro overrides
    if (adx > 22 && trendBias === 'bull') return 'trending_bull';
    return 'range_scalp';
}

// ─── LOCAL FALLBACK ───────────────────────────────────────────────────────────
function localFallbackSignal(asset: MarketData, regime: MarketRegime): GeneratedSignal {
    const { indicators, price, symbol } = asset;
    let direction: SignalDirection = 'neutral';
    let reasoning = '';

    if (regime === 'breakout_pause') {
        reasoning = 'LOCAL: Breakout pause';
    } else if (regime === 'trending_bull') {
        // Only long if 15m momentum confirms — not into a local top
        direction = indicators.momentum15m > -0.05 ? 'long' : 'neutral';
        reasoning = `LOCAL: Bull (ADX ${indicators.adx.toFixed(1)}) mom15m=${indicators.momentum15m.toFixed(3)}%`;
    } else if (regime === 'trending_bear') {
        // Only short if 15m momentum confirms — not into a local bottom
        direction = indicators.momentum15m < 0.05 ? 'short' : 'neutral';
        reasoning = `LOCAL: Bear (ADX ${indicators.adx.toFixed(1)}) mom15m=${indicators.momentum15m.toFixed(3)}%`;
    } else {
        const nearSupport    = indicators.distanceToSupport < 25;
        const nearResistance = indicators.distanceToResistance < 25;
        if (nearSupport && !nearResistance && indicators.trendBias !== 'bear') {
            direction = 'long';
            reasoning = `LOCAL: Near support $${indicators.nearestSupport.toFixed(0)}`;
        } else if (nearResistance && !nearSupport && indicators.trendBias !== 'bull') {
            direction = 'short';
            reasoning = `LOCAL: Near resistance $${indicators.nearestResistance.toFixed(0)}`;
        } else {
            // Mid-range: only trade if both 1m and 15m momentum agree
            const mom1mBull  = indicators.momentum1m > 0.005;
            const mom15mBull = indicators.momentum15m > 0;
            if (mom1mBull && mom15mBull && indicators.trendBias !== 'bear') {
                direction = 'long';
                reasoning = `LOCAL: Mom confluence long (1m=${indicators.momentum1m.toFixed(3)}% 15m=${indicators.momentum15m.toFixed(3)}%)`;
            } else if (!mom1mBull && !mom15mBull && indicators.trendBias !== 'bull') {
                direction = 'short';
                reasoning = `LOCAL: Mom confluence short`;
            } else {
                direction = 'neutral'; // no confluence = no trade
                reasoning = `LOCAL: No momentum confluence — skip`;
            }
        }
    }

    const confidence = direction === 'neutral' ? 0.0 : 0.45;
    console.log(`[Signal] ⚙️  LOCAL → ${direction.toUpperCase()} | conf=${confidence} | ${reasoning}`);
    return { symbol, direction, market_price: price, regime, target_move: 70, confidence, reasoning };
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        try {
            const { indicators, price } = asset;

            // ── SESSION GATE ───────────────────────────────────────────────
            const session = getTradingSession();
            if (!session.active) {
                console.log(`[Signal] 🌙 ${session.label} — skipping cycle`);
                signals.push({ symbol: asset.symbol, direction: 'neutral', market_price: price,
                    target_move: 70, confidence: 0, regime: 'range_scalp', reasoning: session.label });
                continue;
            }
            console.log(`[Signal] 🕐 Session: ${session.label}`);

            const regime = classifyRegime(indicators);

            if (regime === 'breakout_pause') {
                console.log(`[Signal] 🔴 BREAKOUT PAUSE — standing down`);
                signals.push({ symbol: asset.symbol, direction: 'neutral', market_price: price,
                    target_move: 70, confidence: 0, regime, reasoning: 'Breakout pause' });
                continue;
            }

            if (indicators.atr1m < 5) {
                signals.push({ symbol: asset.symbol, direction: 'neutral', market_price: price,
                    target_move: 70, confidence: 0, regime, reasoning: 'ATR too low' });
                continue;
            }

            // ── REGIME CONTEXT FOR PROMPT ──────────────────────────────────
            let regimeContext = '';
            if (regime === 'trending_bull') {
                regimeContext = `TREND: BULL (ADX ${indicators.adx.toFixed(1)}, 4h bias: ${indicators.trendBias}). Only LONG on pullbacks to EMA8. Do not short.`;
            } else if (regime === 'trending_bear') {
                regimeContext = `TREND: BEAR (ADX ${indicators.adx.toFixed(1)}, 4h bias: ${indicators.trendBias}). Only SHORT on bounces to EMA8. Do not long. This is critical — the macro trend is down.`;
            } else {
                regimeContext = `REGIME: RANGE SCALP (ADX ${indicators.adx.toFixed(1)}, 4h bias: ${indicators.trendBias}).
Rules: near support=$${indicators.nearestSupport.toFixed(0)}(dist=$${indicators.distanceToSupport.toFixed(0)}) → LONG only if trendBias≠bear. near resist=$${indicators.nearestResistance.toFixed(0)}(dist=$${indicators.distanceToResistance.toFixed(0)}) → SHORT only if trendBias≠bull. Mid-range: require 1m AND 15m momentum agreement.`;
            }

            const isNYSession = new Date().getUTCHours() >= 17;
            const confThreshold = isNYSession ? 0.75 : 0.60;

            const prompt = `You are a BTC perp scalper. Leverage=40x. TP=$70 move. SL=$70 move (1:1 R:R).
${regimeContext}
PRICE: $${price.toFixed(2)} | EMA8=$${indicators.ema8.toFixed(2)} EMA21=$${indicators.ema21.toFixed(2)}
MOM: 1m=${indicators.momentum1m.toFixed(4)}% 5m=${indicators.momentum5m.toFixed(4)}% 15m=${indicators.momentum15m.toFixed(4)}%
ATR=$${indicators.atr1m.toFixed(2)} | Session: ${getTradingSession().label}
CRITICAL: If trend is bear, SHORT is the only valid direction. Do not fight macro.
Confidence 0.0=skip, 0.6-1.0=trade. Require ≥${confThreshold} to execute.
Reply ONLY valid JSON array:
[{"symbol":"${asset.symbol}","direction":"long","market_price":${price},"target_move":70,"confidence":0.70,"reasoning":"brief"}]`;

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

            if (!result) {
                console.warn(`[Signal] ⚠️  All tiers exhausted — local fallback`);
                signals.push(localFallbackSignal(asset, regime));
                continue;
            }

            const raw   = result.response.text().trim();
            const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

            let parsed: Array<{ symbol: string; direction: string; market_price: number; target_move?: number; confidence?: number; reasoning: string }>;
            try {
                const maybeObj = JSON.parse(clean);
                parsed = Array.isArray(maybeObj) ? maybeObj : [maybeObj];
            } catch {
                console.error(`[Signal] JSON parse failed: "${clean.slice(0, 120)}"`);
                signals.push(localFallbackSignal(asset, regime));
                continue;
            }

            for (const sig of parsed) {
                const dir  = sig.direction as SignalDirection;
                const conf = typeof sig.confidence === 'number' ? Math.max(0, Math.min(1, sig.confidence)) : 0.5;

                if (!['long', 'short', 'neutral'].includes(dir)) {
                    signals.push(localFallbackSignal(asset, regime));
                    continue;
                }

                // Hard block: don't long in trending bear, don't short in trending bull
                if (regime === 'trending_bear' && dir === 'long') {
                    console.warn(`[Signal] ⛔ Gemini said LONG but regime=trending_bear — overriding to neutral`);
                    signals.push({ symbol: sig.symbol, direction: 'neutral', market_price: sig.market_price,
                        target_move: 70, confidence: 0, regime, reasoning: 'Direction blocked by bear regime' });
                    continue;
                }
                if (regime === 'trending_bull' && dir === 'short') {
                    console.warn(`[Signal] ⛔ Gemini said SHORT but regime=trending_bull — overriding to neutral`);
                    signals.push({ symbol: sig.symbol, direction: 'neutral', market_price: sig.market_price,
                        target_move: 70, confidence: 0, regime, reasoning: 'Direction blocked by bull regime' });
                    continue;
                }

                if (conf < confThreshold) {
                    console.log(`[Signal] [${activeModel}] SKIPPED (conf=${conf.toFixed(2)} < ${confThreshold}) — ${sig.reasoning}`);
                    continue;
                }

                console.log(`[Signal] [${activeModel}] ${dir.toUpperCase()} +$70 | conf=${conf.toFixed(2)} | ${sig.reasoning}`);
                signals.push({ symbol: sig.symbol, direction: dir, market_price: sig.market_price,
                    target_move: 70, confidence: conf, regime, reasoning: sig.reasoning });
            }

        } catch (error) {
            console.error(`[Signal] Error processing ${asset.symbol}:`, error);
        }
    }

    return signals;
}
