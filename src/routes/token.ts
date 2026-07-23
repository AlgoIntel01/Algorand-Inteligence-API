import { Hono } from "hono";
import { parseJsonBody, requireChain, requireString, ValidationError } from "../validate.js";
import type { TokenAnalyzeResponse } from "../types.js";

export const token = new Hono();

const BETA_NOTE =
  "Verdict is in beta: payment, metering and response shape are live; liquidity/holder/deployer " +
  "analysis is not yet wired up, so scores are null and no signals are fabricated.";

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

  const response: TokenAnalyzeResponse = {
    status: "beta",
    note: BETA_NOTE,
    asset,
    chain,
    liquidity: { depth_usd: null, lock_status: "unknown", lock_expiry: null },
    holders: { count: null, top_10_concentration: null, insider_overlap: null },
    deployer: { address: null, prior_launches: null, prior_outcomes: [] },
    rug_probability: null,
    rug_signals: [],
    smart_money: [],
    verdict:
      `Beta response for asset ${asset} on ${chain}. ` +
      "The analysis engine is not yet live; this call validated payment and API shape only.",
  };
  return c.json(response);
});
