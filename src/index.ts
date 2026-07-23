import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402-avm/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402-avm/core/server";
import type { RoutesConfig, HTTPRequestContext } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { assertConfig, config, PRICES, SUPPORTED_CHAINS } from "./config.js";
import { wallet } from "./routes/wallet.js";
import { token } from "./routes/token.js";
import { watch } from "./routes/watch.js";

assertConfig();

const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
const resourceServer = registerExactAvmScheme(new x402ResourceServer(facilitator));

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
