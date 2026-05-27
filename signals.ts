import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── GEMINI CLIENT & FAILOVER TIERS ───────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Use the 3.x infrastructure you have access to
const MODEL_TIERS = [
    'gemini-3.1-flash-lite', // Primary engine (500 requests/day)
    'gemini-3.5-flash'       // Emergency backup (20 requests/day)
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
    target_move: number; // The dynamic TP target ($50 to $80)
    reasoning: string;
}

// ─── REGIME CLASSIFIER ───────────────────────────────────────────────────────

function classifyRegime(indicators: TechnicalIndicators): MarketRegime {
    const { adx, atr1m, momentum5m, volumeSpike, priceStructure } = indicators;

    if (volumeSpike && atr1m > 150 && Math.abs(momentum5m) > 0.3) {
        return 'breakout_pause';
    }

    if (adx > 25 && priceStructure === 'uptrend') return 'trending_bull';
    if (adx > 25 && priceStructure === 'downtrend') return 'trending_bear';

    return 'range_scalp';
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    for (const asset of assets) {
        try {
            const { indicators, price } = asset;
            const regime = classifyRegime(indicators);

            // ── HARD STOP: Breakout pause only ────────────────────────────────
            if (regime === 'breakout_pause') {
                console.log(`[Signal] 🔴 BREAKOUT PAUSE — ATR $${indicators.atr1m.toFixed(0)}, Volume spike. Standing down.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
                    target_move: 50,
                    regime,
                    reasoning: 'Macro breakout in progress — pausing to protect capital',
                });
                continue;
            }

            // ── PRE-FILTER: BTC-specific minimums ─────────────────────────────
            if (indicators.atr1m < 5) {
                console.log(`[Signal] ⏸️ ATR too low ($${indicators.atr1m.toFixed(2)}). Need > $5. Skipping.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
                    target_move: 50,
                    regime,
                    reasoning: 'ATR below minimum for $50 target',
                });
                continue;
            }

            // ── BUILD REGIME-SPECIFIC PROMPT ──────────────────────────────────
            let regimeInstructions = '';

            if (regime === 'range_scalp') {
                regimeInstructions = `
REGIME: RANGE SCALP MODE
Bitcoin is oscillating in a range. Your job is continuous micro-scalping:
- If price is NEAR SUPPORT (within $${Math.min(20, indicators.distanceToSupport).toFixed(0)}): Generate LONG — buy the dip
- If price is NEAR RESISTANCE (within $${Math.min(20, indicators.distanceToResistance).toFixed(0)}): Generate SHORT — fade the spike
- If price is MID-RANGE: Use momentum direction (1m momentum positive = LONG, negative = SHORT)
- NEVER return neutral during range scalp mode unless the range itself is collapsing
`;
            } else if (regime === 'trending_bull') {
                regimeInstructions = `
REGIME: TRENDING BULL
Strong uptrend confirmed. Only generate LONG signals on micro-pullbacks toward EMA8.
`;
            } else if (regime === 'trending_bear') {
                regimeInstructions = `
REGIME: TRENDING BEAR  
Strong downtrend confirmed. Only generate SHORT signals on micro-bounces toward EMA8.
`;
            }

            const prompt = `
You are the high-frequency signal desk of ModuVise, trading Bitcoin perpetual futures on Hyperliquid.

LIVE MARKET DATA (${asset.symbol}):
Price: $${price.toFixed(2)}
EMA8: $${indicators.ema8.toFixed(2)} | EMA21: $${indicators.ema21.toFixed(2)}
1m Momentum: ${indicators.momentum1m.toFixed(4)}% | 5m Momentum: ${indicators.momentum5m.toFixed(4)}%
ATR (1m): $${indicators.atr1m.toFixed(2)}
Nearest Support: $${indicators.nearestSupport.toFixed(2)} (distance: $${indicators.distanceToSupport.toFixed(2)})
Nearest Resistance: $${indicators.nearestResistance.toFixed(2)} (distance: $${indicators.distanceToResistance.toFixed(2)})

${regimeInstructions}

TARGET DIRECTIVE:
Calculate a dynamic 'target_move' between $50.00 and $80.00 based on the current 1m ATR ($${indicators.atr1m.toFixed(2)}). 
- NEVER output less than 50.00.
- If volatility/ATR is high, push the target up to 80.00.
- If volatility is standard, default to the baseline 50.00.

Respond ONLY with valid JSON. No markdown. No explanation.
[{"symbol":"${asset.symbol}","direction":"long","market_price":${price},"target_move":65.00,"reasoning":"brief reason"}]
Direction must be exactly: "long", "short", or "neutral"
            `;

            // ── DYNAMIC 3-TIER MODEL FAILOVER ─────────────────────────────────
            let result = null;
            let activeModelUsed = '';

            for (const modelName of MODEL_TIERS) {
                try {
                    const modelInstance = genAI.getGenerativeModel({ model: modelName });
                    result = await modelInstance.generateContent(prompt);
                    activeModelUsed = modelName;
                    break; // Request successful, exit the retry loop
                } catch (apiError: any) {
                    console.warn(`[Signal] Model ${modelName} unavailable/rate-limited. Shifting to next tier...`);
                }
            }

            // Hard stop if all models are exhausted
            if (!result) {
                console.error(`[Signal Error] All Gemini API tiers exhausted. Yielding neutral loop.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
                    target_move: 50.00,
                    regime,
                    reasoning: 'Google API quota bottleneck',
                });
                continue;
            }

            const text = result.response.text().trim().replace(/```json|```/g, '').trim();

            let parsed: Array<{ symbol: string; direction: string; market_price: number; target_move?: number; reasoning: string }>;
            try {
                parsed = JSON.parse(text);
            } catch {
                console.error(`[Signal] JSON parse failed via ${activeModelUsed}: ${text.slice(0, 100)}`);
                // CRITICAL FIX: If parsing fails, do not continue down to iterate over an undefined array.
                continue; 
            }

            // Only attempt to iterate if parsed is an actual array
            if (!Array.isArray(parsed)) {
                console.error(`[Signal] Model returned valid JSON, but not an Array: ${text.slice(0, 50)}`);
                continue;
            }

            for (const sig of parsed) {
                const dir = sig.direction as SignalDirection;
                if (!['long', 'short', 'neutral'].includes(dir)) {
                    console.warn(`[Signal] Invalid direction "${sig.direction}" — skipping`);
                    continue;
                }

                // Guardrails: ensure target is strictly between $50 and $80
                let dynamicMove = Number(sig.target_move) || 50.00;
                if (dynamicMove < 50.00) dynamicMove = 50.00;
                if (dynamicMove > 80.00) dynamicMove = 80.00;

                console.log(`[Signal] [via ${activeModelUsed}] ${dir.toUpperCase()} targetting +$${dynamicMove.toFixed(2)} | ${sig.reasoning}`);

                signals.push({
                    symbol: sig.symbol,
                    direction: dir,
                    market_price: sig.market_price,
                    target_move: dynamicMove,
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