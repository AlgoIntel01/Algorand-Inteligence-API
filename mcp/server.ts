#!/usr/bin/env node
/**
 * Algo Verdict API MCP server — cross-chain wallet and token intelligence for AI agents,
 * paid per call in USDC on Algorand via the x402 protocol.
 *
 * Configure in any MCP client (Claude Desktop, Claude Code, …):
 *
 *   {
 *     "mcpServers": {
 *       "verdict": {
 *         "command": "npx",
 *         "args": ["-y", "verdict-mcp"],
 *         "env": { "ALGORAND_PRIVATE_KEY": "<25-word mnemonic>" }
 *       }
 *     }
 *   }
 *
 * Without a key the server still runs: the free tools work and the paid tools
 * explain exactly how to get a funded wallet instead of failing cryptically.
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  API_BASE,
  PaymentUnavailableError,
  freeGet,
  paidPost,
  walletBalances,
  walletState,
} from "./payment.js";

const WALLET_CHAINS = ["algorand", "ethereum", "base"] as const;
const TOKEN_CHAINS = ["algorand", "ethereum", "base", "bsc", "solana"] as const;

const FUNDING_HELP =
  "To pay for Algo Verdict API calls you need an Algorand wallet holding USDC.\n\n" +
  "Fastest path — the free funding rail:\n" +
  "  git clone https://github.com/AlgoIntel01/Algo-Verdict\n" +
  "  cd Algo-Verdict && npm install && npm run fund-agent\n\n" +
  "It generates a wallet locally, waits for you to send native ALGO from any exchange, " +
  "opts into USDC, and swaps into USDC — keys never leave your machine. " +
  "Then set ALGORAND_PRIVATE_KEY to the printed mnemonic in this server's env config.\n\n" +
  `Full recipe as JSON: ${API_BASE}/fund`;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Runs a paid call, turning payment problems into actionable guidance. */
async function paid(path: string, body: unknown): Promise<ToolResult> {
  try {
    return ok(await paidPost(path, body));
  } catch (err) {
    if (err instanceof PaymentUnavailableError) {
      return fail(`Cannot pay for this call.\n\n${err.message}\n\n${FUNDING_HELP}`);
    }
    return fail(`Algo Verdict API request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reported to every client in the initialize handshake, so it has to be the
 * version that actually shipped — a literal here silently drifted a release
 * behind package.json once already. Resolved from disk rather than restated:
 * one path from source (./package.json), one from the compiled dist/server.js
 * (../package.json), and the name check makes sure a miss cannot pick up the
 * repo root's package.json instead.
 */
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  for (const path of ["../package.json", "./package.json"]) {
    try {
      const pkg = require(path) as { name?: string; version?: string };
      if (pkg.name === "verdict-mcp" && pkg.version) return pkg.version;
    } catch {
      // Try the next location.
    }
  }
  return "0.0.0-unknown";
}

const server = new McpServer({ name: "verdict", version: packageVersion() });

server.registerTool(
  "analyze_token",
  {
    title: "Analyze token risk",
    description:
      "Pre-trade risk check on a token: liquidity depth and lock status, holder concentration, " +
      "deployer history, a rug_probability score with the specific signals behind it, and a " +
      "plain-English verdict. Call this before trading any token you have not vetted. " +
      "Costs $0.05 in USDC, charged automatically.",
    inputSchema: {
      asset: z
        .string()
        .describe("Token contract address (EVM/Solana) or ASA id (Algorand), e.g. '31566704'"),
      chain: z.enum(TOKEN_CHAINS).describe("Chain the token lives on"),
    },
  },
  async ({ asset, chain }) => paid("/token/analyze", { asset, chain }),
);

server.registerTool(
  "analyze_wallet",
  {
    title: "Analyze wallet behavior",
    description:
      "Intelligence on a wallet: who funded it (walking the funding chain back toward exchanges " +
      "or mixers), co-funded sibling wallets, behavioral labels (fresh_funded, mixer_adjacent, " +
      "layered_funding, bot_like, accumulator…), a risk score with confidence, and a verdict. " +
      "Call this to vet a counterparty, a token deployer, or a wallet you are considering " +
      "following. Costs $0.08, or $0.50 with depth='deep' which adds multi-hop funding ancestry " +
      "and cluster expansion.",
    inputSchema: {
      address: z.string().describe("Wallet address to analyze"),
      chain: z.enum(WALLET_CHAINS).describe("Chain the wallet lives on"),
      depth: z
        .enum(["standard", "deep"])
        .optional()
        .describe("'deep' ($0.50) adds multi-hop ancestry and co-funding clusters"),
    },
  },
  async ({ address, chain, depth }) =>
    paid(
      `/wallet/analyze${depth === "deep" ? "?depth=deep" : ""}`,
      { address, chain },
    ),
);

server.registerTool(
  "watch_poll",
  {
    title: "Poll watched wallets and tokens for changes",
    description:
      "Returns everything that changed across a set of watched wallets and tokens since your " +
      "last poll: wallet activity (transaction counts, largest transfers), token risk changes, " +
      "liquidity shifts and holder-concentration shifts. Pass the cursor from the previous " +
      "response to get only new changes; omit it on the first call to establish baselines. " +
      "Costs $0.01 per poll, including polls that return no changes — you paid for the query.",
    inputSchema: {
      watch: z
        .array(
          z.object({
            type: z.enum(["wallet", "token"]),
            address: z.string().optional().describe("Required when type is 'wallet'"),
            asset: z.string().optional().describe("Required when type is 'token'"),
            chain: z.enum(TOKEN_CHAINS),
          }),
        )
        .min(1)
        .max(100)
        .describe("Targets to watch (max 100)"),
      cursor: z
        .string()
        .optional()
        .describe("Cursor from your previous poll; omit on the first call"),
    },
  },
  async ({ watch, cursor }) =>
    paid("/watch/poll", cursor ? { watch, cursor } : { watch }),
);

server.registerTool(
  "explain_transaction",
  {
    title: "Explain an Algorand transaction",
    description:
      "Plain-language explanation of what one committed Algorand transaction did: net asset " +
      "movement for the sender across the entire atomic group and every inner transaction, the " +
      "protocol where attributable, fees, the realised rate against the pre-trade market rate, " +
      "and named safety checks. Costs $0.02. Note: a transaction that FAILED was never written " +
      "to the ledger and cannot be explained afterwards — use simulate_transaction beforehand " +
      "instead.",
    inputSchema: {
      txid: z.string().describe("52-character Algorand transaction id"),
    },
  },
  async ({ txid }) => paid("/tx/explain", { txid }),
);

server.registerTool(
  "simulate_transaction",
  {
    title: "Check whether a transaction would fail, before signing",
    description:
      "Runs an unsigned Algorand transaction group against current chain state without " +
      "submitting it, and reports whether it would succeed plus the exact evaluation error and " +
      "which transaction failed. This is the only way to find out why a transaction fails: " +
      "failed transactions never reach the ledger, so they cannot be diagnosed after the fact. " +
      "Costs $0.02.",
    inputSchema: {
      txns: z
        .array(z.string())
        .min(1)
        .max(16)
        .describe("Atomic group in order, each a base64-encoded transaction; unsigned is normal"),
    },
  },
  async ({ txns }) => paid("/tx/simulate", { txns }),
);

server.registerTool(
  "discover",
  {
    title: "Discover what is moving on Algorand",
    description:
      "The discovery feed: new_launches (newest assets that actually hold liquidity), trending " +
      "(most swapped in 24h), volume_growth (24h volume against the asset's own 7-day average), " +
      "liquidity_moves (TVL change against an hourly baseline), fresh_lps (pools created " +
      "recently) and trending_protocols. Omit signals to get all of them. Costs $0.03.",
    inputSchema: {
      signals: z
        .array(
          z.enum([
            "new_launches",
            "trending",
            "volume_growth",
            "liquidity_moves",
            "fresh_lps",
            "trending_protocols",
          ]),
        )
        .optional()
        .describe("Omit for every signal"),
      limit: z.number().int().min(1).max(50).optional().describe("Results per signal (default 10)"),
    },
  },
  async ({ signals, limit }) => paid("/discover", { signals, limit }),
);

server.registerTool(
  "get_portfolio",
  {
    title: "Value an Algorand address",
    description:
      "What an address holds and what it is worth: balances straight from the chain, USD " +
      "valuation and allocation per position, LP positions, and 30-day buy/sell flows on the " +
      "largest holdings. Assets that cannot be priced keep their balance and report a null " +
      "value rather than being dropped. Costs $0.04.",
    inputSchema: {
      address: z.string().describe("Algorand address"),
    },
  },
  async ({ address }) => paid("/portfolio", { address }),
);

server.registerTool(
  "smart_money",
  {
    title: "See who is trading an Algorand asset",
    description:
      "The wallets behind the largest swaps of an asset in a window, with buy and sell volume, " +
      "average buy against average sell price, holding period and current position. Ranks by " +
      "size, not by proven skill. Read the methodology field in the response before quoting any " +
      "number from it. Costs $0.10.",
    inputSchema: {
      asset: z.string().describe("Algorand ASA id; 0 for native ALGO"),
      window_days: z.number().int().min(1).max(90).optional().describe("Lookback (default 7)"),
      limit: z.number().int().min(1).max(25).optional().describe("Traders returned (default 10)"),
    },
  },
  async ({ asset, window_days, limit }) => paid("/smart-money", { asset, window_days, limit }),
);

server.registerTool(
  "analyze_contract",
  {
    title: "Analyze an Algorand application",
    description:
      "Application intelligence: creator, privileged addresses decoded out of global state, " +
      "state schemas, TEAL version, which OnCompletion types the approval program explicitly " +
      "tests for, and the TVL held in the application account. audit_status and methods are " +
      "always null — Algorand has no audit registry and applications carry no on-chain ABI. " +
      "Costs $0.05.",
    inputSchema: {
      app_id: z.string().describe("Algorand application id"),
    },
  },
  async ({ app_id }) => paid("/contract/analyze", { app_id }),
);

server.registerTool(
  "get_reputation",
  {
    title: "Standing score for an Algorand address",
    description:
      "A cheap, cacheable trust score with every weighted component published alongside it " +
      "(age, activity, counterparty spread, NFDomains identity, holdings, recency), a penalty " +
      "when the account is rekeyed to another key, and known burn or mixer addresses flagged " +
      "outright. Lighter and cheaper than analyze_wallet: no funding ancestry or clustering. " +
      "Costs $0.02.",
    inputSchema: {
      address: z.string().describe("Algorand address"),
    },
  },
  async ({ address }) => paid("/reputation", { address }),
);

server.registerTool(
  "ask",
  {
    title: "Ask anything about on-chain activity",
    description:
      "A question in plain language, routed across token, wallet, transaction, discovery, " +
      "portfolio, smart-money, contract and reputation intelligence, and answered only from what " +
      "those capabilities returned. The structured results come back attached to the prose so " +
      "every figure can be checked against its source. Use this when you do not know which " +
      "specific tool you need. Costs $0.12.",
    inputSchema: {
      question: z.string().max(500).describe("Plain-language question, 500 characters max"),
    },
  },
  async ({ question }) => paid("/ask", { question }),
);

server.registerTool(
  "check_payment_wallet",
  {
    title: "Check the payment wallet",
    description:
      "Free. Reports whether a payment wallet is configured, its address, on-chain ALGO and " +
      "USDC balances, and whether it is opted in to USDC. Use this to diagnose payment problems " +
      "or to check remaining balance before a run of paid calls.",
    inputSchema: {},
  },
  async () => {
    const state = walletState();
    if (!state.configured) {
      return ok({
        configured: false,
        reason: state.reason,
        how_to_fix: FUNDING_HELP,
      });
    }
    const balances = await walletBalances();
    const usdc = balances?.usdc ?? null;
    return ok({
      configured: true,
      address: state.address,
      algo_balance: balances?.algo ?? null,
      usdc_balance: usdc,
      opted_in_to_usdc: balances?.optedIn ?? null,
      can_pay: balances ? balances.optedIn && balances.usdc > 0 : null,
      approximate_calls_remaining:
        usdc === null ? null : { watch_poll: Math.floor(usdc / 0.01), token_analyze: Math.floor(usdc / 0.05), wallet_analyze: Math.floor(usdc / 0.08) },
      ...(balances && !balances.optedIn
        ? { warning: "Wallet is not opted in to USDC and cannot receive or spend it.", how_to_fix: FUNDING_HELP }
        : {}),
    });
  },
);

server.registerTool(
  "get_funding_instructions",
  {
    title: "How to fund an agent wallet",
    description:
      "Free. Returns step-by-step instructions for getting an Algorand wallet that can pay for " +
      "x402 services, including the one-command funding rail. Use when payment is unavailable " +
      "or when setting up for the first time.",
    inputSchema: {},
  },
  async () => {
    try {
      const recipe = await freeGet("/fund");
      return ok({ instructions: FUNDING_HELP, recipe });
    } catch {
      return ok({ instructions: FUNDING_HELP });
    }
  },
);

server.registerTool(
  "get_service_info",
  {
    title: "Algo Verdict API service info and pricing",
    description:
      "Free. Returns the endpoints Algo Verdict API offers, their prices, supported chains and payment " +
      "details. Use to see what is available and what each call costs before spending.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await freeGet("/"));
    } catch (err) {
      return fail(`Could not reach Algo Verdict API at ${API_BASE}: ${String(err)}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel and must stay clean.
  const state = walletState();
  console.error(
    `verdict-mcp ready (api: ${API_BASE}, wallet: ${state.configured ? state.address : "not configured — paid tools will explain how to fund one"})`,
  );
}

main().catch((err) => {
  console.error(`verdict-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
