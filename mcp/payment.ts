/**
 * x402 payment client for the Verdict MCP server.
 *
 * The agent's Algorand key stays in this process; it signs payment transactions
 * locally and never transmits the key. Payments themselves are gasless — the
 * GoPlausible facilitator covers transaction fees — but the wallet needs a
 * one-time USDC opt-in and a small ALGO reserve (see the funding rail).
 */
import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402-avm/fetch";
import {
  ExactAvmScheme,
  toClientAvmSigner,
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
} from "@x402-avm/avm";

const NETWORK = process.env.VERDICT_NETWORK === "testnet" ? "testnet" : "mainnet";
const CAIP2 = NETWORK === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;
/**
 * The client scheme silently defaults to a TESTNET algod when no algodUrl is
 * given, which stamps the wrong genesis hash on the payment transaction and the
 * facilitator rejects it. Always pin this to the active network.
 */
const ALGOD_URL =
  NETWORK === "mainnet"
    ? "https://mainnet-api.algonode.cloud"
    : "https://testnet-api.algonode.cloud";
const USDC_ASA = NETWORK === "mainnet" ? 31566704 : 10458941;

export const API_BASE =
  process.env.VERDICT_API_URL ?? "https://algorand-inteligence-api-production.up.railway.app";

export interface WalletState {
  configured: boolean;
  address: string | null;
  /** Why payment is unavailable, when configured is false. */
  reason?: string;
}

interface Wallet {
  address: string;
  privateKeyB64: string;
}

/** Accepts a 25-word mnemonic or a base64-encoded 64-byte secret key. */
function loadWallet(): Wallet | { error: string } {
  const raw = process.env.ALGORAND_PRIVATE_KEY ?? process.env.VERDICT_PRIVATE_KEY;
  if (!raw || raw.trim() === "") {
    return { error: "no_key" };
  }
  const trimmed = raw.trim();
  try {
    if (trimmed.includes(" ")) {
      const { addr, sk } = algosdk.mnemonicToSecretKey(trimmed);
      return { address: addr.toString(), privateKeyB64: Buffer.from(sk).toString("base64") };
    }
    const sk = new Uint8Array(Buffer.from(trimmed, "base64"));
    if (sk.length !== 64) return { error: "bad_key_length" };
    return {
      address: algosdk.encodeAddress(sk.subarray(32)),
      privateKeyB64: trimmed,
    };
  } catch {
    return { error: "unparseable" };
  }
}

const loaded = loadWallet();
const wallet: Wallet | null = "address" in loaded ? loaded : null;

export function walletState(): WalletState {
  if (wallet) return { configured: true, address: wallet.address };
  const reason =
    "error" in loaded && loaded.error === "no_key"
      ? "ALGORAND_PRIVATE_KEY is not set."
      : "ALGORAND_PRIVATE_KEY could not be parsed (expected a 25-word mnemonic or base64 secret key).";
  return { configured: false, address: null, reason };
}

let payFetch: ReturnType<typeof wrapFetchWithPayment> | null = null;
function getPayFetch(): ReturnType<typeof wrapFetchWithPayment> {
  if (!wallet) throw new Error("no payment wallet configured");
  if (!payFetch) {
    const signer = toClientAvmSigner(wallet.privateKeyB64);
    const client = new x402Client().register(
      CAIP2,
      new ExactAvmScheme(signer, { algodUrl: ALGOD_URL }),
    );
    payFetch = wrapFetchWithPayment(fetch, client);
  }
  return payFetch;
}

/** On-chain balances, so agents can check they can actually pay before trying. */
export async function walletBalances(): Promise<{
  algo: number;
  usdc: number;
  optedIn: boolean;
} | null> {
  if (!wallet) return null;
  try {
    const res = await fetch(`${ALGOD_URL}/v2/accounts/${wallet.address}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const info = (await res.json()) as {
      amount: number;
      assets?: Array<{ "asset-id": number; amount: number }>;
    };
    const usdcHolding = (info.assets ?? []).find((a) => a["asset-id"] === USDC_ASA);
    return {
      algo: info.amount / 1e6,
      usdc: (usdcHolding?.amount ?? 0) / 1e6,
      optedIn: usdcHolding !== undefined,
    };
  } catch {
    return null;
  }
}

export class PaymentUnavailableError extends Error {}

/**
 * POST to a paid Verdict endpoint, settling the x402 challenge automatically.
 * Throws PaymentUnavailableError with actionable guidance when the wallet
 * isn't usable, so the agent learns how to fix it rather than seeing a 402.
 */
export async function paidPost(path: string, body: unknown): Promise<unknown> {
  const state = walletState();
  if (!state.configured) {
    throw new PaymentUnavailableError(state.reason ?? "No payment wallet configured.");
  }
  const res = await getPayFetch()(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 402) {
    const balances = await walletBalances();
    const detail = balances
      ? `Wallet ${state.address} holds ${balances.usdc} USDC and ${balances.algo} ALGO` +
        (balances.optedIn ? "." : "; it is NOT opted in to USDC.")
      : `Wallet ${state.address} balances could not be read.`;
    throw new PaymentUnavailableError(`Payment was not accepted. ${detail}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Verdict API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function freeGet(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Verdict API returned HTTP ${res.status}`);
  return res.json();
}
