import * as fs   from 'fs';
import * as path from 'path';

// ─── PER-SYMBOL BANKROLL ──────────────────────────────────────────────────────
// Each symbol gets an equal share of the starting account balance.
// Example: $6 balance, 4 symbols → $1.50 each.
//
// Each symbol tracks its own stack independently:
//   - Wins: 30% banked (protected forever), 70% added back to stack
//   - Losses: deducted from stack only
//   - Stack < $0.60: symbol pauses, Telegram alert sent
//   - Stack grows: margin scales up automatically (compounds)
//   - Banked profit: never touched, never counted toward trading
//
// State stored in bot-state-{SYMBOL}.json — one file per symbol.
// The orchestrator writes the initial allocation once at startup.

export interface SymbolBankroll {
    symbol:        string;
    stack:         number;   // active trading capital for this symbol
    banked:        number;   // protected profit — never used for trading
    transferred:   number;   // banked USDT physically swept to Spot (of `banked`)
    initialStack:  number;   // what we started with
    trades:        number;
    wins:          number;
    losses:        number;
    paused:        boolean;
    pausedReason:  string;
    updatedAt:     string;
}

const BANK_SPLIT   = Number(process.env.BANK_SPLIT ?? 0.30);   // 30% of profit banked, 70% compounds
const MIN_STACK    = Number(process.env.MIN_STACK ?? 0.60);    // pause if stack drops below this
const STATE_DIR    = process.env.STATE_DIR ?? '.';

function stateFile(symbol: string): string {
    return path.join(STATE_DIR, `bot-state-${symbol}.json`);
}

export function loadBankroll(symbol: string): SymbolBankroll | null {
    try {
        const f = stateFile(symbol);
        if (fs.existsSync(f)) {
            return JSON.parse(fs.readFileSync(f, 'utf-8')) as SymbolBankroll;
        }
    } catch (e: any) {
        console.error(`[Bankroll:${symbol}] Load failed: ${e.message}`);
    }
    return null;
}

export function saveBankroll(b: SymbolBankroll): void {
    try {
        b.updatedAt = new Date().toISOString();
        fs.writeFileSync(stateFile(b.symbol), JSON.stringify(b, null, 2));
    } catch (e: any) {
        console.error(`[Bankroll:${b.symbol}] Save failed: ${e.message}`);
    }
}

export function createBankroll(symbol: string, initialStack: number): SymbolBankroll {
    const b: SymbolBankroll = {
        symbol,
        stack:        initialStack,
        banked:       0,
        transferred:  0,
        initialStack,
        trades:       0,
        wins:         0,
        losses:       0,
        paused:       false,
        pausedReason: '',
        updatedAt:    new Date().toISOString(),
    };
    saveBankroll(b);
    return b;
}

// Margin to use for next trade — deploy 100% of the stack (max compounding).
// The exchange available-balance check in main.ts caps this to real free margin,
// and calcSize enforces the exchange MIN_NOTIONAL floor. Env MARGIN_STACK_PCT can
// dial it back below 100% if desired.
export function getCurrentMargin(b: SymbolBankroll): number {
    const pct = Number(process.env.MARGIN_STACK_PCT ?? 100) / 100;
    return b.stack * pct;
}

// Apply win or loss — returns updated bankroll and whether symbol should pause
export function applyTradeResult(
    b:          SymbolBankroll,
    pnl:        number,
): { updated: SymbolBankroll; shouldPause: boolean } {
    b.trades++;

    if (pnl > 0) {
        b.wins++;
        const toBank  = pnl * BANK_SPLIT;
        const toStack = pnl * (1 - BANK_SPLIT);
        b.banked += toBank;
        b.stack  += toStack;
        console.log(
            `[Bankroll:${b.symbol}] 🟢 +$${pnl.toFixed(4)} | ` +
            `bank +$${toBank.toFixed(4)} | stack +$${toStack.toFixed(4)} | ` +
            `stack=$${b.stack.toFixed(4)} banked=$${b.banked.toFixed(4)}`
        );
    } else {
        b.losses++;
        b.stack = Math.max(0, b.stack + pnl);
        console.log(
            `[Bankroll:${b.symbol}] 🔴 $${pnl.toFixed(4)} | ` +
            `stack=$${b.stack.toFixed(4)} banked=$${b.banked.toFixed(4)}`
        );
    }

    const shouldPause = b.stack < MIN_STACK && !b.paused;
    if (shouldPause) {
        b.paused      = true;
        b.pausedReason = `Stack $${b.stack.toFixed(4)} below minimum $${MIN_STACK}`;
    }

    saveBankroll(b);
    return { updated: b, shouldPause };
}

export function bankrollSummary(b: SymbolBankroll): string {
    const wr    = b.trades > 0 ? ((b.wins / b.trades) * 100).toFixed(0) : '0';
    const total = b.stack + b.banked;
    const roi   = b.initialStack > 0
        ? (((total - b.initialStack) / b.initialStack) * 100).toFixed(1)
        : '0';
    return (
        `${b.symbol.padEnd(10)}: stack=$${b.stack.toFixed(4)} banked=$${b.banked.toFixed(4)} ` +
        `| ${b.wins}W/${b.losses}L WR=${wr}% ROI=${roi}% ` +
        `| ${b.paused ? '⛔ PAUSED' : '🟢 active'}`
    );
}
