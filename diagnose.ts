import * as dotenv from 'dotenv';
dotenv.config();

const API_KEY    = process.env.BINANCE_BOT_API    ?? '';
const API_SECRET = process.env.BINANCE_BOT_SECRET ?? '';

console.log('\n🔍 BINANCE DEMO API DIAGNOSTICS\n');
console.log(`API Key present:    ${API_KEY    ? `YES (${API_KEY.slice(0,8)}...${API_KEY.slice(-4)})` : '❌ MISSING'}`);
console.log(`API Secret present: ${API_SECRET ? `YES (${API_SECRET.slice(0,4)}...)` : '❌ MISSING'}`);
console.log(`ENVIRONMENT:        ${process.env.ENVIRONMENT ?? 'not set'}`);

// Test 1 — public endpoint (no auth needed)
const URLS = [
    'https://demo-api.binance.com/fapi/v1/ping',
    'https://demo-api.binance.com/fapi/v1/time',
    'https://testnet.binancefuture.com/fapi/v1/ping',
];

console.log('\n── PUBLIC ENDPOINT TESTS ─────────────────────────────────\n');
for (const url of URLS) {
    try {
        const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
        const text = await res.text();
        console.log(`${res.ok ? '✅' : '❌'} ${url}`);
        console.log(`   Status: ${res.status} | Body: ${text.slice(0, 80)}`);
    } catch (e: any) {
        console.log(`❌ ${url}`);
        console.log(`   Error: ${e.message}`);
    }
}

// Test 2 — signed balance endpoint
if (!API_KEY || !API_SECRET) {
    console.log('\n❌ No API credentials — skipping signed tests\n');
    process.exit(0);
}

import { createHmac } from 'crypto';

function sign(query: string, secret: string): string {
    return createHmac('sha256', secret).update(query).digest('hex');
}

const SIGNED_URLS = [
    'https://demo-api.binance.com/fapi/v3/balance',
    'https://demo-api.binance.com/fapi/v2/balance',
    'https://testnet.binancefuture.com/fapi/v3/balance',
    'https://testnet.binancefuture.com/fapi/v2/balance',
];

console.log('\n── SIGNED BALANCE TESTS ──────────────────────────────────\n');
for (const base of SIGNED_URLS) {
    const ts       = Date.now();
    const query    = `timestamp=${ts}`;
    const sig      = sign(query, API_SECRET);
    const url      = `${base}?${query}&signature=${sig}`;

    try {
        const res  = await fetch(url, {
            headers: { 'X-MBX-APIKEY': API_KEY },
            signal:  AbortSignal.timeout(6000),
        });
        const text = await res.text();
        console.log(`${res.ok ? '✅' : '❌'} ${base}`);
        console.log(`   Status: ${res.status} | Body: ${text.slice(0, 120)}`);
    } catch (e: any) {
        console.log(`❌ ${base}`);
        console.log(`   Error: ${e.message}`);
    }
}

console.log('\n─────────────────────────────────────────────────────────\n');
