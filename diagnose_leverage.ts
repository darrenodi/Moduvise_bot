import * as dotenv from 'dotenv';
import { createHmac } from 'crypto';
dotenv.config();

const API_KEY    = process.env.BINANCE_BOT_API    ?? '';
const API_SECRET = process.env.BINANCE_BOT_SECRET ?? '';
const BASE       = 'https://demo-fapi.binance.com';
const SYMBOL     = 'XAUUSDT';

function sign(params: Record<string, string | number>): string {
    const ts      = Date.now();
    const entries = { ...params, timestamp: ts, recvWindow: 10000 };
    const query   = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('&');
    const sig     = createHmac('sha256', API_SECRET).update(query).digest('hex');
    return query + '&signature=' + sig;
}

async function post(path: string, params: Record<string, string | number>) {
    const qs  = sign(params);
    const res = await fetch(`${BASE}${path}`, {
        method:  'POST',
        headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    qs,
    });
    return { status: res.status, body: await res.text() };
}

async function get(path: string, params: Record<string, string | number> = {}) {
    const qs  = sign(params);
    const res = await fetch(`${BASE}${path}?${qs}`, {
        headers: { 'X-MBX-APIKEY': API_KEY },
    });
    return { status: res.status, body: await res.text() };
}

console.log('\n── LEVERAGE & ACCOUNT DIAGNOSTICS ──\n');

// 1. Check current leverage bracket
console.log('1. Leverage brackets for XAUUSDT:');
const brackets = await get('/fapi/v1/leverageBracket', { symbol: SYMBOL });
console.log(`   Status: ${brackets.status}`);
console.log(`   ${brackets.body.slice(0, 300)}\n`);

// 2. Try setting leverage to 10x
console.log('2. Set leverage 10x:');
const lev10 = await post('/fapi/v1/leverage', { symbol: SYMBOL, leverage: 10 });
console.log(`   Status: ${lev10.status} | ${lev10.body}\n`);

// 3. Try setting leverage to 20x
console.log('3. Set leverage 20x:');
const lev20 = await post('/fapi/v1/leverage', { symbol: SYMBOL, leverage: 20 });
console.log(`   Status: ${lev20.status} | ${lev20.body}\n`);

// 4. Check position mode
console.log('4. Position mode:');
const posMode = await get('/fapi/v1/positionSide/dual');
console.log(`   Status: ${posMode.status} | ${posMode.body}\n`);

// 5. Check account info
console.log('5. Account info:');
const acct = await get('/fapi/v2/account');
const acctData = JSON.parse(acct.body);
console.log(`   canTrade: ${acctData.canTrade}`);
console.log(`   feeTier: ${acctData.feeTier}`);
console.log(`   multiAssetsMargin: ${acctData.multiAssetsMargin}\n`);

// 6. Check exchange info for XAUUSDT limits
console.log('6. XAUUSDT exchange info:');
const exInfo = await fetch(`${BASE}/fapi/v1/exchangeInfo`).then(r => r.json()) as any;
const sym = exInfo.symbols?.find((s: any) => s.symbol === SYMBOL);
if (sym) {
    console.log(`   status: ${sym.status}`);
    console.log(`   minQty: ${sym.filters?.find((f: any) => f.filterType === 'LOT_SIZE')?.minQty}`);
    console.log(`   maxLeverage: ${sym.leverageFilter?.maxLeverage ?? 'N/A'}`);
    console.log(`   contractType: ${sym.contractType}`);
}

// 7. Try sign the TradFi contract via API
console.log('\n7. Attempt TradFi contract sign:');
const contract = await post('/fapi/v1/stock/contract', {});
console.log(`   Status: ${contract.status} | ${contract.body}\n`);

console.log('── DONE ──\n');
