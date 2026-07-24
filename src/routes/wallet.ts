import { Hono } from "hono";
import { parseJsonBody, requireChain, requireString, ValidationError } from "../validate.js";
import type { WalletAnalyzeResponse } from "../types.js";
import { getCached, setCached } from "../cache.js";
import { AdapterError } from "../adapters/goplus.js";
import { evmWalletChainSupported, fetchEvmWalletHistory } from "../adapters/evm-wallet.js";
import { fetchAlgorandWalletHistory } from "../adapters/algorand-wallet.js";
import { analyzeWallet } from "../analysis/wallet.js";
import { generateWalletVerdict } from "../verdict.js";

export const wallet = new Hono();

const CACHE_TTL_SECONDS = 120; // spec: 1–2 min for wallets
const BEHAVIOR_NOTE =
  "entry_timing and realized_pnl require price-history correlation (roadmap); null, never fabricated.";
const CLUSTER_NOTE_STANDARD =
  "Co-funding cluster expansion and multi-hop ancestry run at depth=deep ($0.50).";

function supportedChains(): string[] {
  const chains = ["algorand", "ethereum", "base"];
  if (evmWalletChainSupported("bsc")) chains.push("bsc");
  return chains;
}

wallet.post("/analyze", async (c) => {
  let address: string;
  let chain: ReturnType<typeof requireChain>;
  try {
    const body = await parseJsonBody(c.req.raw);
    address = requireString(body, "address");
    chain = requireChain(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  // Depth is priced from the query string (?depth=deep → $0.50) before the
  // paywall runs; the body field is informational only.
  const deep = c.req.query("depth") === "deep";
  const depth = deep ? "deep" : "standard";

  const supported = supportedChains();
  if (!supported.includes(chain)) {
    // The paywall already charged — return 200 with an honest unsupported notice
    // rather than a 4xx that takes payment for nothing. Discovery metadata and
    // the unpaid 402 body both state supported chains up front.
    return c.json({
      status: "unsupported_chain",
      address,
      chain,
      depth,
      message:
        `Wallet analysis does not support ${chain} yet. Supported: ${supported.join(", ")}. ` +
        "Token analysis (/token/analyze) covers all five chains.",
      supported_chains: supported,
    });
  }

  const normalized = chain === "algorand" ? address : address.toLowerCase();
  const cacheKey = `wallet:${chain}:${normalized}:${depth}`;
  const cachedResponse = getCached<WalletAnalyzeResponse>(cacheKey);
  if (cachedResponse) {
    return c.json({ ...cachedResponse, cached: true });
  }

  try {
    const history =
      chain === "algorand"
        ? await fetchAlgorandWalletHistory(address, deep)
        : await fetchEvmWalletHistory(address, chain, deep);

    if (history === null) {
      return c.json(
        {
          error: "unknown_address",
          message: `Address ${address} was not found on ${chain} by our data sources.`,
        },
        404,
      );
    }

    const analysis = await analyzeWallet(history, deep);
    const { verdict, verdict_source } = await generateWalletVerdict(analysis);
    const { signals, score, holdDistribution } = analysis;

    const response: WalletAnalyzeResponse = {
      status: "ok",
      address: signals.address,
      chain,
      depth,
      risk_score: score.risk_score,
      confidence: score.confidence,
      labels: signals.labels,
      cluster: {
        members: signals.co_funded_siblings,
        funding_ancestry: signals.funding_ancestry,
        timing_correlation: {},
        ...(deep ? {} : { note: CLUSTER_NOTE_STANDARD }),
      },
      behavior: {
        age_days: signals.age_days,
        first_seen: signals.first_seen,
        last_seen: signals.last_seen,
        tx_count_sampled: signals.tx_count_sampled,
        txs_per_day: signals.txs_per_day,
        burst_share: signals.burst_share,
        inbound_outbound_ratio: signals.inbound_outbound_ratio,
        longest_dormancy_days: signals.longest_dormancy_days,
        entry_timing: null,
        hold_duration_distribution: holdDistribution,
        realized_pnl: null,
        note: BEHAVIOR_NOTE,
      },
      verdict,
      verdict_source,
      data_source: signals.source,
      cached: false,
    };
    setCached(cacheKey, response, CACHE_TTL_SECONDS);
    return c.json(response);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[wallet/analyze] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: `Data source for ${chain} is currently unavailable; retry shortly.`,
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});
