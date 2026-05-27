import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type SignalDirection = 'long' | 'short' | 'neutral';
export type MarketRegime = 'trending_bull' | 'trending_bear' | 'range_scalp' | 'breakout_pause';

export interface TechnicalIndicators {
    emaTrend: 'bullish' | 'bearish' | 'neutral';
    ema8: number;
    ema21: number;
    ema50: number;
    momentum1m: number;    // 1-minute momentum %
    momentum5m: number;    // 5-minute momentum %
    priceStructure: 'uptrend' | 'downtrend' | 'ranging';
    atr1m: number;         // ATR on 1m candles — BTC moves ~$20-80 per 1m
    atrPct: number;
    nearestResistance: number;
    nearestSupport: number;
    distanceToResistance: number;
    distanceToSupport: number;
    high24h: number;
    low24h: number;
    regime: MarketRegime;
    adx: number;           // ADX for trend strength
    volumeSpike: boolean;  // Volume > 2x average = potential breakout
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
    reasoning: string;
}

// ─── GEMINI CLIENT ────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ─── REGIME CLASSIFIER ───────────────────────────────────────────────────────

/**
 * Classify market regime before calling Gemini
 * This determines which signal logic to apply
 */
function classifyRegime(indicators: TechnicalIndicators): MarketRegime {
    const { adx, atr1m, momentum5m, volumeSpike, priceStructure } = indicators;

    // Breakout pause: massive volume + price expanding vertically
    // During these windows we pause — risk too asymmetric for $50 scalps
    if (volumeSpike && atr1m > 150 && Math.abs(momentum5m) > 0.3) {
        return 'breakout_pause';
    }

    // Strong trend: ADX > 25 + clear EMA alignment
    if (adx > 25 && priceStructure === 'uptrend') return 'trending_bull';
    if (adx > 25 && priceStructure === 'downtrend') return 'trending_bear';

    // Everything else = range scalp mode
    // BTC breathes $30-80 continuously even in "flat" sessions
    return 'range_scalp';
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────

export async function generateSignals(assets: MarketData[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    for (const asset of assets) {
        try {
            const { indicators, price } = asset;
            const regime = classifyRegime(indicators);

            // ── HARD STOP: Breakout pause only ────────────────────────────────
            // We only pause during extreme macro expansion
            // Range + trending = always trade
            if (regime === 'breakout_pause') {
                console.log(`[Signal] 🔴 BREAKOUT PAUSE — ATR $${indicators.atr1m.toFixed(0)}, Volume spike detected. Standing down.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
                    regime,
                    reasoning: 'Macro breakout in progress — pausing to protect capital',
                });
                continue;
            }

            // ── PRE-FILTER: BTC-specific minimums ─────────────────────────────

            // ATR floor: BTC 1m ATR should be > $5 to support $50 TP
            // Below $5 = dead market, spread kills the trade
            if (indicators.atr1m < 5) {
                console.log(`[Signal] ⏸️ ATR too low ($${indicators.atr1m.toFixed(2)}). Need > $5. Skipping.`);
                signals.push({
                    symbol: asset.symbol,
                    direction: 'neutral',
                    market_price: price,
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
Target: $50 BTC move. In a $${(indicators.high24h - indicators.low24h).toFixed(0)} daily range, $50 moves happen every few minutes.
`;
            } else if (regime === 'trending_bull') {
                regimeInstructions = `
REGIME: TRENDING BULL
Strong uptrend confirmed (ADX: ${indicators.adx.toFixed(1)}). Only generate LONG signals.
Enter on micro-pullbacks toward EMA8 ($${indicators.ema8.toFixed(2)}).
Avoid SHORT — trend is your friend. Only neutral if price is pausing right at resistance.
`;
            } else if (regime === 'trending_bear') {
                regimeInstructions = `
REGIME: TRENDING BEAR  
Strong downtrend confirmed (ADX: ${indicators.adx.toFixed(1)}). Only generate SHORT signals.
Enter on micro-bounces toward EMA8 ($${indicators.ema8.toFixed(2)}).
Avoid LONG — trend is your friend. Only neutral if price is pausing right at support.
`;
            }

            const prompt = `
You are the high-frequency signal desk of ModuVise, trading Bitcoin perpetual futures on Hyperliquid.

STRATEGY PARAMETERS:
- Balance: $21.83 | Leverage: 40x | Position: leverage x balance = $873.20 max position size
- Target: $50 BTC price move = +$0.25 gross (+0.0625% on position)
- Fees: 0.015% maker entry + 0.015% maker exit = $0.12 total
- Net profit per win: +$0.13 (1.30% ROI on balance)
- Stop Loss: $300 adverse BTC move (configured separately)
- Frequency target: 100-200 trades per 24 hours

LIVE MARKET DATA (${asset.symbol}):
Price: $${price.toFixed(2)}
24h Change: ${asset.change_24h.toFixed(3)}%
24h Range: $${indicators.low24h.toFixed(2)} — $${indicators.high24h.toFixed(2)} (width: $${(indicators.high24h - indicators.low24h).toFixed(0)})
EMA8: $${indicators.ema8.toFixed(2)} | EMA21: $${indicators.ema21.toFixed(2)} | EMA50: $${indicators.ema50.toFixed(2)}
EMA Trend: ${indicators.emaTrend}
1m Momentum: ${indicators.momentum1m.toFixed(4)}%
5m Momentum: ${indicators.momentum5m.toFixed(4)}%
ATR (1m): $${indicators.atr1m.toFixed(2)}
ADX: ${indicators.adx.toFixed(1)}
Nearest Support: $${indicators.nearestSupport.toFixed(2)} (distance: $${indicators.distanceToSupport.toFixed(2)})
Nearest Resistance: $${indicators.nearestResistance.toFixed(2)} (distance: $${indicators.distanceToResistance.toFixed(2)})
Volume Spike: ${indicators.volumeSpike}

${regimeInstructions}

DECISION:
Generate a trade signal. Remember: Bitcoin NEVER stops moving. There is almost always a $50 move available.
Only say neutral if you genuinely cannot determine direction AND the range is collapsing below $30 daily range.

Respond ONLY with valid JSON. No markdown. No explanation. No backticks.
[{"symbol":"${asset.symbol}","direction":"long","market_price":${price},"reasoning":"brief reason"}]
Direction must be exactly: "long", "short", or "neutral"
            `;

            const result = await model.generateContent(prompt);
            const text = result.response.text().trim().replace(/```json|```/g, '').trim();

            let parsed: Array<{ symbol: string; direction: string; market_price: number; reasoning: string }>;
            try {
                parsed = JSON.parse(text);
            } catch {
                console.error(`[Signal] JSON parse failed: ${text.slice(0, 100)}`);
                continue;
            }

            for (const sig of parsed) {
                const dir = sig.direction as SignalDirection;
                if (!['long', 'short', 'neutral'].includes(dir)) {
                    console.warn(`[Signal] Invalid direction "${sig.direction}" — skipping`);
                    continue;
                }

                console.log(`[Signal] ${dir.toUpperCase()} @ $${sig.market_price} | Regime: ${regime} | ${sig.reasoning}`);

                signals.push({
                    symbol: sig.symbol,
                    direction: dir,
                    market_price: sig.market_price,
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
