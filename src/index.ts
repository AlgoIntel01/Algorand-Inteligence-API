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
import { loggingFacilitator } from "./facilitator.js";
import { assertConfig, config, PRICES, SUPPORTED_CHAINS } from "./config.js";
import { wallet } from "./routes/wallet.js";
import { token } from "./routes/token.js";
import { watch } from "./routes/watch.js";

assertConfig();

const facilitator = loggingFacilitator(new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
const resourceServer = registerExactAvmScheme(new x402ResourceServer(facilitator));
// Bazaar: enriches 402 PaymentRequired responses with discovery metadata the
// facilitator extracts and catalogs, so agents can find these endpoints.
resourceServer.registerExtension(bazaarResourceServerExtension);

function accepts(price: string | ((ctx: HTTPRequestContext) => string)) {
  return {
    scheme: "exact",
    network: config.caip2,
    payTo: config.sellerAddress,
    price,
    maxTimeoutSeconds: 120,
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
      "Wallet intelligence: risk score, behavioral labels, cluster membership, funding ancestry " +
      `and an LLM-written verdict. Chains: ${SUPPORTED_CHAINS.join(", ")}. ` +
      `Append ?depth=deep (${PRICES.walletAnalyzeDeep}) for full graph traversal.`,
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /wallet/analyze",
      `${PRICES.walletAnalyze} (deep: ${PRICES.walletAnalyzeDeep})`,
      "Judgment call on a wallet: who it moves with, when it enters, what that implies.",
    ),
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: { address: "0x1234abcd...", chain: "base" },
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Wallet address to analyze" },
          chain: { type: "string", enum: [...SUPPORTED_CHAINS] },
        },
        required: ["address", "chain"],
      },
      output: {
        example: {
          risk_score: null,
          confidence: null,
          labels: [],
          cluster: { members: [], funding_ancestry: [], timing_correlation: {} },
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
      `rug probability with driving signals, smart-money positioning. Chains: ${SUPPORTED_CHAINS.join(", ")}.`,
    mimeType: "application/json",
    unpaidResponseBody: unpaidBody(
      "POST /token/analyze",
      PRICES.tokenAnalyze,
      "Rug check and smart-money read on any token before an agent trades it.",
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
  "POST /watch/poll": {
    accepts: accepts(PRICES.watchPoll),
    resource: `${config.baseUrl}/watch/poll`,
    description:
      "Cursor-based delta poll over watched wallets and tokens: whale buys, cluster movements, " +
      "liquidity and holder shifts since your last poll. Empty deltas still ran the query.",
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
        example: { cursor: "eyJ2IjoxLCJ0IjoxNzg0ODg3ODk5NjYyfQ", watched: 1, changes: [] },
      },
    }),
  },
};

const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "Verdict",
    tagline: "The intelligence endpoint AI agents pay for, settled in USDCa on Algorand.",
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
      { route: "POST /watch/poll", price: PRICES.watchPoll },
    ],
    chains: SUPPORTED_CHAINS,
  }),
);
app.get("/health", (c) => c.json({ ok: true, network: config.network }));

app.use(paymentMiddleware(routes, resourceServer));

app.route("/wallet", wallet);
app.route("/token", token);
app.route("/watch", watch);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Verdict listening on :${info.port}`);
  console.log(`  network:     algorand ${config.network} (${config.caip2})`);
  console.log(`  asset:       USDCa (ASA ${config.usdcAsaId})`);
  console.log(`  payTo:       ${config.sellerAddress}`);
  console.log(`  facilitator: ${config.facilitatorUrl}`);
});
