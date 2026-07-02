import * as dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
dotenv.config();

import {
    loadBankroll, createBankroll, getCurrentMargin,
    bankrollSummary, SymbolBankroll,
} from './symbolBankroll.js';
import { sendAlert, getAvailableBalance } from './executeTrade.js';

// ─── MULTI-SYMBOL ORCHESTRATOR ────────────────────────────────────────────────
// At startup: fetches live account balance, divides equally among symbols.
// Each symbol gets its own bot-state-{SYMBOL}.json with its allocated share.
// Symbols trade independently — a loss on XAUUSDT doesn't affect ETHUSDT.
// If a symbol's stack drops below $0.60, it pauses and alerts Telegram.

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';

// TP/SL, exit timeouts and loss cooldown are all per-asset in executeTrade's
// getConfig (not here, not env). This orchestrator only owns spawn-level concerns:
// which symbols, leverage cap, and the liquidity-wall notional floor.
interface SymbolConfig {
    marketSymbol:    string;
    displaySymbol:   string;
    wsSymbol:        string;
    leverage:        number;
    wallMinNotional: number;
}

// Only 0%-maker symbols: XAUUSDT, plus the USDC-margined BTC/ETH perps (BTCUSDC /
// ETHUSDC) which also have 0% maker. The USDT crypto pairs (BTCUSDT/ETHUSDT/DOGE)
// charge 0.02% maker / 0.05% taker — ~4% of margin round-trip at 100x — so they
// bleed on fees and are intentionally excluded.
const SYMBOLS: SymbolConfig[] = [
    { marketSymbol: 'XAUUSDT', displaySymbol: 'XAU/USDT', wsSymbol: 'xauusdt', leverage: 50, wallMinNotional: 20_000 },
    // Disabled — too volatile for no-SL tiny-TP (ATR ~$96 → rides to liquidation on
    // cross margin). Re-enable only with a stop-loss or much larger TP.
    // { marketSymbol: 'BTCUSDC', displaySymbol: 'BTC/USDC', wsSymbol: 'btcusdc', leverage: 100, wallMinNotional: 100_000 },
    // { marketSymbol: 'ETHUSDC', displaySymbol: 'ETH/USDC', wsSymbol: 'ethusdc', leverage: 100, wallMinNotional: 50_000 },
];

// ─── PROCESS REGISTRY ─────────────────────────────────────────────────────────
interface ManagedProcess {
    config:    SymbolConfig;
    child:     ChildProcess | null;
    restarts:  number;
    lastStart: number;
}

// Populated in initBankrolls() with only the symbols the live balance can afford.
let registry: ManagedProcess[] = [];

// Minimum balance to give a symbol its own bankroll share.
const MIN_PER_SYMBOL = Number(process.env.MIN_STACK ?? 0.60);

// ─── SPAWN ONE SYMBOL BOT ─────────────────────────────────────────────────────
function spawnSymbol(entry: ManagedProcess): void {
    const cfg      = entry.config;
    const bankroll = loadBankroll(cfg.marketSymbol);

    if (!bankroll) {
        console.error(`[Orchestrator] ❌ No bankroll file for ${cfg.marketSymbol} — run startup first`);
        return;
    }
    if (bankroll.paused) {
        console.log(`[Orchestrator] ⛔ ${cfg.marketSymbol} paused (${bankroll.pausedReason}) — skipping`);
        return;
    }

    const margin = getCurrentMargin(bankroll);

    // Target & signal knobs (TP_ATR_MULT, SL_ATR_MULT, ATR_CEIL_PCT, MOM_*_ATR, …)
    // are inherited from .env via ...process.env, or fall back to code defaults.
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        MARKET_SYMBOL:     cfg.marketSymbol,
        DISPLAY_SYMBOL:    cfg.displaySymbol,
        WS_SYMBOL:         cfg.wsSymbol,
        MARGIN_PER_TRADE:  String(margin),
        BOT_LEVERAGE:      String(cfg.leverage),
        WALL_MIN_NOTIONAL: String(cfg.wallMinNotional),
        STATE_FILE:        `./bot-state-${cfg.marketSymbol}.json`,
        TRADE_LOG_FILE:    `./tradeLog-${cfg.marketSymbol}.jsonl`,
        STATE_DIR:         '.',
    };

    // Run TypeScript directly via tsx (no build step). `node --import tsx` keeps
    // the loader registered for the child process.
    const child = spawn(process.execPath, ['--import', 'tsx', 'main.ts'], {
        env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });

    entry.child    = child;
    entry.lastStart = Date.now();

    const tag = `[${cfg.marketSymbol}]`;
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`${tag} ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`${tag} ${d}`));

    child.on('exit', (code, signal) => {
        entry.child = null;
        const latest = loadBankroll(cfg.marketSymbol);
        if (latest?.paused) {
            console.log(`${tag} ⛔ Bankroll exhausted — not restarting`);
            return;
        }
        entry.restarts++;
        const uptime    = Date.now() - entry.lastStart;
        const backoffMs = entry.restarts > 5 && uptime < 120_000 ? 30_000 : 5_000;
        console.warn(`${tag} ⚠️  Exited (code=${code}) — restarting in ${backoffMs/1000}s`);
        setTimeout(() => spawnSymbol(entry), backoffMs);
    });

    console.log(`${tag} 🚀 Started | stack=$${bankroll.stack.toFixed(4)} margin=$${margin.toFixed(2)} ${cfg.leverage}x`);
}

// ─── STARTUP: RUN ONLY WHAT THE BALANCE AFFORDS ──────────────────────────────
// Never hard-exit on low balance (that would crash-loop under pm2). Instead run
// as many of the configured symbols as the live balance can fund — at least 1.
async function initBankrolls(): Promise<void> {
    const balance = await getAvailableBalance();
    console.log(`[Orchestrator] Live balance: $${balance.toFixed(4)}`);

    // How many symbols can we afford? Clamp to [1, SYMBOLS.length].
    const affordable = Math.max(1, Math.min(SYMBOLS.length, Math.floor(balance / MIN_PER_SYMBOL)));
    const active     = SYMBOLS.slice(0, affordable);

    if (affordable < SYMBOLS.length) {
        const msg = `⚠️ Balance $${balance.toFixed(2)} — running ${affordable}/${SYMBOLS.length} symbol(s): ${active.map(s => s.marketSymbol).join(', ')}`;
        console.warn(`[Orchestrator] ${msg}`);
        await sendAlert(msg);
    }

    const sharePerSymbol = balance / active.length;
    console.log(`[Orchestrator] Allocating $${sharePerSymbol.toFixed(4)} per symbol across ${active.length}`);

    for (const cfg of active) {
        const existing = loadBankroll(cfg.marketSymbol);
        if (existing && !existing.paused) {
            console.log(`[Orchestrator] ${cfg.marketSymbol}: existing bankroll restored — stack=$${existing.stack.toFixed(4)}`);
        } else if (existing?.paused) {
            console.log(`[Orchestrator] ${cfg.marketSymbol}: ⛔ paused — skipping`);
        } else {
            createBankroll(cfg.marketSymbol, sharePerSymbol);
            console.log(`[Orchestrator] ${cfg.marketSymbol}: created — stack=$${sharePerSymbol.toFixed(4)}`);
        }
    }

    // Build the process registry from only the affordable, non-paused symbols.
    registry = active
        .filter(cfg => !loadBankroll(cfg.marketSymbol)?.paused)
        .map(cfg => ({ config: cfg, child: null, restarts: 0, lastStart: 0 }));
}

// ─── STATUS HEARTBEAT ─────────────────────────────────────────────────────────
setInterval(async () => {
    console.log(`\n[Orchestrator] ── Status ──`);
    for (const e of registry) {
        const b = loadBankroll(e.config.marketSymbol);
        if (!b) continue;
        const alive  = e.child ? '🟢' : (b.paused ? '⛔' : '🔴');
        const uptime = e.child ? `${((Date.now()-e.lastStart)/60_000).toFixed(1)}m` : 'down';
        console.log(`  ${alive} uptime=${uptime} restarts=${e.restarts} | ${bankrollSummary(b)}`);
    }
    console.log('');
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
console.log(`  MULTI-SYMBOL SCALPER`);
console.log(`  ENV     : ${ENVIRONMENT}`);
console.log(`  SYMBOLS : ${SYMBOLS.map(s => s.marketSymbol).join(', ')}`);
console.log(`  BANK    : 30% profit protected | 70% compounds | 100% stack as margin`);
console.log(`  PAUSE   : stack < $0.60 → symbol pauses automatically`);
console.log(`${'═'.repeat(70)}\n`);

// Init bankrolls then stagger-start the affordable symbols. Never exit on error —
// exiting under pm2 would crash-loop. If startup fails or nothing is runnable, the
// process idles (status heartbeat keeps it alive) until restarted or funded.
initBankrolls().then(() => {
    if (registry.length === 0) {
        console.warn(`[Orchestrator] No runnable symbols (balance too low or all paused) — idling.`);
        return;
    }
    registry.forEach((entry, i) => {
        setTimeout(() => spawnSymbol(entry), i * 3_000);
    });
}).catch(async (e) => {
    console.error(`[Orchestrator] Startup error (idling, not exiting): ${e.message}`);
    await sendAlert(`🚨 Orchestrator startup error: ${e.message} — idling.`).catch(() => {});
});
