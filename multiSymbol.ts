import * as dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
dotenv.config();

// ─── MULTI-SYMBOL ORCHESTRATOR ────────────────────────────────────────────────
// Runs XAUUSDT, ETHUSDT, DOGEUSDT as three fully independent bot processes.
// Each gets its own:
//   - $1 margin per trade (set via MARGIN_PER_TRADE env override)
//   - Separate compounding state file (bot-state-{symbol}.json)
//   - Separate trade log (tradeLog-{symbol}.jsonl)
//   - Separate velocity monitor WebSocket
//   - No shared memory — a crash in one does not affect others
//
// To start:  npx ts-node multiSymbol.ts   (or compile and run dist/multiSymbol.js)
// To stop:   pm2 stop all  (or Ctrl+C — SIGTERM propagates to children)

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';

interface SymbolConfig {
    marketSymbol:  string;   // Binance API symbol
    displaySymbol: string;   // Human label
    wsSymbol:      string;   // aggTrade stream name (lowercase)
    leverage:      number;
    marginPerTrade: number;  // USDT per trade
    tpAtrMult:     number;   // TP = ATR × this
    tpMin:         number;
    tpMax:         number;
}

const SYMBOLS: SymbolConfig[] = [
    {
        marketSymbol:   'XAUUSDT',
        displaySymbol:  'XAU/USDT',
        wsSymbol:       'xauusdt',
        leverage:       100,
        marginPerTrade: 1,
        tpAtrMult:      0.10,
        tpMin:          0.05,
        tpMax:          1.00,
    },
    {
        marketSymbol:   'ETHUSDT',
        displaySymbol:  'ETH/USDT',
        wsSymbol:       'ethusdt',
        leverage:       100,
        marginPerTrade: 1,
        tpAtrMult:      0.20,   // ETH ATR ~$3-8, 20% gives $0.60-1.60 TP — clears fees
        tpMin:          0.50,   // minimum $0.50 TP on ETH — fees eat anything smaller
        tpMax:          5.00,   // allow up to $5 TP in volatile sessions
    },
    {
        marketSymbol:   'DOGEUSDT',
        displaySymbol:  'DOGE/USDT',
        wsSymbol:       'dogeusdt',
        leverage:       100,
        marginPerTrade: 1,
        tpAtrMult:      0.20,
        tpMin:          0.0005, // DOGE ticks at $0.0001
        tpMax:          0.01,
    },
];

// ─── PROCESS REGISTRY ─────────────────────────────────────────────────────────
interface ManagedProcess {
    config:     SymbolConfig;
    child:      ChildProcess | null;
    restarts:   number;
    lastStart:  number;
}

const registry: ManagedProcess[] = SYMBOLS.map(cfg => ({
    config:    cfg,
    child:     null,
    restarts:  0,
    lastStart: 0,
}));

// ─── SPAWN ONE SYMBOL BOT ─────────────────────────────────────────────────────
// Each child process runs the existing compiled main.js with symbol-specific
// env overrides. No changes to main.ts needed.
function spawnSymbol(entry: ManagedProcess): void {
    const cfg = entry.config;

    // Per-symbol env overrides injected at spawn time
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Symbol identity
        MARKET_SYMBOL:    cfg.marketSymbol,
        DISPLAY_SYMBOL:   cfg.displaySymbol,
        WS_SYMBOL:        cfg.wsSymbol,
        // Sizing
        MARGIN_PER_TRADE: String(cfg.marginPerTrade),
        BOT_LEVERAGE:     String(cfg.leverage),
        TP_ATR_MULT:      String(cfg.tpAtrMult),
        TP_MIN:           String(cfg.tpMin),
        TP_MAX:           String(cfg.tpMax),
        // Loss cooldown per symbol — independent timers
        LOSS_COOLDOWN_MS: '120000',
        // Isolated state & logs
        STATE_FILE:       `./bot-state-${cfg.marketSymbol}.json`,
        TRADE_LOG_FILE:   `./tradeLog-${cfg.marketSymbol}.jsonl`,
    };

    // Run the compiled main.js (compile first: npx tsc)
    const child = spawn('node', ['dist/main.js'], {
        env,
        cwd:   process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    entry.child    = child;
    entry.lastStart = Date.now();

    const tag = `[${cfg.marketSymbol}]`;

    child.stdout?.on('data', (d: Buffer) => {
        process.stdout.write(`${tag} ${d.toString()}`);
    });

    child.stderr?.on('data', (d: Buffer) => {
        process.stderr.write(`${tag} ${d.toString()}`);
    });

    child.on('exit', (code, signal) => {
        console.warn(`${tag} ⚠️  Exited (code=${code} signal=${signal}) — restarting in 5s...`);
        entry.child = null;
        entry.restarts++;

        // Back off if crashing repeatedly (> 5 restarts in < 2 minutes)
        const uptime    = Date.now() - entry.lastStart;
        const backoffMs = entry.restarts > 5 && uptime < 120_000 ? 30_000 : 5_000;
        if (backoffMs > 5_000) {
            console.warn(`${tag} ⏳ Too many restarts — backing off ${backoffMs / 1000}s`);
        }

        setTimeout(() => spawnSymbol(entry), backoffMs);
    });

    console.log(`${tag} 🚀 Started | margin=$${cfg.marginPerTrade} | ${cfg.leverage}x | state=bot-state-${cfg.marketSymbol}.json`);
}

// ─── STATUS HEARTBEAT ─────────────────────────────────────────────────────────
setInterval(() => {
    const lines = registry.map(e => {
        const alive  = e.child ? '🟢' : '🔴';
        const uptime = e.child
            ? `${((Date.now() - e.lastStart) / 60_000).toFixed(1)}m`
            : 'down';
        return `  ${alive} ${e.config.marketSymbol.padEnd(10)} uptime=${uptime} restarts=${e.restarts}`;
    });
    console.log(`\n[Orchestrator] Status:\n${lines.join('\n')}\n`);
}, 60_000);

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
function shutdown(signal: string): void {
    console.log(`\n[Orchestrator] ${signal} — stopping all symbol bots...`);
    for (const entry of registry) {
        if (entry.child) {
            entry.child.removeAllListeners('exit'); // prevent restart on intentional kill
            entry.child.kill('SIGTERM');
        }
    }
    setTimeout(() => process.exit(0), 3_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── STARTUP ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`  MULTI-SYMBOL SCALPER ORCHESTRATOR`);
console.log(`  ENV      : ${ENVIRONMENT}`);
console.log(`  SYMBOLS  : ${SYMBOLS.map(s => s.marketSymbol).join(', ')}`);
console.log(`  MARGIN   : $${SYMBOLS[0].marginPerTrade} per trade per symbol`);
console.log(`  LEVERAGE : ${SYMBOLS[0].leverage}x`);
console.log(`  LOGS     : tradeLog-{SYMBOL}.jsonl`);
console.log(`  STATE    : bot-state-{SYMBOL}.json`);
console.log(`${'═'.repeat(70)}\n`);

// Stagger starts by 3s to avoid hammering Binance API simultaneously
registry.forEach((entry, i) => {
    setTimeout(() => spawnSymbol(entry), i * 3_000);
});
