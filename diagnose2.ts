import * as dotenv from 'dotenv';
import { createHmac } from 'crypto';
dotenv.config();

const API_KEY    = process.env.BINANCE_BOT_API    ?? '';
const API_SECRET = process.env.BINANCE_BOT_SECRET ?? '';

function sign(query: string): string {
    return createHmac('sha256', API_SECRET).update(query).digest('hex');
}

console.log('\n── TESTING demo-fapi.binance.com ──\n');

// Public ping first
const ping = await fetch('https://demo-fapi.binance.com/fapi/v1/ping');
console.log(`Public ping: ${ping.ok ? '✅ OK' : '❌ FAIL'} (${ping.status})`);

// Signed balance
const ts    = Date.now();
const query = `timestamp=${ts}`;
const sig   = sign(query);
const url   = `https://demo-fapi.binance.com/fapi/v3/balance?${query}&signature=${sig}`;

const res  = await fetch(url, { headers: { 'X-MBX-APIKEY': API_KEY } });
const text = await res.text();
console.log(`\nBalance endpoint: ${res.ok ? '✅ OK' : '❌ FAIL'} (${res.status})`);

if (res.ok) {
    const data = JSON.parse(text) as any[];
    console.log('\n── ASSETS WITH BALANCE ──\n');
    for (const a of data) {
        if (parseFloat(a.balance ?? '0') > 0 || parseFloat(a.availableBalance ?? '0') > 0) {
            console.log(`✅ ${a.asset}: balance=${a.balance} available=${a.availableBalance}`);
        }
    }
    const zeros = data.filter((a: any) => parseFloat(a.balance ?? '0') === 0).map((a: any) => a.asset);
    console.log(`\nZero assets: ${zeros.join(', ')}`);
} else {
    console.log(`Error body: ${text.slice(0, 200)}`);
}
