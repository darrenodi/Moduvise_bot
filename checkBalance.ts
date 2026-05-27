import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
dotenv.config();

async function testHyperliquidConnection() {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🔍 HYPERLIQUID WALLET VERIFICATION`);
    console.log(`${'═'.repeat(50)}\n`);

    const wallet = process.env.HYPERLIQUID_WALLET_ADDRESS;
    const secret = process.env.HYPERLIQUID_API_SECRET;

    if (!wallet || !secret) {
        console.error(`❌ ERROR: Missing API keys in your .env file.`);
        return;
    }

    console.log(`[Config] Main Wallet Address: ${wallet}`);
    console.log(`[Config] Agent Secret Loaded: ${secret.substring(0, 6)}...`);
    
    // Initialize standard connection
    const exchange = new ccxt.hyperliquid({
        apiKey: wallet,
        secret: secret,
        walletAddress: wallet, // Required for Hyperliquid CCXT
        enableRateLimit: true,
    });

    try {
        console.log(`\n[Network] Pinging Hyperliquid Layer-1...`);
        
        // Explicitly route to the main funding wallet
        const balances = await exchange.fetchBalance({
            'user': wallet
        });

        const usdc = balances['USDC'];

        if (!usdc) {
            console.log(`\n⚠️  WARNING: API connected successfully, but no USDC object was returned.`);
            console.log(`   This usually means the account has literally 0 volume history or the Agent isn't authorized.`);
            console.log(`\n   Raw Balance Object Dump:`);
            console.log(balances.info);
            return;
        }

        console.log(`\n✅ CONNECTION SUCCESSFUL!`);
        console.log(`\n💰 YOUR USDC WALLET STATS:`);
        console.log(`   Total USDC: $${usdc.total}`);
        console.log(`   Free USDC:  $${usdc.free}`);
        console.log(`   Used Margin:$${usdc.used}`);
        console.log(`\n${'═'.repeat(50)}`);

    } catch (error: any) {
        console.error(`\n❌ CRITICAL API ERROR:`);
        console.error(error.message || error);
        console.log(`\nTroubleshooting:`);
        console.log(`1. Double check your Agent Secret is correct.`);
        console.log(`2. Ensure your Agent was authorized by your Main Wallet.`);
    }
}

testHyperliquidConnection();