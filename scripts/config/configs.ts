import { createPublicClient, createWalletClient, http, Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as dotenv from "dotenv";
dotenv.config();

export const target_Network = {
  id: 84532, 
  name: "BASE Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "WETH",
    symbol: "WETH",
  },
  rpcUrls: {
    default: {
      http: [process.env.TARGET_NETWORK_RPC_URL || ""],
    },
    public: {
      http: [process.env.TARGET_NETWORK_RPC_URL || ""],
    },
  },
} as const satisfies Chain;

export const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}`);

export const publicClient = createPublicClient({
  chain: target_Network,
  transport: http(process.env.TARGET_NETWORK_RPC_URL),
});

export const walletClient = createWalletClient({
  account,
  chain: target_Network,
  transport: http(process.env.TARGET_NETWORK_RPC_URL),
});