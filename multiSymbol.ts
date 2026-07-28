import * as dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as crypto from 'crypto';
dotenv.config();

import {
    loadBankroll, createBankroll, getCurrentMargin,
    bankrollSummary,
} from './symbolBankroll.js';
import { sendAlert, getAvailableBalance } from './executeTrade.js';

// ─── EXPERIMENT FREEZE (pro-trader framework, 2026-07-24) ────────────────────
// "If you keep tuning the strategy based on the first 50 trades, the next 150
// are no longer an unbiased 200-trade test... Freeze the strategy. No parameter
// changes. After N trades, analyze. THEN create Version 2." This is a durable,
// file-based lock — not a comment or a promise — because tonight's actual
// failure mode was silently tweaking every 10-70 trades. FREEZE_STATE_FILE
// stores a hash of the live BOTS config at freeze time; startup refuses to run
// if the current code's config hash doesn't match while frozen. To make a
// change mid-freeze, you must deliberately run `npx tsx multiSymbol.ts --unfreeze`
// — a real, visible action, not something that happens as a side effect of an
// edit-and-redeploy cycle.
const FREEZE_STATE_FILE = process.env.FREEZE_STATE_FILE ?? './experiment-freeze.json';
interface FreezeState { frozenAt: string; configHash: string; note: string; }

function hashConfig(bots: BotConfig[]): string {
    // Hash only the strategy-relevant fields — not comments, not object key order.
    const canon = bots.map(b => ({
        botId: b.botId, marketSymbol: b.marketSymbol, leverage: b.leverage,
        initialStack: b.initialStack ?? null,
        strategy: Object.fromEntries(Object.entries(b.strategy).sort(([a], [b2]) => a.localeCompare(b2))),
    }));
    return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

function loadFreeze(): FreezeState | null {
    try {
        if (fs.existsSync(FREEZE_STATE_FILE)) return JSON.parse(fs.readFileSync(FREEZE_STATE_FILE, 'utf-8'));
    } catch { /* treat as unfrozen */ }
    return null;
}

function saveFreeze(state: FreezeState): void {
    fs.writeFileSync(FREEZE_STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── DUAL-BOT ORCHESTRATOR ────────────────────────────────────────────────────
// User spec 2026-07-12: split the balance in half into two INDEPENDENT bots that
// both trade gold but chase different move sizes. Each bot owns its own bankroll,
// state file, trade log, and strategy env — they never touch each other's money.
//
//   Bot A "directional" : TP $2–$6 (uses TP_A_USD, default $3), 50x
//   Bot B "microscalp"  : TP $2 (higher frequency, closer target), 50x
//   Both                : maker entry + maker TP, SL = -15% of margin, 100%
//                         compounding, NO banking (BANK_SPLIT=0 → nothing skimmed)
//
// Lifecycle (exactly as specced):
//   - one bot's stack runs out  → it stops; the OTHER keeps trading alone.
//     Its capital is NOT handed to the survivor — the halves stay separate.
//   - both bots' stacks run out → orchestrator stops trading entirely, cancels
//     resting orders, and idles. No further orders are placed.
//
// The bot identity key is `botId` (not the market symbol), so two bots can trade
// the SAME symbol with fully separate bankrolls (bot-state-{botId}.json).

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';

interface BotConfig {
    botId:           string;   // identity: names the bankroll, state file, and trade log
    marketSymbol:    string;
    displaySymbol:   string;
    wsSymbol:        string;
    leverage:        number;
    wallMinNotional: number;
    /** Strategy env applied to this bot only — overrides the shared .env. */
    strategy:        Record<string, string>;
    /** Fixed $ allocation at first-ever startup. If unset, splits the remaining
     *  balance evenly across all bots that also left this unset. */
    initialStack?:   number;
}

// TWO SYMBOLS, NOT TWO BOTS ON ONE SYMBOL (2026-07-12). Binance keeps ONE net
// position per symbol per account, so two bots on XAUUSDT would corrupt each other
// (B's stop could close A's position). Hedge mode could split LONG/SHORT sides, but
// it forces each bot single-direction. Running two SYMBOLS is cleaner: no collision,
// both bots free to go long or short, and the bankrolls stay independent.
//
// Symbol choice is driven by the fee table (checked live 2026-07-12):
//   XAUUSDT  maker 0.000%  taker 0.040%   ← the zero-maker edge this bot is built on
//   ETHUSDC  maker 0.000%  taker 0.040%   ← same edge, $1.81B/24h volume
//   ETHUSDT  maker 0.020%  ← would cost ~$0.35/unit and destroy the edge. Excluded.
//   BTCUSDT  maker 0.020%  ← ~$12.43/unit. Excluded.
//   BTCUSDC  maker 0.000%  but a $62k asset: min notional forces a position far
//                            larger than a ~$1.4 stack can hold. Excluded on size.
//
// Assignment (gold = the calmer, mean-reverting book; ETH = the trendier one):
//   XAU-SCALP : gold, frequency scalping — small $2 TP, ranging-only, fires often
//   ETH-DIR   : ETHUSDC, directional — rides trends, no ranging-only restriction
//
// -15% of margin @100x = a price move of entry × 0.15/100:
//   gold @ ~$4000 → $6.00 stop  vs a $2 TP  → 1 loss ≈ 3.9 wins
//   ETH  @ ~$1770 → $2.66 stop  vs a $4 TP  → 1 loss ≈ 0.8 wins → breakeven ~45%
// ETH's tighter dollar stop (its price is 2.3x smaller) is what makes the
// directional bot's math the strongest of any config this project has run.
// EVERY THRESHOLD IS PER-ASSET, MEASURED (2026-07-14). The first night ran ETH on
// gold's constants and both bots lost ~13%. Measured over 1000x 5m candles:
//                 price      ATR(5m)    ATR%     |px-VWAP| median
//   XAUUSDT     $4,022       $3.60     0.090%        0.027%
//   ETHUSDC     $1,786       $2.92     0.164%        0.142%   <- 5.3x gold's VWAP dev
//
// Three gold-shaped constants were killing ETH:
//   1. TP $4 = 1.37x ETH's ATR (gold's working TP is 0.56x) -> 21/40 trades died on
//      the time-stop, only 6 hit TP. TP is now ATR-relative (TP_ATR_MULT=0.56).
//   2. VWAP gate 0.0% -> ETH's typical deviation is 0.142%, so it blocked ~every
//      entry ("CHASING" 93x in 200 heartbeats). Now 0.18% for ETH, 0.04% for gold.
//   3. SL -15% = 0.92x ETH's ATR -> the stop sat INSIDE ETH's own noise (gold's
//      -15% is a comfortable 1.68x ATR). ETH's stop widened to -27% (~1.68x ATR),
//      matching the ratio that works on gold.
// THE KEY FIX: TP must be WIDER than SL, both sized in ATR (not dollars).
// Every config this project has run had TP << SL, which forces an unreachable win
// rate no matter how good the signal is. Sweeping TP/SL in ATR-multiples against
// the fee, TP=1.0x ATR / SL=0.8x ATR is the first shape whose breakeven sits BELOW
// the measured win rate on BOTH assets:
//     XAU  TP $3.60 / SL $2.88  -> 1 loss = 1.2 wins -> breakeven 55%  (measured 62%)
//     ETH  TP $2.92 / SL $2.34  -> 1 loss = 1.0 wins -> breakeven 51%
// TP at 1.0x ATR is one normal 5m candle — demonstrably reachable (gold hit its TP
// 8/13 times at 0.56x ATR with zero time-stops), unlike ETH's old $4 = 1.37x ATR
// which time-stopped on 21 of 40 trades.
// User rule 2026-07-14 (exact form): "sl + taker fee = tp x 2" — the total realized
// loss INCLUDING the taker exit fee equals exactly two wins:
//   slDist = 2×tpDist − takerFee×entry     (maker entry/TP pay nothing)
// One loss = exactly 2.0 wins → breakeven 66.7%, vs the sniper stacks' measured 81%.
// The stop lands ≈1.55×ATR on gold / ≈1.74×ATR on ETH — outside the ~0.8×ATR median
// adverse excursion, so ordinary wiggle shouldn't tag it.
const SL_FROM_TP_MULT = '2';   // exact rule: loss + fee = 2 × TP
const TP_ATR_MULT     = '1.0'; // target one normal candle
// USER REDESIGN (2026-07-24), replacing the 100x-leverage sniper configs above.
// User's framework, verbatim reasoning: tonight's 100x + $0.50-$2.50 TP/SL meant a
// near-random tick decided every trade — the SL was inside normal noise, not a real
// invalidation level. At 5x-20x, the SAME dollar risk requires MUCH more real price
// movement to trigger, so a stop-out means the read was actually wrong, not that the
// spread flickered. Every symbol now uses PERCENTAGE-based TP/SL (TP_PCT/SL_PCT,
// added to executeTrade.ts) instead of a hand-picked dollar figure — 0.15% TP /
// 0.10% SL is the SAME relative risk on a $74 SOL trade and a $64,000 BTC trade,
// which fixes the recurring "gold-shaped constants killing ETH" class of bug from
// earlier tonight. Breakeven at 0.15%/0.10% with 0% maker fee: ~48% on every symbol
// (win +0.15%, loss +0.10%+taker-fee-on-SL) — the best math this project has run.
//
// Capital: $1 fixed each to ETH/BTC/SOL (user spec), gold gets the remainder.
// Leverage: 5x everywhere EXCEPT where $1 margin can't clear the exchange's minimum
// notional floor — ETH needs 20x ($1x20=$20 min) and BTC needs 50x ($1x50=$50 min)
// purely to make Binance accept the order; SOL and gold clear at 5x ($1x5=$5 min).
// This was flagged to the user as a real constraint (not a design choice) before
// building — user chose "raise leverage only on the two that need it" over the
// alternatives (bigger margin on ETH/BTC, or dropping them entirely).
// FROZEN EXPERIMENT CONFIG (2026-07-24). Pro-trader framework, "Experiment B":
// same ATR-normalized TP/SL multiple applied identically across every asset —
// the fair, apples-to-apples version of the earlier %-of-price attempt, because
// it also normalizes for volatility, not just price level. RISK_USD_PER_TRADE
// (not %-of-margin) so dollar risk stays CONSTANT while the stack compounds
// during this fixed-risk "prove the edge" phase — the trader's explicit
// Test-1-vs-Test-2 separation. DAILY_LOSS_LIMIT_PCT is the circuit breaker on a
// slow bleed that never streaks long enough to trip MAX_CONSEC_LOSSES.
// THIS CONFIG IS MEANT TO BE FROZEN: run `npx tsx multiSymbol.ts --freeze "note"`
// once satisfied, then no strategy edit will start until --unfreeze.
//
// v2 (2026-07-24): user wants +0.3% EXPECTANCY per trade. At the measured 53% WR
// v3 — FINAL, per user (2026-07-24, verbatim): "no gates... doesn't matter what
// direction... enter trade... TP 0.47% SL 0.8%... no time limit... continuous
// execution... limit entry orders... protect API." User was shown the math
// before deciding: TP 0.47% / SL 0.8% is roughly 1:1.7 risk:reward (SL wider
// than TP), which gives a 64% breakeven — the OPPOSITE shape from v2's 5:1 (17%
// breakeven) two messages ago. At the bot's measured 53% WR this loses money
// unless removing every gate meaningfully lifts the win rate above 64%, which
// is unproven. Built exactly as specified because the user explicitly decided
// it after seeing that math, not because the math changed.
//   NO_GATES=true  -> signals.ts bypasses every filter (blackout, hours, regime,
//                      OB conviction, momentum, VWAP, volume-exhaustion, ATR
//                      ceiling/floor) and never returns neutral.
//   TP_PCT/SL_PCT   -> fixed % of price, not ATR — "no ATR" as specified.
//   MAX_HOLD_MS=0   -> time-stop disabled entirely — holds until TP or SL fills,
//                      however long that takes.
//   SL_MAKER=true, ENTRY_TAKER=false -> "limit entry orders... maker" both sides.
//   Cycle pacing (signals.ts getSession, 4-14s between checks, untouched) is
//   what keeps this API-safe — a true zero-delay loop across 4 bots would risk
//   the exact rate-limit problem fixed earlier tonight; this cadence already
//   ran the whole session without a single rate-limit error.
// v4 (2026-07-25): TWO fixes together.
//   1. MARGIN STARVATION BUG FOUND LIVE: with no time-stop, ETH/BTC's open
//      positions sat for 9+ hours holding ~$2.30 of the account's $4.36 as
//      locked margin (Binance Cross-margin is ONE shared pool across all bots
//      on this account — not something the code can wall off without switching
//      to isolated margin, a bigger change). Gold's MARGIN_STACK_PCT=100 meant
//      it always requested ~its FULL stack, so it kept losing the race for the
//      last sliver of free margin by pennies, every cycle, for 9 hours straight
//      — "Margin insufficient this instant" on literally every attempt. Fixed
//      by dropping every bot's request to 60% of its own stack, leaving real
//      headroom so a bot's own trade fits comfortably even when others are
//      mid-position, instead of requesting the exact edge of what might be free.
//   2. TP/SL now ROI-based per user: "set tp to 5% roi and sl to -5.5% roi for
//      each. that way it probably can't shoot past." % of MARGIN, leverage-aware
//      (TP_ROI_PCT, mirrors the existing SL_ROI_PCT formula: priceDist = entry x
//      (roiPct/100) / leverage). NOTE the leverage-inversion property (documented
//      elsewhere in this file): HIGHER leverage means a SMALLER price move hits
//      the same ROI%, so BTC (50x) and gold (5x) will have very different $
//      distances for the same 5%/10% ROI — that's expected and correct, not a bug.
const SHARED_STRATEGY: Record<string, string> = {
    MARGIN_STACK_PCT:  '60',     // was 100 — leaves headroom in the shared Cross-margin pool
    NO_GATES:          'true',   // bypasses the legacy gate stack (regime/hours/etc)
    // EDGE FILTERS from the full 1,442-trade history (2026-07-28). These are the
    // only two effects that survived that sample size:
    //   |OB|>=0.7        -> 59% WR (n=660)  vs 53% below 0.4
    //   |VWAPdev|>=0.15% -> 66% WR (n=396)  vs 45% AT vwap (chop)
    //   both together    -> 63% WR (n=405 of 1442, i.e. ~28% of signals qualify)
    // Expect a large drop in trade frequency — that is the point; the 45%-WR
    // chop-zone trades were the ones bleeding the account.
    NO_GATES_OB_MIN:   '0.7',
    NO_GATES_VWAP_MIN: '0.15',   // percent
    // BACKTESTED 2026-07-28 on 12,000x 1m candles/symbol (~8.3 days), offline.
    // 20bps TP / 40bps SL, maker-only exits, was the ONLY shape positive on
    // multiple independent symbols (BTC +4.00bps 73% WR, SOL +3.81bps 73% WR)
    // AND consistent across a walk-forward split. It also beat a random-direction
    // control (BTC +4.00 vs +1.08 random, SOL +3.81 vs -0.53), so the signal is
    // contributing, not just the bracket shape.
    // 2026-07-28 REVERSED after live failure of 20/40. That bracket needed a
    // 66.7% win rate to break even; backtest showed 68-73% so it looked safe,
    // but LIVE delivered 58.6% and it bled -$0.64 in ~3h (29 trades, only 1
    // taker fill -- execution was fine, the BRACKET was wrong).
    // 40/20 inverts the risk: breakeven drops to 33.3%, so it profits even when
    // wrong 2 out of 3 times. Backtest WR on 40/20 is 32.8-41% across symbols,
    // i.e. a real cushion instead of needing everything to go right.
    // EV at various live WRs: 35%->+1bps, 40%->+4bps, 50%->+10bps.
    // TRADEOFF: a 40bps target is further away, so fewer trades resolve as TP
    // and median hold roughly doubles (14-30m -> 15-68m depending on symbol).
    TP_PCT:            '0.40',   // 40 bps -- WIDER than stop
    SL_PCT:            '0.20',   // 20 bps -- tight stop
    TP_ROI_PCT:        '',
    SL_ROI_PCT:        '',
    TP_ATR_MULT: '', SL_ATR_MULT: '', TP_MIN_USD: '', SL_FIXED_USD: '',
    SL_TP_MULT: '', SL_FROM_TP_MULT: '',
    SL_MAKER:          'true',   // maker both sides, 0 fee — "limit entry orders"
    ENTRY_TAKER:       'false',
    // CAVEAT (checked 2026-07-24): $0.02 fixed risk is exact on ETH/SOL/gold, but
    // BTC's exchange minQty (0.001) forces a slightly larger real position — actual
    // risk on BTC works out to ~$0.04, not $0.02. Disclosed, not hidden: on a $1
    // stack this is still small, but "fixed-$ risk" isn't bit-for-bit identical on
    // every symbol at this account size. Re-verify if RISK_USD_PER_TRADE changes.
    RISK_USD_PER_TRADE:'0.02',   // fixed $ risk per stop-out — constant across the fixed-risk phase, not a % of a moving stack
    RISK_PCT_OF_MARGIN:'',       // off — fixed-$ mode takes priority
    // User 2026-07-24: "oh no pausing. run everything. no limits. it's coffee
    // money." Daily loss limit disabled per explicit instruction — this WAS the
    // safety net that just paused ETH/BTC/gold after the no-gates shape lost on
    // 3 of 4 bots (25% and 0% win rates). User has decided to accept that risk.
    DAILY_LOSS_LIMIT_PCT: '0',   // disabled — user explicit: run without a daily pause
    // 2026-07-28 user: "no we are not expecting price to change in 5 minutes. set
    // it to 15 minutes and then close if sl or tp isn't hit." Re-enables the
    // time-stop (was 0/disabled since the "no time limit" spec). At 15min a
    // position that hasn't resolved gets force-closed at market rather than
    // holding indefinitely — which is also what was silently blocking gold's
    // cycle for hours at a time (an open position makes runCycle return early,
    // so the bot goes dormant until it resolves).
    // TIME-STOP DISABLED (backtest-driven). A time-stop force-closes at MARKET,
    // which pays the 4bps taker fee. Measured: raw directional edge is only
    // ~0.5bps, so ANY taker exit destroys it -- with a 15m cap every tested
    // config went negative; with maker-only exits BTC/SOL went positive.
    // COST, stated plainly: positions now carry until TP or SL fills. Median
    // hold ~16-29min, but the tail reached 14.6 HOURS in backtest. That ties up
    // margin and is the real tradeoff for being fee-free.
    MAX_HOLD_MS:       '0',
    ENTRY_CHASE_TOTAL_MS: '120000',
    ENTRY_MAX_REQUOTES: '6',
    ENTRY_CHASE_POLL_MS: '3000',
    FILL_POLL_MS:      '1500',
    MAX_CONSEC_LOSSES: '12',     // kept — the one thing standing between "no gates" and a runaway loss streak
    BE_TRIGGER_PCT:    '0',      // profit-lock stays off (past naked-position bug)
    VWAP_EXT_MAX_PCT:  '0.50',   // irrelevant under NO_GATES but left set, harmless
    OB_STRONG:         '0.20',
    OB_LEAN:           '0.10',
    MOM_STRONG_ATR:    '0.3',
    MOM_ALIGN:         'true',
    BANK_SPLIT:        '0',
    RANGING_ONLY:      'false',
    TRADE_HOURS_UTC:   '',
    VOL_EXHAUST_MAX:   '0.85',   // active independent of NO_GATES (main.ts check) — the one filter with a real, reproducible edge (40% vs 52% WR)
};
const BOTS: BotConfig[] = [
    // 2026-07-28: consolidated to SOL + XAU only. At a $2.94 wallet, ETH's
    // stack ($0.26) gave an $11.48 notional vs ETHUSDC's $20 minimum, and BTC's
    // ($0.62) gave $37.40 vs BTCUSDC's $50 minimum -- BOTH physically could not
    // place an order and would have sat failing silently (the same dead-bot bug
    // that left gold dormant 9h on 2026-07-27).
    // SOL ($5 min) and XAU ($5 min) are the cheapest symbols to trade, so they
    // stay viable even if the account shrinks further. Both also passed the
    // 40/20 backtest: SOL +3.35bps @38.9% WR, XAU +4.62bps @41.0% WR
    // (breakeven for 40/20 is 33.3%).
{
        // Same reasoning as ETH: raised but kept looser than BTC's failing shape.
        // 15x -> 0.333% TP, vs BTC's 0.100%. Real data since 2026-07-25: SOL 11
        // closes, net +$0.40, 100% WR on the thin sample so far.
        botId: 'SOL-SCALP', marketSymbol: 'SOLUSDC', displaySymbol: 'SOL/USDC', wsSymbol: 'solusdc',
        // 2026-07-27 user: raised 15x -> 30x. TP5%/SL5.5% ROI at 30x -> ~0.167%/
        // 0.183% of price — still looser than BTC's failing 0.10% tier, so this one
        // doesn't cross into the same danger zone gold's 50x did.
        leverage: 30, wallMinNotional: 5_000,
        initialStack: 1,
        strategy: { ...SHARED_STRATEGY },
    },
{
        botId: 'XAU-SCALP', marketSymbol: 'XAUUSDT', displaySymbol: 'XAU/USDT', wsSymbol: 'xauusdt',
        // 2026-07-27 user: raised 20x -> 50x for more trade frequency. FLAGGED TO
        // USER before applying: 50x puts gold's TP_ROI_PCT=5/SL_ROI_PCT=5.5 target
        // at ~0.10%/0.11% of price — the SAME tightness as BTC-SCALP's failing
        // shape (net -$0.37, 56% WR, removed 2026-07-27 for underperforming at
        // exactly this leverage tier). User chose to proceed anyway. Watch gold's
        // win rate closely at this setting; if it tracks BTC's pattern, dial back.
        leverage: 50, wallMinNotional: 20_000,
        // no initialStack — gets 100% of whatever remains after ETH/BTC/SOL's $1 each
        strategy: { ...SHARED_STRATEGY },
    },
];

// A bot is "finished" when its stack can no longer fund the exchange minimum.
const MIN_STACK = Number(process.env.MIN_STACK ?? 0.10);

interface ManagedProcess {
    config:    BotConfig;
    child:     ChildProcess | null;
    restarts:  number;
    lastStart: number;
    finished:  boolean;   // stack exhausted — never restart this one
}

let registry: ManagedProcess[] = [];
let allStopped = false;

// ─── SPAWN ONE BOT ────────────────────────────────────────────────────────────
function spawnBot(entry: ManagedProcess): void {
    if (allStopped || entry.finished) return;

    const cfg      = entry.config;
    const bankroll = loadBankroll(cfg.botId);

    if (!bankroll) {
        console.error(`[Orchestrator] ❌ No bankroll for ${cfg.botId}`);
        return;
    }
    if (bankroll.paused || bankroll.stack < MIN_STACK) {
        markFinished(entry, `stack $${bankroll.stack.toFixed(4)} exhausted`);
        return;
    }

    // BANNER BUG (found 2026-07-24): this used to read process.env.MARGIN_STACK_PCT
    // from the ORCHESTRATOR's own env (25% default), not the per-bot override in
    // cfg.strategy — so a bot set to 100% margin still displayed the old 25% number
    // at startup even though the actual child process (env merged below) traded
    // correctly. Purely cosmetic, but confusing — apply the bot's own override here too.
    const prevPct = process.env.MARGIN_STACK_PCT;
    if (cfg.strategy.MARGIN_STACK_PCT) process.env.MARGIN_STACK_PCT = cfg.strategy.MARGIN_STACK_PCT;
    const margin = getCurrentMargin(bankroll);
    if (prevPct === undefined) delete process.env.MARGIN_STACK_PCT; else process.env.MARGIN_STACK_PCT = prevPct;

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...cfg.strategy,                 // per-bot strategy overrides the shared .env
        BOT_ID:            cfg.botId,
        MARKET_SYMBOL:     cfg.marketSymbol,
        DISPLAY_SYMBOL:    cfg.displaySymbol,
        WS_SYMBOL:         cfg.wsSymbol,
        MARGIN_PER_TRADE:  String(margin),
        BOT_LEVERAGE:      String(cfg.leverage),
        WALL_MIN_NOTIONAL: String(cfg.wallMinNotional),
        // Per-BOT state and log (not per-symbol) — this is what keeps the two
        // bankrolls independent while both trade the same market.
        STATE_FILE:        `./bot-state-${cfg.botId}.json`,
        TRADE_LOG_FILE:    `./tradeLog-${cfg.botId}.jsonl`,
        STATE_DIR:         '.',
    };

    const child = spawn(process.execPath, ['--import', 'tsx', 'main.ts'], {
        env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });

    entry.child     = child;
    entry.lastStart = Date.now();

    const tag = `[${cfg.botId}]`;
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`${tag} ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`${tag} ${d}`));

    child.on('exit', (code) => {
        entry.child = null;
        const latest = loadBankroll(cfg.botId);
        if (latest && (latest.paused || latest.stack < MIN_STACK)) {
            markFinished(entry, `stack $${latest.stack.toFixed(4)} exhausted`);
            return;
        }
        if (allStopped || entry.finished) return;
        entry.restarts++;
        const uptime    = Date.now() - entry.lastStart;
        const backoffMs = entry.restarts > 5 && uptime < 120_000 ? 30_000 : 5_000;
        console.warn(`${tag} ⚠️  Exited (code=${code}) — restarting in ${backoffMs / 1000}s`);
        setTimeout(() => spawnBot(entry), backoffMs);
    });

    const geomLabel = cfg.strategy.TP_ATR_MULT ? `${cfg.strategy.TP_ATR_MULT}x ATR TP / ${cfg.strategy.SL_ATR_MULT}x ATR SL`
        : cfg.strategy.TP_PCT ? `${cfg.strategy.TP_PCT}% TP / ${cfg.strategy.SL_PCT}% SL`
        : `$${cfg.strategy.TP_MIN_USD} TP / $${cfg.strategy.SL_FIXED_USD} SL`;
    console.log(`${tag} 🚀 Started | stack=$${bankroll.stack.toFixed(4)} margin=$${margin.toFixed(2)} ${cfg.leverage}x | ${geomLabel}`);
}

// ─── LIFECYCLE: one bot dies → the other continues alone ─────────────────────
// The dead bot's remaining capital is NOT transferred to the survivor (user spec:
// "if one's balance finishes, don't enter the other one, let it continue alone").
function markFinished(entry: ManagedProcess, reason: string): void {
    if (entry.finished) return;
    entry.finished = true;
    if (entry.child) {
        entry.child.removeAllListeners('exit');
        entry.child.kill('SIGTERM');
        entry.child = null;
    }
    const msg = `⛔ ${entry.config.botId} FINISHED — ${reason}. Not restarting.`;
    console.log(`[Orchestrator] ${msg}`);
    sendAlert(msg).catch(() => {});

    const survivors = registry.filter(e => !e.finished);
    if (survivors.length === 0) {
        stopEverything('both bankrolls exhausted');
    } else {
        console.log(`[Orchestrator] ${survivors.map(s => s.config.botId).join(', ')} still running alone.`);
    }
}

// ─── BOTH DEAD → STOP TRADING ENTIRELY ───────────────────────────────────────
// User spec: "if both balances are finished, stop trading, stop making orders."
// The children own their own order cleanup on SIGTERM; here we make sure no
// further bot is ever spawned and the process idles quietly instead of exiting
// (a hard exit under pm2 would crash-loop and re-enter trading).
function stopEverything(reason: string): void {
    if (allStopped) return;
    allStopped = true;
    for (const e of registry) {
        if (e.child) {
            e.child.removeAllListeners('exit');
            e.child.kill('SIGTERM');
            e.child = null;
        }
    }
    const msg = `🛑 ALL TRADING STOPPED — ${reason}. No further orders will be placed.`;
    console.log(`\n[Orchestrator] ${msg}\n`);
    sendAlert(msg).catch(() => {});
}

// ─── STARTUP: ALLOCATE CAPITAL PER BOT ───────────────────────────────────────
// User spec 2026-07-24: $1 fixed each to ETH/BTC/SOL, "the rest on gold" — an
// explicit unequal split, not the old even-N-way divide. Bots with a fixed
// initialStack get exactly that; bots without one split whatever balance is
// left over evenly (today: just gold, so it gets 100% of the remainder).
async function initBankrolls(): Promise<void> {
    const balance = await getAvailableBalance();
    console.log(`[Orchestrator] Live balance: $${balance.toFixed(4)}`);

    const fixedTotal = BOTS.reduce((sum, cfg) => sum + (cfg.initialStack ?? 0), 0);
    const flexBots   = BOTS.filter(cfg => cfg.initialStack === undefined);
    const remainder  = Math.max(0, balance - fixedTotal);
    const flexShare  = flexBots.length > 0 ? remainder / flexBots.length : 0;
    if (fixedTotal > balance) {
        console.warn(`[Orchestrator] ⚠️ Fixed allocations ($${fixedTotal.toFixed(2)}) exceed live balance ($${balance.toFixed(4)}) — bots will be capped by real available margin at trade time.`);
    }

    for (const cfg of BOTS) {
        const existing = loadBankroll(cfg.botId);
        if (existing) {
            console.log(`[Orchestrator] ${cfg.botId}: restored — stack=$${existing.stack.toFixed(4)} banked=$${existing.banked.toFixed(4)}`);
        } else {
            const stack = cfg.initialStack ?? flexShare;
            createBankroll(cfg.botId, stack);
            console.log(`[Orchestrator] ${cfg.botId}: created — stack=$${stack.toFixed(4)}${cfg.initialStack !== undefined ? ' (fixed)' : ' (remainder share)'}`);
        }
    }

    registry = BOTS.map(cfg => {
        const b = loadBankroll(cfg.botId);
        const dead = !b || b.paused || b.stack < MIN_STACK;
        if (dead) console.log(`[Orchestrator] ${cfg.botId}: ⛔ already exhausted — will not start`);
        return { config: cfg, child: null, restarts: 0, lastStart: 0, finished: dead };
    });

    if (registry.every(e => e.finished)) stopEverything('both bankrolls already exhausted at startup');
}

// ─── STATUS HEARTBEAT — tracks both bots side by side ────────────────────────
setInterval(() => {
    if (allStopped) {
        console.log(`\n[Orchestrator] 🛑 STOPPED — both bankrolls exhausted, no orders being placed.\n`);
        return;
    }
    console.log(`\n[Orchestrator] ── Status ──`);
    let total = 0;
    for (const e of registry) {
        const b = loadBankroll(e.config.botId);
        if (!b) continue;
        total += b.stack + b.banked;
        const alive  = e.finished ? '⛔' : (e.child ? '🟢' : '🔴');
        const uptime = e.child ? `${((Date.now() - e.lastStart) / 60_000).toFixed(1)}m` : (e.finished ? 'FINISHED' : 'down');
        console.log(`  ${alive} ${e.config.botId} uptime=${uptime} | ${bankrollSummary(b)}`);
    }
    console.log(`  TOTAL across both bots: $${total.toFixed(4)}\n`);
}, 60_000);

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
function shutdown(signal: string): void {
    console.log(`\n[Orchestrator] ${signal} — stopping all bots...`);
    for (const entry of registry) {
        if (entry.child) {
            entry.child.removeAllListeners('exit');
            entry.child.kill('SIGTERM');
        }
    }
    setTimeout(() => process.exit(0), 3_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── CLI: freeze / unfreeze ───────────────────────────────────────────────────
const _cliArg = process.argv[2];
if (_cliArg === '--freeze') {
    const state: FreezeState = {
        frozenAt: new Date().toISOString(),
        configHash: hashConfig(BOTS),
        note: process.argv[3] ?? '',
    };
    saveFreeze(state);
    console.log(`[Freeze] ✅ Experiment frozen at ${state.frozenAt} | hash ${state.configHash}${state.note ? ` | ${state.note}` : ''}`);
    console.log(`[Freeze] Any strategy edit will change the hash and refuse to start until --unfreeze.`);
    process.exit(0);
}
if (_cliArg === '--unfreeze') {
    if (fs.existsSync(FREEZE_STATE_FILE)) fs.unlinkSync(FREEZE_STATE_FILE);
    console.log(`[Freeze] 🔓 Experiment unfrozen — strategy edits are allowed again.`);
    process.exit(0);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`  MULTI-BOT SCALPER — ${BOTS.length} bots`);
console.log(`  ENV     : ${ENVIRONMENT}`);
for (const b of BOTS) {
    const geom = b.strategy.TP_ATR_MULT ? `${b.strategy.TP_ATR_MULT}x ATR TP / ${b.strategy.SL_ATR_MULT || '?'}x ATR SL`
        : b.strategy.TP_PCT ? `${b.strategy.TP_PCT}% TP / ${b.strategy.SL_PCT}% SL`
        : `$${b.strategy.TP_MIN_USD || '?'} TP / $${b.strategy.SL_FIXED_USD || '?'} SL`;
    console.log(`  ${b.botId.padEnd(11)}: ${b.marketSymbol.padEnd(9)} | ${b.leverage}x | ${geom} | stack=${b.initialStack !== undefined ? '$' + b.initialStack : 'remainder'}`);
}
console.log(`  LIFECYCLE: a bot's stack running out stops only that bot | all dead → ALL TRADING STOPS`);
console.log(`${'═'.repeat(70)}\n`);

// ─── FREEZE GATE ──────────────────────────────────────────────────────────────
// Refuses to start if a freeze is active and the live config doesn't match the
// hash recorded at freeze time — the durable version of "no changes mid-experiment."
const _freeze = loadFreeze();
if (_freeze) {
    const liveHash = hashConfig(BOTS);
    if (liveHash !== _freeze.configHash) {
        console.error(`\n🛑 EXPERIMENT IS FROZEN (since ${_freeze.frozenAt}) and the live strategy config has changed.`);
        console.error(`   Frozen hash: ${_freeze.configHash}  |  Current hash: ${liveHash}`);
        console.error(`   ${_freeze.note ? `Freeze note: ${_freeze.note}` : ''}`);
        console.error(`   Run "npx tsx multiSymbol.ts --unfreeze" to deliberately allow this change, or revert the edit.\n`);
        process.exit(1);
    }
    console.log(`[Freeze] 🔒 Running under freeze from ${_freeze.frozenAt} — config hash matches, no unauthorized changes.\n`);
}

initBankrolls().then(() => {
    if (allStopped) return;
    registry.filter(e => !e.finished).forEach((entry, i) => {
        setTimeout(() => spawnBot(entry), i * 3_000);
    });
}).catch(async (e) => {
    console.error(`[Orchestrator] Startup error (idling, not exiting): ${e.message}`);
    await sendAlert(`🚨 Orchestrator startup error: ${e.message} — idling.`).catch(() => {});
});
