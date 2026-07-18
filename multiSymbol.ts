import * as dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';
dotenv.config();

import {
    loadBankroll, createBankroll, getCurrentMargin,
    bankrollSummary,
} from './symbolBankroll.js';
import { sendAlert, getAvailableBalance } from './executeTrade.js';

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
const BOTS: BotConfig[] = [
    // SNIPER MODE (2026-07-14, user demand: maximize accuracy, not just expectancy).
    // Both bots now run the two measured-best filter stacks from the 150-trade path
    // dataset — the highest win rates this signal's inputs produce:
    //   stack A: ranging + OB>=80% + at/behind VWAP            → 81% WR (n=16)
    //   stack B: any regime + OB>=80% + behind VWAP + mom-align → 81% WR (n=16)
    // OB>=90% measured WORSE (56%) — extreme imbalance is a trap; 80 is the sweet
    // spot. Pure-momentum entries are disabled (MOM_STRONG_ATR=99) since the stacks
    // were measured on OB-led entries only. Frequency drops to ~10% of trades; with
    // the 1.0/0.8 ATR bracket (breakeven 55%), 81% WR ≈ +$2.06/unit expectancy.
    // Caveat on the record: stacks were measured on GOLD data; ETH runs stack B
    // structurally (own ATR/VWAP scale) as an experiment — its old loose config was
    // a proven coinflip (losers wrong from the first tick), so tightening can't do
    // worse and the flight recorder will verdict it either way.
    {
        botId: 'XAU-SCALP', marketSymbol: 'XAUUSDT', displaySymbol: 'XAU/USDT', wsSymbol: 'xauusdt',
        leverage: 100, wallMinNotional: 20_000,
        strategy: {
            TP_ATR_MULT,
            SL_FROM_TP_MULT,            // sl + taker fee = 2 x TP (exact)
            TP_MIN_USD:       '',       // unset → ATR-relative
            SL_ROI_PCT:       '',       // unset → ATR-relative
            SL_FIXED_USD:     '',
            VWAP_EXT_MAX_PCT: '0',      // sniper: at/behind VWAP only
            OB_STRONG:        '0.80',   // sniper: strong-book entries only
            OB_LEAN:          '0.80',
            MOM_STRONG_ATR:   '99',     // no pure-momentum entries
            MOM_ALIGN:        'false',  // stack A measured better WITHOUT mom-align
            ENTRY_TAKER:      'false',  // maker entry (0 fee)
            BANK_SPLIT:       '0',      // no banking, 100% reinvested
            RANGING_ONLY:     'true',   // stack A: ranging only
        },
    },
    {
        botId: 'ETH-DIR', marketSymbol: 'ETHUSDC', displaySymbol: 'ETH/USDC', wsSymbol: 'ethusdc',
        leverage: 100, wallMinNotional: 50_000,
        strategy: {
            TP_ATR_MULT,
            SL_FROM_TP_MULT,            // sl + taker fee = 2 x TP (exact)
            TP_MIN_USD:       '',
            SL_ROI_PCT:       '',
            SL_FIXED_USD:     '',
            VWAP_EXT_MAX_PCT: '0',      // sniper: value side only (was 0.18 loose)
            OB_STRONG:        '0.80',
            OB_LEAN:          '0.80',
            MOM_STRONG_ATR:   '99',
            MOM_ALIGN:        'true',   // stack B keeps momentum alignment
            ENTRY_TAKER:      'false',
            BANK_SPLIT:       '0',
            RANGING_ONLY:     'false',  // stack B: any regime
            // Quiet-hours window (2026-07-16, from 75 flight-recorded trades):
            // 18:00-06:00 UTC ran ~76% WR +$0.46; 06:00-18:00 ran 50% WR −$0.73 —
            // every big-flush death was a London/NY hour. ETH trades nights only.
            TRADE_HOURS_UTC:  '18-2',  // trimmed 2026-07-18: deep-Asia 02-05 bled 3 nights straight (1W/5L last night)
        },
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

    const margin = getCurrentMargin(bankroll);

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

    console.log(`${tag} 🚀 Started | stack=$${bankroll.stack.toFixed(4)} margin=$${margin.toFixed(2)} ${cfg.leverage}x | TP=$${cfg.strategy.TP_MIN_USD} SL=-${cfg.strategy.SL_ROI_PCT}%`);
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

// ─── STARTUP: SPLIT THE BALANCE IN HALF ──────────────────────────────────────
async function initBankrolls(): Promise<void> {
    const balance = await getAvailableBalance();
    console.log(`[Orchestrator] Live balance: $${balance.toFixed(4)}`);

    const share = balance / BOTS.length;   // half each, per spec
    console.log(`[Orchestrator] Splitting $${balance.toFixed(4)} → $${share.toFixed(4)} per bot`);

    for (const cfg of BOTS) {
        const existing = loadBankroll(cfg.botId);
        if (existing) {
            console.log(`[Orchestrator] ${cfg.botId}: restored — stack=$${existing.stack.toFixed(4)} banked=$${existing.banked.toFixed(4)}`);
        } else {
            createBankroll(cfg.botId, share);
            console.log(`[Orchestrator] ${cfg.botId}: created — stack=$${share.toFixed(4)}`);
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

// ─── STARTUP ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`  DUAL-BOT GOLD SCALPER`);
console.log(`  ENV     : ${ENVIRONMENT}`);
console.log(`  ${BOTS[0].botId.padEnd(9)}: ${BOTS[0].marketSymbol} frequency-scalp | TP $${BOTS[0].strategy.TP_MIN_USD} | ${BOTS[0].leverage}x | SL -${BOTS[0].strategy.SL_ROI_PCT}% | ranging-only | 0% maker`);
console.log(`  ${BOTS[1].botId.padEnd(9)}: ${BOTS[1].marketSymbol} directional     | TP $${BOTS[1].strategy.TP_MIN_USD} | ${BOTS[1].leverage}x | SL -${BOTS[1].strategy.SL_ROI_PCT}% | trends OK    | 0% maker`);
console.log(`  CAPITAL : split 50/50, independent bankrolls, NO banking, 100% compounding`);
console.log(`  LIFECYCLE: one dies → other continues alone | both die → ALL TRADING STOPS`);
console.log(`  WHY 2 SYMBOLS: one net position per symbol — two bots on one symbol collide`);
console.log(`${'═'.repeat(70)}\n`);

initBankrolls().then(() => {
    if (allStopped) return;
    registry.filter(e => !e.finished).forEach((entry, i) => {
        setTimeout(() => spawnBot(entry), i * 3_000);
    });
}).catch(async (e) => {
    console.error(`[Orchestrator] Startup error (idling, not exiting): ${e.message}`);
    await sendAlert(`🚨 Orchestrator startup error: ${e.message} — idling.`).catch(() => {});
});
