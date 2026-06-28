import * as dotenv from 'dotenv';
dotenv.config();

// ─── VELOCITY MONITOR ─────────────────────────────────────────────────────────
// Maintains a rolling 5-second window of aggTrade buy/sell volume via WebSocket.
// This runs as a persistent background process — started once at boot, never
// polled. The main cycle reads getVelocityState() synchronously at zero latency.
//
// Why WebSocket and not polling:
//   A flush can start and complete inside 1-2 seconds. At a 10-30s poll cycle,
//   the bot would never see it coming. WebSocket gives sub-100ms detection.
//
// Buy vs sell classification:
//   Binance aggTrades set m=true when the maker is the buyer (i.e. the taker
//   is a seller hitting the bid). So:
//     m=true  → taker SOLD  → sellVolume++
//     m=false → taker BOUGHT → buyVolume++
//
// Multi-symbol: SYMBOL_LOWER and WS_SYMBOL are read from env vars so each
// child process spawned by multiSymbol.ts monitors its own symbol independently.

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'live';
const IS_TESTNET  = ENVIRONMENT !== 'live';

// Binance migrated aggTrade to /market/ws after 2026-04-23.
// Old: wss://fstream.binance.com/ws/{symbol}@aggTrade  → NO DATA (deprecated)
// New: wss://fstream.binance.com/market/ws/{symbol}@aggTrade → works
const WS_BASE   = IS_TESTNET ? 'wss://dstream.binancefuture.com' : 'wss://fstream.binance.com';
const WS_PREFIX = IS_TESTNET ? '/ws' : '/market/ws';

// Read from env — injected per-symbol by multiSymbol.ts orchestrator.
// Falls back to 'xauusdt' for backwards compatibility with single-symbol runs.
const SYMBOL_LOWER = (process.env.WS_SYMBOL ?? 'xauusdt').toLowerCase();

const WINDOW_MS   = 5_000;   // 5-second rolling window
const FLUSH_RATIO = 2.0;     // lowered: 2:1 sell/buy triggers flush
const SPIKE_RATIO = 2.0;     // lowered: 2:1 buy/sell triggers spike
const MIN_VOL     = 0.0001;  // minimum volume to count a flush (avoid false positives on zero)

// ─── ROLLING TRADE BUFFER ────────────────────────────────────────────────────
interface AggTick {
    ts:     number;   // timestamp ms
    qty:    number;   // quantity
    isSell: boolean;  // true = taker sold (hit bid)
}

const _buffer: AggTick[] = [];
let   _lastTs             = 0;
let   _wsReady            = false;
let   _wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Compact rolling state exposed to the main cycle
export interface VelocityState {
    buyVol5s:       number;   // quantity bought (taker) in last 5s
    sellVol5s:      number;   // quantity sold  (taker) in last 5s
    isBuyFlush:     boolean;  // spike: buyers aggressively hitting asks
    isSellFlush:    boolean;  // flush: sellers aggressively hitting bids
    ratio:          number;   // sellVol / buyVol (>1 = more selling)
    wsReady:        boolean;  // false until first message received
    staleSecs:      number;   // seconds since last tick (0 if live)
}

export function getVelocityState(): VelocityState {
    const cutoff = Date.now() - WINDOW_MS;

    // Evict ticks older than 5s
    while (_buffer.length > 0 && _buffer[0].ts < cutoff) _buffer.shift();

    let buyVol  = 0;
    let sellVol = 0;
    for (const t of _buffer) {
        if (t.isSell) sellVol += t.qty;
        else           buyVol  += t.qty;
    }

    const ratio       = buyVol > 0 ? sellVol / buyVol : (sellVol > 0 ? 99 : 1);
    const isSellFlush = sellVol > buyVol  * FLUSH_RATIO && sellVol > MIN_VOL;
    const isBuyFlush  = buyVol  > sellVol * SPIKE_RATIO  && buyVol  > MIN_VOL;
    const staleSecs   = _lastTs > 0 ? Math.floor((Date.now() - _lastTs) / 1000) : 999;

    return {
        buyVol5s:   Number(buyVol.toFixed(4)),
        sellVol5s:  Number(sellVol.toFixed(4)),
        isBuyFlush,
        isSellFlush,
        ratio:      Number(ratio.toFixed(2)),
        wsReady:    _wsReady,
        staleSecs,
    };
}

// ─── WEBSOCKET CONNECTION ─────────────────────────────────────────────────────
async function connect(): Promise<void> {
    const url = `${WS_BASE}${WS_PREFIX}/${SYMBOL_LOWER}@aggTrade`;
    console.log(`[VelocityMonitor:${SYMBOL_LOWER.toUpperCase()}] Connecting: ${url}`);

    // Use the built-in Node.js WebSocket (Node 22+) or ws package
    let ws: any;
    try {
        ws = new (globalThis as any).WebSocket(url);
        if (!ws) throw new Error('no global WebSocket');
    } catch {
        const { default: WS } = await import('ws');
        ws = new WS(url);
    }

    ws.onopen = () => {
        console.log(`[VelocityMonitor:${SYMBOL_LOWER.toUpperCase()}] ✅ Connected — streaming aggTrades`);
        _wsReady = true;
        if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    };

    ws.onmessage = (event: any) => {
        try {
            const raw  = typeof event.data === 'string' ? event.data : event.data.toString();
            const msg  = JSON.parse(raw);
            const data = msg.data ?? msg;   // unwrap stream envelope if present

            if (data.e !== 'aggTrade') return;

            const qty    = Number(data.q);
            const isSell = data.m === true;  // m=true → maker bought → taker sold
            const ts     = data.T ?? Date.now();

            _buffer.push({ ts, qty, isSell });
            _lastTs  = Date.now();
            _wsReady = true;
        } catch { /* malformed message — ignore */ }
    };

    ws.onerror = (err: any) => {
        console.error(`[VelocityMonitor:${SYMBOL_LOWER.toUpperCase()}] WebSocket error: ${err?.message ?? err}`);
    };

    ws.onclose = () => {
        _wsReady = false;
        console.warn(`[VelocityMonitor:${SYMBOL_LOWER.toUpperCase()}] ⚠️ WebSocket closed — reconnecting in 3s...`);
        _wsReconnectTimer = setTimeout(() => connect().catch(console.error), 3_000);
    };
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
// Called once from main.ts at boot. Runs forever in background.
let _started = false;
export function startVelocityMonitor(): void {
    if (_started) return;
    _started = true;
    connect().catch(console.error);
    // Heartbeat: log state every 30s
    setInterval(() => {
        const s = getVelocityState();
        const tag = `[VelocityMonitor:${SYMBOL_LOWER.toUpperCase()}]`;
        if (!s.wsReady) {
            console.warn(`${tag} ⚠️ Not ready — stale ${s.staleSecs}s`);
            return;
        }
        const arrow = s.isSellFlush ? '🔴 SELL FLUSH' : s.isBuyFlush ? '🟢 BUY SPIKE' : '⚪ calm';
        console.log(`${tag} ${arrow} | buy=${s.buyVol5s} sell=${s.sellVol5s} ratio=${s.ratio}x`);
    }, 30_000);
}
