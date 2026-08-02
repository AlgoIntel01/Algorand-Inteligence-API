import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402-avm/fetch";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  ExactAvmScheme,
  toClientAvmSigner,
} from "@x402-avm/avm";
import type {
  AskResult,
  ContractAnalysis,
  DiscoverResult,
  DiscoverSignal,
  Portfolio,
  Reputation,
  ServiceCard,
  SmartMoney,
  TokenAnalysis,
  TokenChain,
  TxExplanation,
  TxSimulation,
  WalletAnalysis,
  WalletChain,
  WatchPollResult,
  WatchTarget,
} from "./types.js";

export * from "./types.js";

const DEFAULT_BASE_URL = "https://algoverdict.xyz";

const ALGOD_URL = {
  mainnet: "https://mainnet-api.algonode.cloud",
  testnet: "https://testnet-api.algonode.cloud",
} as const;

export interface VerdictOptions {
  /**
   * 25-word mnemonic or base64 of the 64-byte secret key. Omit to use only the
   * free endpoints; any paid call will then throw PaymentNotConfiguredError.
   */
  privateKey?: string;
  baseUrl?: string;
  network?: "mainnet" | "testnet";
  /** Overrides the algod node used to build payment transactions. */
  algodUrl?: string;
  fetch?: typeof fetch;
}

export class PaymentNotConfiguredError extends Error {}

export class VerdictError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/**
 * Client for the Algo Verdict API intelligence service.
 *
 * Paid calls settle in USDC on Algorand over x402. Payment is gasless — the
 * facilitator covers transaction fees — so the wallet needs USDC but no ALGO
 * beyond the one-time opt-in.
 */
export class VerdictClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly address: string | null;

  constructor(private readonly options: VerdictOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const network = options.network ?? "mainnet";
    const baseFetch = options.fetch ?? fetch;

    if (options.privateKey === undefined || options.privateKey.trim().length === 0) {
      this.doFetch = baseFetch;
      this.address = null;
      return;
    }

    const raw = options.privateKey.trim();
    const secretKeyB64 = raw.includes(" ")
      ? Buffer.from(algosdk.mnemonicToSecretKey(raw).sk).toString("base64")
      : raw;
    const signer = toClientAvmSigner(secretKeyB64);
    this.address = signer.address;

    const caip2 = network === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;
    // Without an explicit algodUrl the scheme quietly defaults to a testnet node
    // and stamps the wrong genesis hash on the payment, which the facilitator
    // then rejects. Pinning it to the active network is not optional.
    const algodUrl = options.algodUrl ?? ALGOD_URL[network];
    const client = new x402Client().register(caip2, new ExactAvmScheme(signer, { algodUrl }));
    this.doFetch = wrapFetchWithPayment(baseFetch, client);
  }

  /** The paying address, or null when the client was built without a key. */
  get payerAddress(): string | null {
    return this.address;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (this.address === null) {
      throw new PaymentNotConfiguredError(
        `${path} is a paid endpoint and this client has no key. Pass privateKey to VerdictClient, ` +
          `or see ${this.baseUrl}/fund for how to get a wallet that can pay.`,
      );
    }
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return this.unwrap<T>(res, path);
  }

  private async get<T>(path: string): Promise<T> {
    const baseFetch = this.options.fetch ?? fetch;
    return this.unwrap<T>(await baseFetch(`${this.baseUrl}${path}`), path);
  }

  private async unwrap<T>(res: Response, path: string): Promise<T> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail =
        body && typeof body === "object" && "message" in body
          ? String((body as Record<string, unknown>).message)
          : res.statusText;
      throw new VerdictError(`${path} failed (HTTP ${res.status}): ${detail}`, res.status, body);
    }
    return body as T;
  }

  // --- Paid ---------------------------------------------------------------

  /** $0.05 — rug risk and structure for a token. */
  analyzeToken(input: { asset: string; chain: TokenChain }): Promise<TokenAnalysis> {
    return this.post("/token/analyze", input);
  }

  /** $0.08, or $0.50 with depth 'deep' for multi-hop ancestry and clusters. */
  analyzeWallet(input: {
    address: string;
    chain: WalletChain;
    depth?: "standard" | "deep";
  }): Promise<WalletAnalysis> {
    const query = input.depth === "deep" ? "?depth=deep" : "";
    return this.post(`/wallet/analyze${query}`, {
      address: input.address,
      chain: input.chain,
    });
  }

  /** $0.02 — what a committed Algorand transaction actually did. */
  explainTransaction(input: { txid: string }): Promise<TxExplanation> {
    return this.post("/tx/explain", input);
  }

  /**
   * $0.02 — whether a transaction group would succeed, before you sign it.
   * Pass base64-encoded transactions; unsigned is the normal case.
   */
  simulateTransaction(input: { txns: string[] }): Promise<TxSimulation> {
    return this.post("/tx/simulate", input);
  }

  /** $0.03 — what is launching, trending and moving. Omit signals for all. */
  discover(
    input: { signals?: DiscoverSignal[]; limit?: number; created_after?: number } = {},
  ): Promise<DiscoverResult> {
    return this.post("/discover", input);
  }

  /** $0.04 — holdings, valuation, allocation, LP positions, 30-day flows. */
  portfolio(input: { address: string }): Promise<Portfolio> {
    return this.post("/portfolio", input);
  }

  /** $0.10 — the wallets moving an asset. Read `methodology` before quoting it. */
  smartMoney(input: {
    asset: string;
    window_days?: number;
    limit?: number;
  }): Promise<SmartMoney> {
    return this.post("/smart-money", input);
  }

  /** $0.05 — application creator, privileged addresses, TEAL analysis, TVL. */
  analyzeContract(input: { app_id: string }): Promise<ContractAnalysis> {
    return this.post("/contract/analyze", input);
  }

  /** $0.02 — standing score with every component named. */
  reputation(input: { address: string }): Promise<Reputation> {
    return this.post("/reputation", input);
  }

  /** $0.12 — a plain-language question, answered only from live capability output. */
  ask(input: { question: string }): Promise<AskResult> {
    return this.post("/ask", input);
  }

  /** $0.01 — everything that changed since your cursor. Omit it on the first call. */
  watchPoll(input: { watch: WatchTarget[]; cursor?: string }): Promise<WatchPollResult> {
    return this.post("/watch/poll", input);
  }

  // --- Free ---------------------------------------------------------------

  /** Endpoints, prices and payment terms. No payment required. */
  serviceCard(): Promise<ServiceCard> {
    return this.get("/");
  }

  /** How to get a wallet that can pay, as JSON. No payment required. */
  fundingGuide(): Promise<Record<string, unknown>> {
    return this.get("/fund");
  }

  /** Liveness. No payment required. */
  health(): Promise<{ ok: boolean; network: string }> {
    return this.get("/health");
  }
}
