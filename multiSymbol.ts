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

interface SymbolConfig {
    marketSymbol:   string;
    displaySymbol:  string;
    wsSymbol:       string;
    leverage:       number;
    tpAtrMult:      number;
    tpMin:          number;
    tpMax:          number;
    atrCeiling:     number;
    momentumTrap:   number;
    lossCooldownMs: number;
    atrSlMult:      number;
}

const SYMBOLS: SymbolConfig[] = [
    {
        marketSymbol:   'XAUUSDT',
        displaySymbol:  'XAU/USDT',
        wsSymbol:       'xauusdt',
        leverage:       100,
        tpAtrMult:      0.15,
        tpMin:          0.10,
        tpMax:          1.00,
        atrCeiling:     6.00,
        momentumTrap:   0.30,
        lossCooldownMs: 120_000,
        atrSlMult:      2.00,
    },
    {
        // ETH signals are excellent — wide TP to capture the full move
        marketSymbol:   'ETHUSDT',
        displaySymbol:  'ETH/USDT',
        wsSymbol:       'ethusdt',
        leverage:       100,
        tpAtrMult:      0.50,   // ETH ATR ~$3-8 → TP $1.50-4.00
        tpMin:          1.00,   // minimum $1 TP — never lose to fees
        tpMax:          10.00,
        atrCeiling:     30.00,
        momentumTrap:   2.00,
        lossCooldownMs: 180_000,
        atrSlMult:      1.50,
    },
    {
        marketSymbol:   'DOGEUSDT',
        displaySymbol:  'DOGE/USDT',
        wsSymbol:       'dogeusdt',
        leverage:       75,     // max 75x on Binance for DOGE
        tpAtrMult:      0.30,
        tpMin:          0.0005,
        tpMax:          0.005,
        atrCeiling:     0.005,
        momentumTrap:   0.001,
        lossCooldownMs: 120_000,
        atrSlMult:      2.00,
    },
    {
        marketSymbol:   'BTCUSDT',
        displaySymbol:  'BTC/USDT',
        wsSymbol:       'btcusdt',
        leverage:       100,
        tpAtrMult:      0.40,
        tpMin:          5.00,
        tpMax:          100.00,
        atrCeiling:     500.00,
        momentumTrap:   10.00,
        lossCooldownMs: 180_000,
        atrSlMult:      0.50,   // BTC ATR ~$60 → SL ~$30
    },
];

// ─── PROCESS REGISTRY ─────────────────────────────────────────────────────────
interface ManagedProcess {
    config:    SymbolConfig;
    child:     ChildProcess | null;
    restarts:  number;
    lastStart: number;
}

const registry: ManagedProcess[] = SYMBOLS.map(cfg => ({
    config: cfg, child: null, restarts: 0, lastStart: 0,
}));

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

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        MARKET_SYMBOL:    cfg.marketSymbol,
        DISPLAY_SYMBOL:   cfg.displaySymbol,
        WS_SYMBOL:        cfg.wsSymbol,
        MARGIN_PER_TRADE: String(margin),
        BOT_LEVERAGE:     String(cfg.leverage),
        TP_ATR_MULT:      String(cfg.tpAtrMult),
        TP_MIN:           String(cfg.tpMin),
        TP_MAX:           String(cfg.tpMax),
        ATR_CEILING:      String(cfg.atrCeiling),
        MOMENTUM_TRAP:    String(cfg.momentumTrap),
        LOSS_COOLDOWN_MS: String(cfg.lossCooldownMs),
        ATR_SL_MULT:      String(cfg.atrSlMult),
        STATE_FILE:       `./bot-state-${cfg.marketSymbol}.json`,
        TRADE_LOG_FILE:   `./tradeLog-${cfg.marketSymbol}.jsonl`,
        STATE_DIR:        '.',
    };

    const child = spawn('node', ['dist/main.js'], {
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

// ─── STARTUP: DIVIDE BALANCE AMONG SYMBOLS ───────────────────────────────────
async function initBankrolls(): Promise<void> {
    const balance = await getAvailableBalance();
    console.log(`[Orchestrator] Live balance: $${balance.toFixed(4)}`);

    if (balance < SYMBOLS.length * 0.60) {
        console.error(`[Orchestrator] ❌ Balance $${balance.toFixed(2)} too low for ${SYMBOLS.length} symbols (need $${(SYMBOLS.length * 0.60).toFixed(2)} min)`);
        await sendAlert(`❌ Balance $${balance.toFixed(2)} too low to run ${SYMBOLS.length} symbols. Deposit more.`);
        process.exit(1);
    }

    const sharePerSymbol = balance / SYMBOLS.length;
    console.log(`[Orchestrator] Allocating $${sharePerSymbol.toFixed(4)} per symbol`);

    for (const cfg of SYMBOLS) {
        const existing = loadBankroll(cfg.marketSymbol);
        if (existing && !existing.paused) {
            // Already has a bankroll — don't reset it
            console.log(`[Orchestrator] ${cfg.marketSymbol}: existing bankroll restored — stack=$${existing.stack.toFixed(4)}`);
        } else if (existing?.paused) {
            console.log(`[Orchestrator] ${cfg.marketSymbol}: ⛔ paused — skipping`);
        } else {
            // First run — create fresh bankroll
            createBankroll(cfg.marketSymbol, sharePerSymbol);
            console.log(`[Orchestrator] ${cfg.marketSymbol}: created — stack=$${sharePerSymbol.toFixed(4)}`);
        }
    }
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
console.log(`  BANK    : 50% profit protected | 50% compounds per symbol`);
console.log(`  PAUSE   : stack < $0.60 → symbol pauses automatically`);
console.log(`${'═'.repeat(70)}\n`);

// Init bankrolls then stagger-start all symbols
initBankrolls().then(() => {
    registry.forEach((entry, i) => {
        setTimeout(() => spawnSymbol(entry), i * 3_000);
    });
}).catch(async (e) => {
    console.error(`[Orchestrator] Startup failed: ${e.message}`);
    await sendAlert(`🚨 Orchestrator startup failed: ${e.message}`);
    process.exit(1);
});
