import { existsSync } from "node:fs";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  ALGORAND_ADDRESS_REGEX,
} from "@x402-avm/avm";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const port = Number(process.env.PORT ?? 3402);

export const config = {
  network,
  caip2: network === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2,
  usdcAsaId: network === "mainnet" ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID,
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz",
  sellerAddress: process.env.SELLER_ADDRESS ?? "",
  port,
  baseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
} as const;

export const PRICES = {
  watchPoll: "$0.01",
  tokenAnalyze: "$0.05",
  walletAnalyze: "$0.08",
  walletAnalyzeDeep: "$0.50",
} as const;

export const SUPPORTED_CHAINS = ["ethereum", "base", "bsc", "solana", "algorand"] as const;
export type Chain = (typeof SUPPORTED_CHAINS)[number];

export function assertConfig(): void {
  if (!ALGORAND_ADDRESS_REGEX.test(config.sellerAddress)) {
    throw new Error(
      "SELLER_ADDRESS is missing or not a valid Algorand address. " +
        "Run `npm run create-wallet` to generate one, or set it in .env.",
    );
  }
}
