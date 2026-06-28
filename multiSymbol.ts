import * as dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs   from 'fs';
import { loadBankroll, saveBankroll, bankrollSummary } from './symbolBankroll.js';
import { sendAlert } from './executeTrade.js';
dotenv.config();

// ─── MULTI-SYMBOL ORCHESTRATOR ────────────────────────────────────────────────
// Runs XAUUSDT, ETHUSDT, DOGEUSDT, BTCUSDT as independent bot processes.
//
// Each symbol:
//   - Starts with $1 margin (tracked in bankroll-{SYMBOL}.json)
//   - Has its own TP/SL parameters calibrated to its ATR
//   - Has its own velocity WebSocket stream
//   - Has its own trade log and state file
//   - Pauses automatically if bankroll exhausted
//   - Computes margin dynamically from current bankroll tier
//
// Bankroll tiers (auto-scaled from symbolBankroll.ts):
//   $0.00 – $1.00 : $1 margin
//   $1.00 – $2.00 : $1.50 margin
//   $2.00 – $5.00 : $2 margin
//   $5.00+        : $3 margin (cap)

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';

interface SymbolConfig {
    marketSymbol:   string;
    displaySymbol:  string;
    wsSymbol:       string;
    leverage:       number;
    initialMargin:  number;   // starting bankroll
    // TP parameters — calibrated per asset ATR profile
    tpAtrMult:      number;
    tpMin:          number;   // absolute floor TP in USD
    tpMax:          number;   // absolute ceiling TP in USD
    // ATR ceiling — above this, bot sits out (trap market)
    atrCeiling:     number;
    // Momentum trap threshold — blocks if 5m mom > this against direction
    momentumTrap:   number;
    // Loss cooldown ms after any SL hit
    lossCooldownMs: number;
}

const SYMBOLS: SymbolConfig[] = [
    {
        // GOLD: tight scalper, small TP, very low ATR ceiling
        marketSymbol:   'XAUUSDT',
        displaySymbol:  'XAU/USDT',
        wsSymbol:       'xauusdt',
        leverage:       100,
        initialMargin:  1,
        tpAtrMult:      0.15,
        tpMin:          0.10,   // minimum $0.10 TP on gold
        tpMax:          1.00,
        atrCeiling:     6.00,
        momentumTrap:   0.30,
        lossCooldownMs: 120_000,
    },
    {
        // ETH: bigger ATR, bigger TP — signals are excellent, let them run
        marketSymbol:   'ETHUSDT',
        displaySymbol:  'ETH/USDT',
        wsSymbol:       'ethusdt',
        leverage:       100,
        initialMargin:  1,
        tpAtrMult:      0.50,   // ETH ATR ~$3-8 → TP $1.50-4.00
        tpMin:          1.00,   // minimum $1 TP — clears fees, captures real moves
        tpMax:          10.00,  // allow up to $10 TP on big ATR sessions
        atrCeiling:     30.00,  // ETH can move $20+ — much higher ceiling
        momentumTrap:   2.00,   // ETH momentum in $2 units
        lossCooldownMs: 180_000,
    },
    {
        // DOGE: very small prices, large qty, moderate TP
        marketSymbol:   'DOGEUSDT',
        displaySymbol:  'DOGE/USDT',
        wsSymbol:       'dogeusdt',
        leverage:       100,
        initialMargin:  1,
        tpAtrMult:      0.30,
        tpMin:          0.0005,
        tpMax:          0.005,
        atrCeiling:     0.005,
        momentumTrap:   0.001,
        lossCooldownMs: 120_000,
    },
    {
        // BTC: highest ATR, biggest TP, wider SL
        marketSymbol:   'BTCUSDT',
        displaySymbol:  'BTC/USDT',
        wsSymbol:       'btcusdt',
        leverage:       100,
        initialMargin:  1,
        tpAtrMult:      0.40,   // BTC ATR ~$50-200 → TP $20-80
        tpMin:          5.00,   // minimum $5 TP on BTC
        tpMax:          100.00,
        atrCeiling:     500.00, // BTC can move $300+ legitimately
        momentumTrap:   10.00,  // BTC momentum in $10 units
        lossCooldownMs: 180_000,
    },
];

// ─── PROCESS REGISTRY ─────────────────────────────────────────────────────────
interface ManagedProcess {
    config:     SymbolConfig;
    child:      ChildProcess | null;
    restarts:   number;
    lastStart:  number;
    paused:     boolean;
}

const registry: ManagedProcess[] = SYMBOLS.map(cfg => ({
    config:    cfg,
    child:     null,
    restarts:  0,
    lastStart: 0,
    paused:    false,
}));

// ─── SPAWN ONE SYMBOL BOT ─────────────────────────────────────────────────────
function spawnSymbol(entry: ManagedProcess): void {
    const cfg = entry.config;

    // Check bankroll — don't spawn if paused
    const bankroll = loadBankroll(cfg.marketSymbol, cfg.initialMargin);
    if (bankroll.paused) {
        console.log(`[Orchestrator] ⛔ ${cfg.marketSymbol} bankroll paused — not starting. Deposit more to resume.`);
        entry.paused = true;
        return;
    }

    // Dynamic margin from current bankroll tier
    const margin = getCurrentMargin(bankroll);

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Symbol identity
        MARKET_SYMBOL:    cfg.marketSymbol,
        DISPLAY_SYMBOL:   cfg.displaySymbol,
        WS_SYMBOL:        cfg.wsSymbol,
        // Sizing — dynamic from bankroll
        MARGIN_PER_TRADE: String(margin),
        BOT_LEVERAGE:     String(cfg.leverage),
        // TP parameters
        TP_ATR_MULT:      String(cfg.tpAtrMult),
        TP_MIN:           String(cfg.tpMin),
        TP_MAX:           String(cfg.tpMax),
        // Gates
        ATR_CEILING:      String(cfg.atrCeiling),
        MOMENTUM_TRAP:    String(cfg.momentumTrap),
        LOSS_COOLDOWN_MS: String(cfg.lossCooldownMs),
        // Isolated state & logs
        STATE_FILE:       `./bot-state-${cfg.marketSymbol}.json`,
        TRADE_LOG_FILE:   `./tradeLog-${cfg.marketSymbol}.jsonl`,
        STATE_DIR:        '.',
    };

    const child = spawn('node', ['dist/main.js'], {
        env,
        cwd:   process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    entry.child     = child;
    entry.lastStart = Date.now();
    entry.paused    = false;

    const tag = `[${cfg.marketSymbol}]`;

    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`${tag} ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`${tag} ${d}`));

    child.on('exit', (code, signal) => {
        entry.child = null;

        // Check if bankroll was exhausted (paused state written by child)
        const updated = loadBankroll(cfg.marketSymbol, cfg.initialMargin);
        if (updated.paused) {
            console.log(`${tag} ⛔ Bankroll exhausted — not restarting`);
            entry.paused = true;
            return;
        }

        entry.restarts++;
        const uptime    = Date.now() - entry.lastStart;
        const backoffMs = entry.restarts > 5 && uptime < 120_000 ? 30_000 : 5_000;
        if (backoffMs > 5_000) console.warn(`${tag} ⏳ Too many restarts — backing off ${backoffMs/1000}s`);
        console.warn(`${tag} ⚠️  Exited (code=${code} signal=${signal}) — restarting in ${backoffMs/1000}s`);
        setTimeout(() => spawnSymbol(entry), backoffMs);
    });

    console.log(`${tag} 🚀 Started | margin=$${margin.toFixed(2)} | ${cfg.leverage}x | stack=$${bankroll.tradingStack.toFixed(4)}`);
}

// ─── STATUS HEARTBEAT ─────────────────────────────────────────────────────────
setInterval(async () => {
    console.log(`\n[Orchestrator] ── Status ──`);
    for (const e of registry) {
        const bankroll = loadBankroll(e.config.marketSymbol, e.config.initialMargin);
        const alive    = e.child ? '🟢' : (e.paused ? '⛔' : '🔴');
        const uptime   = e.child ? `${((Date.now()-e.lastStart)/60_000).toFixed(1)}m` : 'down';
        console.log(`  ${alive} ${e.config.marketSymbol.padEnd(10)} uptime=${uptime} restarts=${e.restarts} | ${bankrollSummary(bankroll)}`);
    }
    console.log('');

    // Daily summary via Telegram
    const hour = new Date().getUTCHours();
    const min  = new Date().getUTCMinutes();
    if (hour === 0 && min < 2) {
        const lines = SYMBOLS.map(s => {
            const b = loadBankroll(s.marketSymbol, s.initialMargin);
            return bankrollSummary(b);
        });
        await sendAlert(`📊 Daily Bankroll Summary:\n${lines.join('\n')}`);
    }
}, 60_000);

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
function shutdown(signal: string): void {
    console.log(`\n[Orchestrator] ${signal} — stopping all symbol bots...`);
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
console.log(`  MULTI-SYMBOL SCALPER ORCHESTRATOR`);
console.log(`  ENV      : ${ENVIRONMENT}`);
console.log(`  SYMBOLS  : ${SYMBOLS.map(s => s.marketSymbol).join(', ')}`);
console.log(`  BANKROLL : $${SYMBOLS[0].initialMargin} per symbol (auto-scales with wins)`);
console.log(`  BANK     : 50% of profit protected, 50% compounds`);
console.log(`${'═'.repeat(70)}\n`);

// Print current bankroll status
for (const cfg of SYMBOLS) {
    const b = loadBankroll(cfg.marketSymbol, cfg.initialMargin);
    console.log(`  ${bankrollSummary(b)}`);
}
console.log('');

// Stagger starts by 3s to avoid hammering Binance API
registry.forEach((entry, i) => {
    setTimeout(() => spawnSymbol(entry), i * 3_000);
});
