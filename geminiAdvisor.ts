import * as dotenv from 'dotenv';
import * as fs    from 'fs';
dotenv.config();

// ─── GEMINI ADVISOR ───────────────────────────────────────────────────────────
// Reinforcement-learning-style feedback loop using Gemini as the reasoning engine.
//
// Three roles:
//
//  1. POST-TRADE ANALYST: after every SL hit, reads the full tradeLog.jsonl entry
//     for that trade and returns a structured diagnosis — which gate failed, why
//     the TP wasn't hit, what the market was doing. Writes findings to context.json.
//
//  2. PERIODIC TUNER: every 25 trades, reads the aggregate log and recommends
//     parameter adjustments (ATR ceiling, momentum trap threshold, wall notional,
//     oscillation thresholds). Writes proposed changes to pendingChanges.json.
//     NEVER auto-deploys — requires human Telegram approval.
//
//  3. KILL SWITCH MONITOR: if cumulative realized loss exceeds KILL_THRESHOLD_USD
//     ($1000), sends Telegram alert and writes a kill signal. main.ts reads this
//     and shuts down gracefully.
//
// API key rotation: tries GEMINI_API_KEY first, falls back to GEMINI_API_KEY2
// if rate-limited (429 / quota exhausted). Free tier: 15 RPM on Flash.

const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY  ?? '',
    process.env.GEMINI_API_KEY2 ?? '',
].filter(k => k.length > 0);

// Best available free-tier models in priority order
const MODELS = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
];

const CONTEXT_FILE        = process.env.CONTEXT_FILE        ?? './geminiContext.json';
const PENDING_CHANGES_FILE = process.env.PENDING_CHANGES_FILE ?? './pendingChanges.json';
const TRADE_LOG_FILE      = process.env.TRADE_LOG_FILE      ?? './tradeLog.jsonl';
const KILL_THRESHOLD_USD  = Number(process.env.KILL_THRESHOLD_USD ?? 1000);
const TUNE_EVERY_N_TRADES = 25;

// ─── CONTEXT FILE ─────────────────────────────────────────────────────────────
// Persists Gemini's running understanding of the bot's performance.
// Updated after every analysis so Gemini always has full history on next call.
interface GeminiContext {
    totalTrades:        number;
    totalWins:          number;
    totalLosses:        number;
    totalRealizedPnl:   number;
    cumulativeLoss:     number;   // absolute loss tracker for kill switch
    lastAnalysisAt:     string;
    recentDiagnoses:    Array<{
        tradeId:    string;
        outcome:    string;
        gateFailed: string;
        note:       string;
        ts:         string;
    }>;
    pendingTuneAt:      number;   // trade count at which next tune fires
    killSwitchTripped:  boolean;
}

function loadContext(): GeminiContext {
    try {
        if (fs.existsSync(CONTEXT_FILE)) {
            return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
        }
    } catch { /* start fresh */ }
    return {
        totalTrades:       0,
        totalWins:         0,
        totalLosses:       0,
        totalRealizedPnl:  0,
        cumulativeLoss:    0,
        lastAnalysisAt:    '',
        recentDiagnoses:   [],
        pendingTuneAt:     TUNE_EVERY_N_TRADES,
        killSwitchTripped: false,
    };
}

function saveContext(ctx: GeminiContext): void {
    try {
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
    } catch (e: any) {
        console.error(`[Gemini] Context save failed: ${e.message}`);
    }
}

// ─── API CALLER ───────────────────────────────────────────────────────────────
async function callGemini(prompt: string): Promise<string> {
    // HARD KILL SWITCH (2026-07-22): the free-tier Gemini API is exhausted and was
    // spamming "[Gemini] Rate limited — rotating" on every trade, burning request
    // budget for zero value. Disabled unless GEMINI_ENABLED=true is explicitly set.
    // The flight recorder already writes a per-trade verdict; this advisor is dead
    // weight. No network call is made below unless re-enabled on purpose.
    if ((process.env.GEMINI_ENABLED ?? 'false') !== 'true') {
        throw new Error('Gemini disabled (GEMINI_ENABLED != true)');
    }
    for (const key of GEMINI_KEYS) {
        for (const model of MODELS) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
                const res = await fetch(url, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature:     0.2,   // low temp = consistent analysis
                            maxOutputTokens: 1024,
                        },
                    }),
                    signal: AbortSignal.timeout(30_000),
                });

                if (res.status === 429) {
                    console.warn(`[Gemini] Rate limited on key ending ...${key.slice(-4)} model ${model} — rotating`);
                    break; // try next key
                }

                const data: any = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                if (!text) throw new Error(`Empty response from ${model}`);

                console.log(`[Gemini] ✅ Response via ${model} (key ...${key.slice(-4)})`);
                return text;

            } catch (e: any) {
                console.warn(`[Gemini] ${model} failed: ${e.message}`);
            }
        }
    }
    throw new Error('[Gemini] All keys and models exhausted');
}

// ─── POST-TRADE ANALYSIS ──────────────────────────────────────────────────────
export async function analyseFailedTrade(tradeEntry: any, sendAlert: (msg: string) => Promise<void>): Promise<void> {
    const ctx = loadContext();

    const prompt = `You are a trading bot post-mortem analyst. Your job is to explain exactly why this trade lost money and which safety gate should have blocked it.

GOAL: The bot targets a $0.05–$0.20 price move on XAUUSDT (gold futures). It enters with a maker limit order and aims to exit at a small TP. A loss means price moved significantly against the position before TP was hit.

TRADE LOG ENTRY:
${JSON.stringify(tradeEntry, null, 2)}

AVAILABLE GATES (what the bot checks before entering):
1. ATR ceiling: blocks if 5m ATR > $6.00 (market too volatile for micro-scalp)
2. Spread block: blocks if spread > $0.15
3. Low conviction: blocks if OB imbalance AND momentum both weak
4. Momentum trap: blocks if strong momentum AGAINST direction (> $0.50 on 5m)
5. Wall check: requires resting order book wall within $0.50 of price
6. Oscillation gate: requires last 4 candles to be choppy/ranging not trending
7. Velocity guard: blocks if sell/buy volume ratio > 3x in last 5 seconds

RECENT PERFORMANCE CONTEXT:
${JSON.stringify(ctx.recentDiagnoses.slice(-5), null, 2)}

YOU MUST respond with ONLY raw JSON. No markdown. No code blocks. No explanation. Start your response with { and end with }.
{
  "gateFailed": "name of the gate that should have blocked this (or 'none — bad luck' if all gates passed correctly)",
  "gateAdjustment": "specific threshold change to prevent this in future, e.g. 'raise ATR ceiling to $5.00' or 'tighten momentum trap to $0.30'",
  "marketCondition": "one sentence describing what the market was doing when entry filled",
  "whyTpMissed": "one sentence explaining why price moved against position instead of hitting TP",
  "severity": "low | medium | high",
  "note": "one crisp sentence summary for the log"
}`;

    try {
        const raw      = await callGemini(prompt);
        // Strip markdown fences if Gemini wraps in ```json ... ```
        const stripped = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const match    = stripped.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON in Gemini response');
        const analysis = JSON.parse(match[0]);

        console.log(`[Gemini] 🔍 Post-mortem: gate=${analysis.gateFailed} | ${analysis.note}`);

        // Update context
        ctx.recentDiagnoses.push({
            tradeId:    tradeEntry.id ?? 'unknown',
            outcome:    tradeEntry.outcome ?? 'sl',
            gateFailed: analysis.gateFailed,
            note:       analysis.note,
            ts:         new Date().toISOString(),
        });
        // Keep only last 50 diagnoses
        if (ctx.recentDiagnoses.length > 50) ctx.recentDiagnoses = ctx.recentDiagnoses.slice(-50);
        ctx.lastAnalysisAt = new Date().toISOString();
        saveContext(ctx);

        await sendAlert(
            `🔍 Gemini Post-Mortem:\n` +
            `Gate: ${analysis.gateFailed}\n` +
            `Fix: ${analysis.gateAdjustment}\n` +
            `Why: ${analysis.whyTpMissed}\n` +
            `Severity: ${analysis.severity}`
        );

    } catch (e: any) {
        console.error(`[Gemini] Post-mortem failed: ${e.message}`);
    }
}

// ─── PERIODIC PARAMETER TUNER ─────────────────────────────────────────────────
export async function runPeriodicTune(sendAlert: (msg: string) => Promise<void>): Promise<void> {
    // Read last N trade log entries
    let recentTrades: any[] = [];
    try {
        const lines = fs.readFileSync(TRADE_LOG_FILE, 'utf-8')
            .split('\n').filter(l => l.trim())
            .map(l => JSON.parse(l))
            .filter(e => e.phase === 'closed');
        recentTrades = lines.slice(-TUNE_EVERY_N_TRADES);
    } catch (e: any) {
        console.error(`[Gemini] Tune: failed to read trade log: ${e.message}`);
        return;
    }

    if (recentTrades.length < 10) {
        console.log(`[Gemini] Tune: not enough closed trades yet (${recentTrades.length}/10 minimum)`);
        return;
    }

    const ctx = loadContext();

    const prompt = `You are a trading bot parameter optimizer. Analyse these ${recentTrades.length} recent closed trades and recommend specific parameter adjustments to improve profitability.

CURRENT PARAMETERS:
- ATR ceiling: $6.00 (blocks entry if 5m ATR above this)
- Momentum trap threshold: $0.50 (blocks if 5m momentum > this against direction)
- Wall minimum notional: $20,000 (requires this much resting liquidity near entry)
- Oscillation body/range max: 0.40 (max candle body as fraction of range)
- Oscillation net move max: $1.50 per candle
- Oscillation overlap required: 67% of consecutive candle pairs must overlap
- Velocity flush ratio: 3.0x (sell/buy ratio threshold for blocking longs)
- TP1 timeout: 90 seconds
- TP2 offset: $0.10 from entry
- TP2 timeout: 30 seconds

RECENT TRADE LOG (last ${recentTrades.length} closed trades):
${JSON.stringify(recentTrades.map(t => ({
    direction:      t.direction,
    outcome:        t.outcome,
    exitPhase:      t.exitPhase,
    durationMs:     t.durationMs,
    realizedPnl:    t.realizedPnl,
    atr5m:          t.atr5m,
    obImbalance:    t.obImbalance,
    momentum5m:     t.momentum5m,
    spread:         t.spread,
    regime:         t.regime,
    postMortem:     t.postMortem,
})), null, 2)}

PREVIOUS DIAGNOSES:
${JSON.stringify(ctx.recentDiagnoses.slice(-10), null, 2)}

YOU MUST respond with ONLY raw JSON. No markdown. No code blocks. No explanation. Start your response with { and end with }.
{
  "summary": "2-sentence summary of what patterns you see across these trades",
  "winRate": 0.72,
  "avgWinPnl": 0.005,
  "avgLossPnl": -0.015,
  "recommendations": [
    {
      "parameter": "ATR_CEILING",
      "currentValue": 6.00,
      "recommendedValue": 5.00,
      "reasoning": "3 of 5 losses occurred with ATR between $5-6, suggesting $5 is safer ceiling"
    }
  ],
  "overallAssessment": "one sentence on whether the strategy is working and what the biggest improvement opportunity is"
}`;

    try {
        const raw  = await callGemini(prompt);
        const stripped2 = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const match = stripped2.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON in response');
        const tune  = JSON.parse(match[0]);

        console.log(`[Gemini] 🎯 Tune complete: win rate ${(tune.winRate*100).toFixed(0)}% | ${tune.overallAssessment}`);

        // Write proposed changes — never auto-apply
        const pending = {
            proposedAt:   new Date().toISOString(),
            basedOnTrades: recentTrades.length,
            summary:      tune.summary,
            winRate:      tune.winRate,
            recommendations: tune.recommendations,
            assessment:   tune.overallAssessment,
            status:       'pending_approval',  // main.ts checks this — only applies on 'approved'
        };
        fs.writeFileSync(PENDING_CHANGES_FILE, JSON.stringify(pending, null, 2));

        // Update context
        ctx.pendingTuneAt = ctx.totalTrades + TUNE_EVERY_N_TRADES;
        ctx.lastAnalysisAt = new Date().toISOString();
        saveContext(ctx);

        // Telegram alert with summary — human approves via reply
        const recLines = tune.recommendations
            .map((r: any) => `  • ${r.parameter}: ${r.currentValue} → ${r.recommendedValue} (${r.reasoning})`)
            .join('\n');

        await sendAlert(
            `🎯 Gemini Tune (${recentTrades.length} trades):\n` +
            `Win rate: ${(tune.winRate*100).toFixed(0)}%\n` +
            `${tune.summary}\n\n` +
            `Recommendations:\n${recLines}\n\n` +
            `Reply APPROVE to apply, or REJECT to keep current params.\n` +
            `(Changes written to pendingChanges.json)`
        );

    } catch (e: any) {
        console.error(`[Gemini] Tune failed: ${e.message}`);
    }
}

// ─── KILL SWITCH ──────────────────────────────────────────────────────────────
// Called from main.ts after every trade close. If cumulative realized loss
// exceeds KILL_THRESHOLD_USD, alerts and returns true — main.ts exits cleanly.
export async function checkKillSwitch(
    realizedPnl:  number,
    sendAlert:    (msg: string) => Promise<void>,
): Promise<boolean> {
    const ctx = loadContext();

    // Update running totals
    ctx.totalTrades++;
    if (realizedPnl >= 0) ctx.totalWins++; else ctx.totalLosses++;
    ctx.totalRealizedPnl  += realizedPnl;
    if (realizedPnl < 0) ctx.cumulativeLoss += Math.abs(realizedPnl);
    saveContext(ctx);

    // Kill switch: cumulative loss exceeds threshold
    if (ctx.cumulativeLoss >= KILL_THRESHOLD_USD && !ctx.killSwitchTripped) {
        ctx.killSwitchTripped = true;
        saveContext(ctx);

        const msg = `🚨 KILL SWITCH TRIGGERED\n` +
            `Cumulative loss: $${ctx.cumulativeLoss.toFixed(2)} exceeded $${KILL_THRESHOLD_USD} limit.\n` +
            `Total trades: ${ctx.totalTrades} | Wins: ${ctx.totalWins} | Losses: ${ctx.totalLosses}\n` +
            `Bot is shutting down. Restart manually after reviewing tradeLog.jsonl.`;

        await sendAlert(msg);
        console.error(`[Gemini] 🚨 KILL SWITCH: cumulative loss $${ctx.cumulativeLoss.toFixed(2)} >= $${KILL_THRESHOLD_USD}`);
        return true;
    }

    // Periodic tune trigger
    if (ctx.totalTrades >= ctx.pendingTuneAt) {
        // Fire async — don't block the main cycle
        runPeriodicTune(sendAlert).catch(e =>
            console.error(`[Gemini] Background tune failed: ${e.message}`)
        );
    }

    return false;
}

// ─── TRADE COUNTER HELPER ─────────────────────────────────────────────────────
export function getGeminiContext(): GeminiContext {
    return loadContext();
}
