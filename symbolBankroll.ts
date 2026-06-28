import * as fs   from 'fs';
import * as path from 'path';

// ─── PER-SYMBOL BANKROLL TRACKER ─────────────────────────────────────────────
// Each symbol gets its own $1 starting bankroll tracked independently.
// Wins: 50% banked (protected), 50% compounds into the trading stack.
// Losses: deducted from trading stack only.
// If trading stack hits $0: symbol is PAUSED and Telegram alert sent.
// If trading stack grows: margin per trade scales up proportionally.
//
// State persisted to bankroll-{SYMBOL}.json so restarts don't reset progress.
//
// Bankroll tiers (auto-scales margin):
//   $0.00 – $1.00 : $1 margin per trade (starting tier)
//   $1.00 – $2.00 : $1.50 margin per trade
//   $2.00 – $5.00 : $2.00 margin per trade
//   $5.00+        : $3.00 margin per trade (cap — don't overexpose)

export interface SymbolBankroll {
    symbol:         string;
    tradingStack:   number;   // active trading capital
    bankedProfit:   number;   // protected — never touched
    totalDeposited: number;   // initial deposit
    trades:         number;
    wins:           number;
    losses:         number;
    paused:         boolean;
    pausedReason:   string;
    lastUpdatedAt:  string;
}

const BANK_SPLIT  = 0.50;   // 50% of profit goes to banked
const STATE_DIR   = process.env.STATE_DIR ?? '.';

function stateFile(symbol: string): string {
    return path.join(STATE_DIR, `bankroll-${symbol}.json`);
}

export function loadBankroll(symbol: string, initialMargin = 1.0): SymbolBankroll {
    try {
        const f = stateFile(symbol);
        if (fs.existsSync(f)) {
            const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
            console.log(`[Bankroll:${symbol}] Restored — stack=$${raw.tradingStack.toFixed(4)} banked=$${raw.bankedProfit.toFixed(4)} paused=${raw.paused}`);
            return raw as SymbolBankroll;
        }
    } catch (e: any) {
        console.error(`[Bankroll:${symbol}] Load failed: ${e.message}`);
    }
    const fresh: SymbolBankroll = {
        symbol,
        tradingStack:   initialMargin,
        bankedProfit:   0,
        totalDeposited: initialMargin,
        trades:         0,
        wins:           0,
        losses:         0,
        paused:         false,
        pausedReason:   '',
        lastUpdatedAt:  new Date().toISOString(),
    };
    saveBankroll(fresh);
    return fresh;
}

export function saveBankroll(b: SymbolBankroll): void {
    try {
        b.lastUpdatedAt = new Date().toISOString();
        fs.writeFileSync(stateFile(b.symbol), JSON.stringify(b, null, 2));
    } catch (e: any) {
        console.error(`[Bankroll:${b.symbol}] Save failed: ${e.message}`);
    }
}

// Returns current margin to use for next trade based on stack size
export function getCurrentMargin(b: SymbolBankroll): number {
    const s = b.tradingStack;
    if (s >= 5.00) return 3.00;
    if (s >= 2.00) return 2.00;
    if (s >= 1.00) return 1.50;
    return Math.max(0.10, s); // use whatever is left, min $0.10
}

// Apply a trade result — win or loss
export async function applyResult(
    b:          SymbolBankroll,
    realizedPnl: number,
    sendAlert:   (msg: string) => Promise<void>,
): Promise<void> {
    b.trades++;
    if (realizedPnl > 0) {
        b.wins++;
        const toBank    = realizedPnl * BANK_SPLIT;
        const toStack   = realizedPnl * (1 - BANK_SPLIT);
        b.bankedProfit += toBank;
        b.tradingStack += toStack;
        console.log(
            `[Bankroll:${b.symbol}] 🟢 +$${realizedPnl.toFixed(4)} | ` +
            `bank +$${toBank.toFixed(4)} | stack +$${toStack.toFixed(4)} | ` +
            `total stack=$${b.tradingStack.toFixed(4)} banked=$${b.bankedProfit.toFixed(4)}`
        );
    } else {
        b.losses++;
        b.tradingStack = Math.max(0, b.tradingStack + realizedPnl);
        console.log(
            `[Bankroll:${b.symbol}] 🔴 $${realizedPnl.toFixed(4)} | ` +
            `stack=$${b.tradingStack.toFixed(4)} banked=$${b.bankedProfit.toFixed(4)}`
        );
    }

    // Pause if stack exhausted
    if (b.tradingStack < 0.05 && !b.paused) {
        b.paused      = true;
        b.pausedReason = `Trading stack exhausted ($${b.tradingStack.toFixed(4)} < $0.05)`;
        const msg =
            `⛔ ${b.symbol} PAUSED — bankroll exhausted\n` +
            `Trades: ${b.trades} | Wins: ${b.wins} | Losses: ${b.losses}\n` +
            `Banked profit (safe): $${b.bankedProfit.toFixed(4)}\n` +
            `Deposit more to resume, or restart with fresh state.`;
        await sendAlert(msg);
        console.log(`[Bankroll:${b.symbol}] ⛔ PAUSED: ${b.pausedReason}`);
    }

    saveBankroll(b);
}

// Daily summary per symbol
export function bankrollSummary(b: SymbolBankroll): string {
    const wr    = b.trades > 0 ? ((b.wins / b.trades) * 100).toFixed(0) : '0';
    const total = b.tradingStack + b.bankedProfit;
    const ret   = b.totalDeposited > 0
        ? (((total - b.totalDeposited) / b.totalDeposited) * 100).toFixed(1)
        : '0';
    return (
        `${b.symbol}: stack=$${b.tradingStack.toFixed(4)} banked=$${b.bankedProfit.toFixed(4)} ` +
        `| ${b.wins}W/${b.losses}L (${wr}% WR) | ROI: ${ret}% | ${b.paused ? '⛔ PAUSED' : '🟢 active'}`
    );
}
