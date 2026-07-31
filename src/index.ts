import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402-avm/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402-avm/core/server";
import type { RoutesConfig, HTTPRequestContext } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402-avm/extensions/bazaar";
import { checkFacilitator, loggingFacilitator } from "./facilitator.js";
import { assertConfig, config, PRICES, SUPPORTED_CHAINS } from "./config.js";
import { wallet } from "./routes/wallet.js";
import { token } from "./routes/token.js";
import { watch } from "./routes/watch.js";
import { tx } from "./routes/tx.js";
import { discovery } from "./routes/discover.js";
import { portfolio } from "./routes/portfolio.js";
import { smartMoney } from "./routes/smart-money.js";
import { contract } from "./routes/contract.js";
import { reputation } from "./routes/reputation.js";
import { askRoute } from "./routes/ask.js";
import { hasLlm } from "./llm.js";

assertConfig();

const facilitator = loggingFacilitator(new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
const resourceServer = registerExactAvmScheme(new x402ResourceServer(facilitator));
// Bazaar: enriches 402 PaymentRequired responses with discovery metadata the
// facilitator extracts and catalogs, so agents can find these endpoints.
resourceServer.registerExtension(bazaarResourceServerExtension);

/**
 * The Global x402 Challenge requires a `tag` field inside `extra` on every paid
 * route so entries can be identified. The AVM scheme also writes `extra` (asset
 * name, decimals, and the facilitator's feePayer, which is what makes payments
 * gasless), so this must merge with those rather than replace them — verify the
 * decoded payment-required header still carries feePayer after any change here.
 */
const CHALLENGE_TAG = "x402-global-challenge";

function accepts(price: string | ((ctx: HTTPRequestContext) => string)) {
  return {
    scheme: "exact",
    network: config.caip2,
    payTo: config.sellerAddress,
    price,
    maxTimeoutSeconds: 120,
    extra: { tag: CHALLENGE_TAG },
  };
}

function unpaidBody(endpoint: string, price: string, summary: string) {
  return () => ({
    contentType: "application/json",
    body: {
      error: "payment_required",
      endpoint,
      price,
      summary,
      payment: `x402 exact scheme, USDCa (ASA ${config.usdcAsaId}) on Algorand ${config.network}`,
      docs: `${config.baseUrl}/`,
    },
  });
}

const routes: RoutesConfig = {
  "POST /wallet/analyze": {
    accepts: accepts((ctx) =>
      ctx.adapter.getQueryParam?.("depth") === "deep" ? PRICES.walletAnalyzeDeep : PRICES.walletAnalyze,
    ),
    resource: `${config.baseUrl}/wallet/analyze`,
    description:
      "Wallet intelligence: risk score, behavioral labels, funding ancestry, co-funding " +
      "clusters and a verdict. Wallet chains: algorand, ethereum, base (token analysis " +
      `covers all of ${SUPPORTED_CHAINS.join(", ")}). ` +
      `Append ?depth=deep (${PRICES.walletAnalyzeDeep}) for multi-hop ancestry + cluster expansion.`,
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /wallet/analyze",
      `${PRICES.walletAnalyze} (deep: ${PRICES.walletAnalyzeDeep})`,
      "Judgment call on a wallet: funding origin, behavior, cluster membership. " +
        "Wallet chains: algorand, ethereum, base.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { address: "0x1234abcd...", chain: "base" },
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Wallet address to analyze" },
          chain: {
            type: "string",
            enum: ["algorand", "ethereum", "base", "bsc"],
            description: "Chains with wallet analysis support",
          },
        },
        required: ["address", "chain"],
      },
      output: {
        example: {
          status: "ok",
          risk_score: 0.35,
          confidence: 0.8,
          labels: ["fresh_funded", "cluster_member"],
          cluster: {
            members: ["0xabc...", "0xdef..."],
            funding_ancestry: [
              { address: "0x123...", kind: "fresh_eoa", name: null, funded_at: "2026-07-01T00:00:00Z" },
            ],
            timing_correlation: {},
          },
          verdict: "One-paragraph judgment call on the wallet.",
        },
      },
    }),
  },
  "POST /token/analyze": {
    accepts: accepts(PRICES.tokenAnalyze),
    resource: `${config.baseUrl}/token/analyze`,
    description:
      "Pre-trade token check: liquidity depth and locks, holder concentration, deployer history, " +
      `rug probability with driving signals. Chains: ${SUPPORTED_CHAINS.join(", ")}.`,
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /token/analyze",
      PRICES.tokenAnalyze,
      "Rug check on any token before an agent trades it.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { asset: "31566704", chain: "algorand" },
      inputSchema: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "Token contract address (EVM/Solana) or ASA id (Algorand)",
          },
          chain: { type: "string", enum: [...SUPPORTED_CHAINS] },
        },
        required: ["asset", "chain"],
      },
      output: {
        example: {
          status: "ok",
          rug_probability: 0.12,
          rug_signals: ["freeze_key_set"],
          liquidity: { depth_usd: 1779250, lock_status: "unknown", lock_expiry: null },
          holders: { count: 3421, top_10_concentration: 0.34, insider_overlap: null },
          verdict: "One-paragraph pre-trade risk verdict.",
        },
      },
    }),
  },
  "POST /tx/explain": {
    accepts: accepts(PRICES.txExplain),
    resource: `${config.baseUrl}/tx/explain`,
    description:
      "Plain-language explanation of one Algorand transaction: net asset movement for the " +
      "sender across the whole atomic group and its inner transactions, the protocol it went " +
      "through where attributable, fees, realised rate versus the pre-trade market rate, " +
      "and named safety checks. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /tx/explain",
      PRICES.txExplain,
      "What actually happened in a transaction, in one sentence plus the numbers behind it.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { txid: "FPGSILQHO2KB5VLPV7YF73ZXL4PSCAZFYSSIET7H5LUVOSG2DTTQ" },
      inputSchema: {
        type: "object",
        properties: {
          txid: { type: "string", description: "Algorand transaction id (52-character base32)" },
          chain: { type: "string", enum: ["algorand"] },
        },
        required: ["txid"],
      },
      output: {
        example: {
          status: "ok",
          kind: "swap",
          summary:
            "Swapped 20,000 ALGO for 25,233,733,648.0667 SHIP routed across 9 applications. " +
            "Network fee 0.063 ALGO across 14 transactions. Realised rate sat 17.97% below the " +
            "pre-trade market rate, fees and price impact included. Flagged: unattributed_application.",
          net_flows: [
            { asset_id: 0, unit: "ALGO", amount: "-20000", usd_value: -1690.47 },
            { asset_id: 3109829078, unit: "SHIP", amount: "25233733648.066692", usd_value: 1991.61 },
          ],
          fees: { total_algo: 0.063, transactions: 14 },
          safety_flags: ["unattributed_application"],
        },
      },
    }),
  },
  "POST /tx/simulate": {
    accepts: accepts(PRICES.txSimulate),
    resource: `${config.baseUrl}/tx/simulate`,
    description:
      "Pre-flight check: run an unsigned Algorand transaction group against current chain state " +
      "without submitting it, and get back whether it would succeed plus the exact evaluation " +
      "error and the index that failed. This is the only way to answer 'why does my transaction " +
      "fail' — failed transactions are never written to the ledger, so they cannot be inspected " +
      "afterwards. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /tx/simulate",
      PRICES.txSimulate,
      "Would this transaction fail, and why — before you sign it.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { txns: ["base64-encoded unsigned transaction"] },
      inputSchema: {
        type: "object",
        properties: {
          txns: {
            type: "array",
            maxItems: 16,
            items: { type: "string" },
            description:
              "Atomic group in order, each a base64-encoded Algorand transaction. Unsigned is " +
              "the normal case (algosdk encodeUnsignedTransaction); signed blobs are accepted too.",
          },
        },
        required: ["txns"],
      },
      output: {
        example: {
          status: "ok",
          would_succeed: false,
          failure_summary: "overspend",
          failure_reason:
            "transaction QRLROOJM…: overspend (account MGVUZWD2…, tried to spend 1000000A)",
          failed_at: 0,
          group_size: 1,
          fees: { total_algo: 0.001 },
        },
      },
    }),
  },
  "POST /discover": {
    accepts: accepts(PRICES.discover),
    resource: `${config.baseUrl}/discover`,
    description:
      "Discovery feed for Algorand DeFi. Signals: new_launches (newest assets above a liquidity " +
      "floor), trending (most swapped in 24h), volume_growth (24h volume against the asset's own " +
      "7-day average), liquidity_moves (TVL change against our hourly snapshot), fresh_lps " +
      "(newest pools with protocol and pair), trending_protocols (24h volume by protocol). " +
      "Post an empty body for all of them. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /discover",
      PRICES.discover,
      "What is launching, trending, and moving on Algorand right now.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { signals: ["trending", "new_launches"], limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          signals: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "new_launches",
                "trending",
                "volume_growth",
                "liquidity_moves",
                "fresh_lps",
                "trending_protocols",
              ],
            },
            description: "Omit for every signal",
          },
          limit: { type: "integer", description: "Results per signal, 1-50 (default 10)" },
          created_after: {
            type: "integer",
            description: "Unix seconds; restricts new_launches to assets created after this",
          },
          chain: { type: "string", enum: ["algorand"] },
        },
      },
      output: {
        example: {
          status: "ok",
          chain: "algorand",
          signals: {
            trending: [
              {
                asset_id: 0,
                ticker: "ALGO",
                tvl_usd: 59191833,
                volume_1d_usd: 173083.7,
                measure: { label: "swaps_1d", value: 16323 },
              },
            ],
          },
        },
      },
    }),
  },
  "POST /portfolio": {
    accepts: accepts(PRICES.portfolio),
    resource: `${config.baseUrl}/portfolio`,
    description:
      "What an Algorand address holds and what it is worth: balances from the chain, USD " +
      "valuation and allocation per position, LP positions, and 30-day buy/sell flows for the " +
      "largest holdings. Assets that cannot be priced keep their balance and report a null " +
      "value rather than being dropped. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /portfolio",
      PRICES.portfolio,
      "Holdings, valuation, allocation, LP positions and recent trade flows for one address.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { address: "PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM" },
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Algorand address" },
          chain: { type: "string", enum: ["algorand"] },
        },
        required: ["address"],
      },
      output: {
        example: {
          status: "ok",
          total_value_usd: 5301.74,
          priced_holdings: 4,
          unpriced_holdings: 1,
          holdings: [
            {
              asset_id: 0,
              ticker: "ALGO",
              amount: 3570.3,
              price_usd: 0.0845,
              value_usd: 301.69,
              allocation: 0.0569,
              flows_30d: { bought_usd: 0, sold_usd: 1992.76, net_usd: 1992.76 },
            },
          ],
          lp_positions: [],
        },
      },
    }),
  },
  "POST /smart-money": {
    accepts: accepts(PRICES.smartMoney),
    resource: `${config.baseUrl}/smart-money`,
    description:
      "Who is moving an asset: the wallets behind the largest swaps in a window, each with buy " +
      "and sell volume, average buy against average sell price, holding period and current " +
      "position. Every sampled trade is resolved back to the wallet that initiated it, because " +
      "an aggregator-routed swap reports the router as its executor. Ranks by size, not by " +
      "proven skill, and says so. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /smart-money",
      PRICES.smartMoney,
      "The wallets actually moving an asset, with the methodology stated alongside the numbers.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { asset: "3109829078", window_days: 7, limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Algorand ASA id; 0 for native ALGO" },
          window_days: { type: "integer", description: "Lookback window, 1-90 (default 7)" },
          limit: { type: "integer", description: "Traders returned, 1-25 (default 10)" },
          chain: { type: "string", enum: ["algorand"] },
        },
        required: ["asset"],
      },
      output: {
        example: {
          status: "ok",
          asset_id: 3109829078,
          asset_ticker: "SHIP",
          window_days: 7,
          traders: [
            {
              address: "PV3QMHIO...",
              routed: true,
              bought_usd: 1992.76,
              sold_usd: 0,
              avg_buy_price_usd: 7.89e-8,
              round_trip_roi: null,
              current_position: 63318279493.47,
            },
          ],
          cohort: { traders_ranked: 10, with_computable_roi: 4, win_rate: 0.5, median_roi: 0.02 },
        },
      },
    }),
  },
  "POST /contract/analyze": {
    accepts: accepts(PRICES.contractAnalyze),
    resource: `${config.baseUrl}/contract/analyze`,
    description:
      "Application intelligence: creator, global state with privileged addresses decoded, state " +
      "schemas, TEAL version, which OnCompletion types the approval program explicitly tests, " +
      "and the TVL sitting in the application account. audit_status and methods are always null " +
      "— Algorand has no audit registry and applications carry no on-chain ABI. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /contract/analyze",
      PRICES.contractAnalyze,
      "What an Algorand application controls, who can change it, and what it holds.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { app_id: "1002541853" },
      inputSchema: {
        type: "object",
        properties: {
          app_id: { type: "string", description: "Algorand application id" },
          chain: { type: "string", enum: ["algorand"] },
        },
        required: ["app_id"],
      },
      output: {
        example: {
          status: "ok",
          app_id: 1002541853,
          app_account: "XSKED5VKZZCSYNDWXZJI65JM2HP7HZFJWCOBIMOONKHTK5UVKENBNVDEYM",
          privileged_addresses: [
            { key: "fee_setter", address: "ZWJVXVXCC7DYAFYCASOEHDLZ..." },
          ],
          program: {
            teal_version: 7,
            on_completion_tested: { update_application: true, delete_application: true },
          },
          audit_status: null,
          methods: null,
          risk_flags: ["privileged_addresses_in_global_state"],
        },
      },
    }),
  },
  "POST /reputation": {
    accepts: accepts(PRICES.reputation),
    resource: `${config.baseUrl}/reputation`,
    description:
      "A cheap, cacheable standing score for an Algorand address, built for wallets and explorers " +
      "to embed next to an address. Weighted components (age, activity, counterparty spread, " +
      "NFDomains identity, holdings, recency) are published with the score, along with a rekey " +
      "penalty when the account is signed for by another key. Lighter than /wallet/analyze: no " +
      "funding ancestry, no cluster expansion. Algorand only.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /reputation",
      PRICES.reputation,
      "Standing score for an address, with every component that produced it named.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { address: "PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM" },
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Algorand address" },
          chain: { type: "string", enum: ["algorand"] },
        },
        required: ["address"],
      },
      output: {
        example: {
          status: "ok",
          trust_score: 0.62,
          tier: "developing",
          confidence: 1,
          components: {
            age: { weight: 0.3, earned: 0.09, basis: "112 days old, full credit at 365" },
          },
          positive_signals: ["has_created_assets"],
          negative_signals: [],
          identity: null,
        },
      },
    }),
  },
  "POST /watch/poll": {
    accepts: accepts(PRICES.watchPoll),
    resource: `${config.baseUrl}/watch/poll`,
    description:
      "Cursor-based delta poll over watched wallets and tokens. Change types: wallet_activity " +
      "(tx count + largest transfer since cursor; algorand/ethereum/base), token_risk_change, " +
      "token_liquidity_shift, token_holder_shift (~10-min granularity; all five chains). " +
      "First poll establishes baselines. Empty deltas still ran the query.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /watch/poll",
      PRICES.watchPoll,
      "Everything that changed since your cursor, priced per poll.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        cursor: null,
        watch: [{ type: "token", asset: "31566704", chain: "algorand" }],
      },
      inputSchema: {
        type: "object",
        properties: {
          cursor: {
            type: ["string", "null"],
            description: "Cursor from your previous poll; omit on the first call",
          },
          watch: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["wallet", "token"] },
                address: { type: "string" },
                asset: { type: "string" },
                chain: { type: "string", enum: [...SUPPORTED_CHAINS] },
              },
              required: ["type", "chain"],
            },
          },
        },
        required: ["watch"],
      },
      output: {
        example: {
          cursor: "eyJ2IjoxLCJ0IjoxNzg0ODg3ODk5NjYyfQ",
          watched: 2,
          changes: [
            {
              type: "wallet_activity",
              target: { type: "wallet", address: "0xabc...", chain: "base" },
              observed_at: "2026-07-24T12:00:00.000Z",
              detail: {
                tx_count_since_cursor: 3,
                largest_native_transfer: { amount_base_units: "5000000000000000000", direction: "in" },
              },
            },
          ],
        },
      },
    }),
  },
};


// /ask is registered as a paid route only when a model is configured. The
// paywall charges before the handler runs, so advertising it without a key
// would take payment for a request that can only fail.
if (hasLlm) {
  routes["POST /ask"] = {
    accepts: accepts(PRICES.ask),
    resource: `${config.baseUrl}/ask`,
    description:
      "Ask a question in plain language. Routes across token, wallet, transaction, discovery, " +
      "portfolio, smart-money, contract and reputation intelligence, then answers only from what " +
      "those capabilities returned. The structured results come back alongside the prose so " +
      "every figure can be checked against its source.",
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /ask",
      PRICES.ask,
      "Natural-language questions answered from live on-chain data, with the data attached.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { question: "Is ASA 31566704 safe to trade, and who has been buying it this week?" },
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "Plain-language question, 500 characters max" },
        },
        required: ["question"],
      },
      output: {
        example: {
          status: "ok",
          answer: "One-paragraph answer grounded in the tool results below.",
          tools_used: [{ tool: "analyze_token", input: { asset: "31566704", chain: "algorand" } }],
          data: {},
          steps: 2,
        },
      },
    }),
  };
}

const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "Algo Verdict API",
    tagline:
      "The blockchain intelligence layer for AI agents, wallets and DeFi — paid per request, " +
      "settled in USDCa on Algorand.",
    status: "beta",
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: config.caip2,
      asset: { id: config.usdcAsaId, symbol: "USDCa", decimals: 6 },
      facilitator: config.facilitatorUrl,
      fee_abstraction: true,
    },
    endpoints: [
      { route: "POST /wallet/analyze", price: PRICES.walletAnalyze },
      { route: "POST /wallet/analyze?depth=deep", price: PRICES.walletAnalyzeDeep },
      { route: "POST /token/analyze", price: PRICES.tokenAnalyze },
      { route: "POST /tx/explain", price: PRICES.txExplain, note: "Algorand only" },
      { route: "POST /tx/simulate", price: PRICES.txSimulate, note: "Algorand only" },
      { route: "POST /discover", price: PRICES.discover, note: "Algorand only" },
      { route: "POST /portfolio", price: PRICES.portfolio, note: "Algorand only" },
      { route: "POST /smart-money", price: PRICES.smartMoney, note: "Algorand only" },
      { route: "POST /contract/analyze", price: PRICES.contractAnalyze, note: "Algorand only" },
      { route: "POST /reputation", price: PRICES.reputation, note: "Algorand only" },
      ...(hasLlm ? [{ route: "POST /ask", price: PRICES.ask, note: "Natural language over every capability" }] : []),
      { route: "POST /watch/poll", price: PRICES.watchPoll },
      { route: "GET /fund", price: "free", note: "How to get an agent wallet that can pay" },
    ],
    chains: SUPPORTED_CHAINS,
  }),
);
/**
 * Liveness. Always 200 while the process is answering, because restarting this
 * container cannot fix an outage in someone else's service — a probe that fails
 * on a facilitator outage would just flap. Degradation is reported in the body,
 * and /ready is the endpoint that fails loudly.
 */
app.get("/health", async (c) => {
  const facilitator = await checkFacilitator();
  return c.json({
    ok: true,
    status: facilitator.reachable ? "ok" : "degraded",
    network: config.network,
    facilitator,
    paid_routes: facilitator.reachable ? "available" : "unavailable",
    ...(facilitator.reachable
      ? {}
      : {
          note:
            "The facilitator is not answering, so payment terms cannot be loaded and every paid " +
            "route will fail until it recovers. Free routes are unaffected.",
        }),
  });
});

/**
 * Readiness: can this service actually sell anything right now? Returns 503 when
 * the facilitator is unreachable. Point uptime monitoring here rather than at
 * /health, which reports only that the process is alive.
 */
app.get("/ready", async (c) => {
  const facilitator = await checkFacilitator();
  return c.json(
    {
      ready: facilitator.reachable,
      network: config.network,
      facilitator,
      ...(facilitator.reachable
        ? {}
        : { reason: "facilitator_unreachable: paid routes cannot serve payment terms" }),
    },
    facilitator.reachable ? 200 : 503,
  );
});

// Free public good: how to get an agent wallet that can pay x402 services on
// Algorand. Most agents live on Base/Solana and cannot pay USDCa without this.
app.get("/fund", (c) =>
  c.json({
    title: "Fund an x402 agent wallet on Algorand",
    why:
      "Paying USDCa requires an Algorand account, an ASA opt-in for USDC, and a minimum " +
      "ALGO balance. This recipe gets an agent from zero to ready-to-pay.",
    cli: {
      repo: "https://github.com/AlgoIntel01/Algo-Verdict",
      command: "npm run fund-agent",
      flags: {
        "--json": "machine-readable output for agents",
        "--dry-run": "quote and verify the swap without submitting",
        "--resume <file>": "continue with an existing mnemonic file",
        "--slippage <n>": "swap slippage tolerance (default 0.01)",
      },
      steps: [
        "Generates a fresh Algorand keypair locally (keys never leave your machine).",
        "You send native ALGO to the printed address from any exchange or wallet.",
        "Opts the account into USDCa (ASA 31566704).",
        "Swaps spare ALGO into USDCa via the Vestige aggregator; every transaction is decoded and safety-checked locally before signing.",
        "Prints a ready-to-pay wallet (address, mnemonic, balances).",
      ],
    },
    manual_alternative:
      "Withdraw USDC directly to an Algorand address from an exchange that supports the " +
      "Algorand network, then opt into ASA 31566704 and keep ~0.3 ALGO for reserves and fees.",
    constants: {
      network: config.caip2,
      usdc_asa_id: config.usdcAsaId,
      recommended_reserve_algo: 0.3,
      facilitator: config.facilitatorUrl,
      fee_abstraction:
        "Payments themselves are gasless — the facilitator covers transaction fees — but the " +
        "one-time USDCa opt-in requires a small ALGO balance.",
    },
    note: "CCTP does not bridge to Algorand, so this rail is ALGO-in plus an on-chain swap.",
  }),
);

/**
 * Machine-readable descriptions of what this service sells, both generated from
 * the same `routes` config the paywall uses — so they cannot drift from what a
 * 402 actually demands.
 *
 * Agents and directory crawlers look for these before deciding whether to call a
 * service, and neither costs a payment to read.
 */
interface ManifestEntry {
  resource: string;
  method: string;
  price: string;
  description: string;
}

function paidRoutes(): ManifestEntry[] {
  return Object.entries(routes).map(([key, cfg]) => {
    const [method, path] = key.split(" ");
    const config = cfg as { accepts: { price: unknown }; resource: string; description: string };
    // /wallet/analyze prices per request via a function (deep costs more), so
    // report the range rather than calling it without a request context.
    const price =
      typeof config.accepts.price === "function"
        ? `${PRICES.walletAnalyze} (${PRICES.walletAnalyzeDeep} with ?depth=deep)`
        : String(config.accepts.price);
    return { resource: config.resource ?? path, method, price, description: config.description };
  });
}

/** https://llmstxt.org — plain text an agent can read before spending anything. */
app.get("/llms.txt", (c) => {
  const paid = paidRoutes()
    .map((r) => `- [${r.method} ${new URL(r.resource).pathname}](${r.resource}) (${r.price}): ${r.description}`)
    .join("\n");

  const body = `# Algo Verdict API

> Explainable blockchain intelligence that AI agents buy per request, settled in USDC on Algorand
> over x402. No API key, no account, no subscription.

Every score names the signals that produced it, and every field a data source cannot provide comes
back \`null\` rather than a guess — so an agent can tell "we looked and it is clean" apart from "we
could not see". Token analysis covers Algorand, Ethereum, Base, BNB Chain and Solana; wallet
analysis covers Algorand, Ethereum and Base; the remaining capabilities are Algorand-native.

Payment is gasless: the facilitator covers transaction fees, so a caller needs USDC and nothing
else. Request without payment and you get HTTP 402 with the terms in the \`payment-required\`
header, including a Bazaar discovery extension describing the input schema.

## Paid endpoints

${paid}

## Free endpoints

- [GET /](${config.baseUrl}/): Service card — endpoints, prices and payment terms.
- [GET /fund](${config.baseUrl}/fund): How to get an Algorand wallet that can pay, as JSON. Circle's CCTP does not bridge to Algorand, so this describes the ALGO-in plus swap route that works for any Algorand x402 service.
- [GET /health](${config.baseUrl}/health): Liveness, plus whether the facilitator is reachable.
- [GET /ready](${config.baseUrl}/ready): Readiness — 503 when paid routes cannot serve.
- [GET /.well-known/x402](${config.baseUrl}/.well-known/x402): This catalogue as JSON.

## Notes

- Settlement: USDC (ASA ${config.usdcAsaId}) on Algorand ${config.network}, via the GoPlausible facilitator.
- A failed Algorand transaction is never written to the ledger and cannot be explained after the fact; POST /tx/simulate answers that question before you sign instead.
- Contract audit status and ABI methods are always null: Algorand has no audit registry, and applications carry no on-chain ABI.
`;
  return c.text(body);
});

/** JSON form of the same catalogue, for crawlers that expect a manifest. */
app.get("/.well-known/x402", (c) =>
  c.json({
    x402Version: 2,
    name: "Algo Verdict API",
    description:
      "Explainable blockchain intelligence for AI agents, wallets and DeFi, paid per request in " +
      "USDC on Algorand via x402.",
    documentation: `${config.baseUrl}/llms.txt`,
    source: "https://github.com/AlgoIntel01/Algo-Verdict",
    payment: {
      scheme: "exact",
      network: config.caip2,
      asset: { id: config.usdcAsaId, symbol: "USDC", decimals: 6 },
      payTo: config.sellerAddress,
      facilitator: config.facilitatorUrl,
      feeAbstraction: true,
    },
    resources: paidRoutes(),
    free: [`${config.baseUrl}/`, `${config.baseUrl}/fund`, `${config.baseUrl}/health`, `${config.baseUrl}/ready`],
  }),
);

app.use(paymentMiddleware(routes, resourceServer));

app.route("/wallet", wallet);
app.route("/token", token);
app.route("/watch", watch);
app.route("/tx", tx);
app.route("/discover", discovery);
app.route("/portfolio", portfolio);
app.route("/smart-money", smartMoney);
app.route("/contract", contract);
app.route("/reputation", reputation);
app.route("/ask", askRoute);

/**
 * The payment middleware throws when it cannot load supported payment kinds from
 * the facilitator, which surfaced as an opaque 500 on every paid route during a
 * real outage. Name the cause instead, and use 503 so callers and monitors can
 * tell "come back shortly" apart from "this request was wrong".
 */
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  if (/no supported payment kinds|Failed to initialize/i.test(message)) {
    console.error(`[payment] facilitator unavailable: ${message}`);
    return c.json(
      {
        error: "facilitator_unavailable",
        message:
          "Payment terms could not be loaded from the facilitator, so this paid route cannot be " +
          "served right now. This is an upstream outage, not a problem with your request — retry " +
          "shortly. GET /ready reports when it clears.",
        facilitator: config.facilitatorUrl,
      },
      503,
    );
  }
  console.error(`[error] ${message}`);
  return c.json({ error: "internal_error", message: "Unexpected failure." }, 500);
});

/** Recognises the payment middleware's failure to reach the facilitator. */
function isFacilitatorInitFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /no supported payment kinds|Failed to initialize/i.test(message);
}

/**
 * Survive a facilitator outage instead of crash-looping through it.
 *
 * The middleware initialises its supported payment kinds eagerly, and when the
 * facilitator is unreachable at boot that rejection lands outside any request —
 * where app.onError cannot see it — and takes the process down. On a platform
 * that restarts on exit, that is a crash loop in which /health and /ready cannot
 * answer at all, which is strictly worse than serving free routes and reporting
 * the paid surface as unavailable.
 *
 * Scoped deliberately: only this known upstream failure is survivable. Anything
 * else still exits non-zero, because swallowing unknown faults hides real bugs.
 */
process.on("unhandledRejection", (reason) => {
  if (isFacilitatorInitFailure(reason)) {
    console.error(
      "[payment] facilitator unreachable during initialization — staying up to serve free " +
        "routes; paid routes will 503 until it recovers. GET /ready reports status.",
    );
    return;
  }
  console.error("[fatal] unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  if (isFacilitatorInitFailure(err)) {
    console.error(`[payment] facilitator unreachable: ${err.message} — staying up.`);
    return;
  }
  console.error("[fatal] uncaught exception:", err);
  process.exit(1);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Algo Verdict API listening on :${info.port}`);
  console.log(`  network:     algorand ${config.network} (${config.caip2})`);
  console.log(`  asset:       USDCa (ASA ${config.usdcAsaId})`);
  console.log(`  payTo:       ${config.sellerAddress}`);
  console.log(`  facilitator: ${config.facilitatorUrl}`);
});
