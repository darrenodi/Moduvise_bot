import * as dotenv from 'dotenv';
import { createHmac } from 'crypto';
dotenv.config();

const API_KEY    = process.env.BINANCE_BOT_API    ?? '';
const API_SECRET = process.env.BINANCE_BOT_SECRET ?? '';
const BASE       = 'https://demo-fapi.binance.com';

function sign(query: string): string {
    return createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function get(path: string, label: string) {
    const ts    = Date.now();
    const query = `timestamp=${ts}&recvWindow=10000`;
    const sig   = sign(query);
    const url   = `${BASE}${path}?${query}&signature=${sig}`;
    try {
        const res  = await fetch(url, { headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        console.log(`\n[${res.status}] ${label}`);
        console.log(text.slice(0, 400));
    } catch (e: any) {
        console.log(`\n[ERR] ${label}: ${e.message}`);
    }
}

console.log(`\nBase: ${BASE}\nKey: ${API_KEY.slice(0,8)}...${API_KEY.slice(-4)}\n`);

await get('/fapi/v1/balance',  'v1/balance');
await get('/fapi/v2/balance',  'v2/balance');
await get('/fapi/v3/balance',  'v3/balance');
await get('/fapi/v2/account',  'v2/account');
await get('/fapi/v3/account',  'v3/account (positions only)');
