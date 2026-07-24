import type { Chain } from "../config.js";
import type { TokenAnalyzeResponse, TokenSignals } from "../types.js";
import { getCached, setCached } from "../cache.js";
import { fetchGoPlusSignals } from "../adapters/goplus.js";
import { fetchAlgorandSignals } from "../adapters/algorand.js";
import { scoreRugProbability } from "./token.js";
import { generateVerdict } from "../verdict.js";

const ANALYSIS_TTL_SECONDS = 10 * 60; // spec: 5–15 min for tokens
const SMART_MONEY_NOTE =
  "smart_money requires the tracked-wallet engine (shipping with /wallet/analyze); empty for now, never fabricated.";

async function fetchSignals(asset: string, chain: Chain): Promise<TokenSignals | null> {
  return chain === "algorand" ? fetchAlgorandSignals(asset) : fetchGoPlusSignals(asset, chain);
}

/**
 * Full token analysis pipeline with the shared 10-min cache. Used by both the
 * paid /token/analyze route and the /watch/poll engine, so watch polls piggyback
 * on warm analyses instead of hammering upstream sources.
 * Returns null when the asset is unknown to our data sources.
 */
export async function analyzeToken(
  asset: string,
  chain: Chain,
): Promise<TokenAnalyzeResponse | null> {
  const cacheKey = `token:${chain}:${asset}`;
  const cached = getCached<TokenAnalyzeResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const signals = await fetchSignals(asset, chain);
  if (signals === null) return null;

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
  return response;
}
