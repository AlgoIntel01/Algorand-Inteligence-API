import { Hono } from "hono";
import { parseJsonBody, requireChain, requireString, ValidationError } from "../validate.js";
import type { TokenAnalyzeResponse, TokenSignals } from "../types.js";
import { getCached, setCached } from "../cache.js";
import { AdapterError, fetchGoPlusSignals } from "../adapters/goplus.js";
import { fetchAlgorandSignals } from "../adapters/algorand.js";
import { scoreRugProbability } from "../analysis/token.js";
import { generateVerdict } from "../verdict.js";

export const token = new Hono();

const ANALYSIS_TTL_SECONDS = 10 * 60; // spec: 5–15 min for tokens
const SMART_MONEY_NOTE =
  "smart_money requires the tracked-wallet engine (shipping with /wallet/analyze); empty for now, never fabricated.";

async function fetchSignals(asset: string, chain: TokenSignals["chain"]): Promise<TokenSignals | null> {
  return chain === "algorand" ? fetchAlgorandSignals(asset) : fetchGoPlusSignals(asset, chain);
}

token.post("/analyze", async (c) => {
  let asset: string;
  let chain: ReturnType<typeof requireChain>;
  try {
    const body = await parseJsonBody(c.req.raw);
    asset = requireString(body, "asset");
    chain = requireChain(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  const cacheKey = `token:${chain}:${asset}`;
  const cachedResponse = getCached<TokenAnalyzeResponse>(cacheKey);
  if (cachedResponse) {
    return c.json({ ...cachedResponse, cached: true });
  }

  let signals: TokenSignals | null;
  try {
    signals = await fetchSignals(asset, chain);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[token/analyze] upstream failure (${err.upstream}): ${err.message}`);
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

  if (signals === null) {
    return c.json(
      {
        error: "unknown_asset",
        message: `Asset ${asset} was not found on ${chain} by our data sources.`,
      },
      404,
    );
  }

  const score = scoreRugProbability(signals);
  const { verdict, verdict_source } = await generateVerdict(signals, score);

  const response: TokenAnalyzeResponse = {
    status: "ok",
    asset,
    chain,
    name: signals.name,
    symbol: signals.symbol,
    liquidity: signals.liquidity,
    holders: signals.holders,
    deployer: signals.deployer,
    rug_probability: score.rug_probability,
    rug_signals: score.rug_signals,
    positive_signals: score.positive_signals,
    smart_money: [],
    smart_money_note: SMART_MONEY_NOTE,
    verdict,
    verdict_source,
    data_source: signals.source,
    cached: false,
  };
  setCached(cacheKey, response, ANALYSIS_TTL_SECONDS);
  return c.json(response);
});
