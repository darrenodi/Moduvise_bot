"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var ccxt_1 = require("ccxt");
var dotenv = require("dotenv");
dotenv.config();
function testHyperliquidConnection() {
    return __awaiter(this, void 0, void 0, function () {
        var wallet, secret, exchange, balances, usdc, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("\n".concat('═'.repeat(50)));
                    console.log("\uD83D\uDD0D HYPERLIQUID WALLET VERIFICATION");
                    console.log("".concat('═'.repeat(50), "\n"));
                    wallet = process.env.HYPERLIQUID_WALLET_ADDRESS;
                    secret = process.env.HYPERLIQUID_API_SECRET;
                    if (!wallet || !secret) {
                        console.error("\u274C ERROR: Missing API keys in your .env file.");
                        return [2 /*return*/];
                    }
                    console.log("[Config] Main Wallet Address: ".concat(wallet));
                    console.log("[Config] Agent Secret Loaded: ".concat(secret.substring(0, 6), "..."));
                    exchange = new ccxt_1.default.hyperliquid({
                        apiKey: wallet,
                        secret: secret,
                        walletAddress: wallet, // Required for Hyperliquid CCXT
                        enableRateLimit: true,
                    });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    console.log("\n[Network] Pinging Hyperliquid Layer-1...");
                    return [4 /*yield*/, exchange.fetchBalance({
                            'user': wallet
                        })];
                case 2:
                    balances = _a.sent();
                    usdc = balances['USDC'];
                    if (!usdc) {
                        console.log("\n\u26A0\uFE0F  WARNING: API connected successfully, but no USDC object was returned.");
                        console.log("   This usually means the account has literally 0 volume history or the Agent isn't authorized.");
                        console.log("\n   Raw Balance Object Dump:");
                        console.log(balances.info);
                        return [2 /*return*/];
                    }
                    console.log("\n\u2705 CONNECTION SUCCESSFUL!");
                    console.log("\n\uD83D\uDCB0 YOUR USDC WALLET STATS:");
                    console.log("   Total USDC: $".concat(usdc.total));
                    console.log("   Free USDC:  $".concat(usdc.free));
                    console.log("   Used Margin:$".concat(usdc.used));
                    console.log("\n".concat('═'.repeat(50)));
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    console.error("\n\u274C CRITICAL API ERROR:");
                    console.error(error_1.message || error_1);
                    console.log("\nTroubleshooting:");
                    console.log("1. Double check your Agent Secret is correct.");
                    console.log("2. Ensure your Agent was authorized by your Main Wallet.");
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
testHyperliquidConnection();
