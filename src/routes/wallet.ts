import { Hono } from "hono";
import { parseJsonBody, requireChain, requireString, ValidationError } from "../validate.js";
import type { WalletAnalyzeResponse } from "../types.js";

export const wallet = new Hono();

const BETA_NOTE =
  "Verdict is in beta: payment, metering and response shape are live; the cluster/precursor " +
  "heuristics engine is not yet wired up, so scores are null and no signals are fabricated.";

wallet.post("/analyze", async (c) => {
  let body: Record<string, unknown>;
  let address: string;
  let chain: ReturnType<typeof requireChain>;
  try {
    body = await parseJsonBody(c.req.raw);
    address = requireString(body, "address");
    chain = requireChain(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  // Depth is priced from the query string (?depth=deep → $0.50), so the paid
  // tier is decided before the paywall — the body field is informational only.
  const depth = c.req.query("depth") === "deep" ? "deep" : "standard";

  const response: WalletAnalyzeResponse = {
    status: "beta",
    note: BETA_NOTE,
    address,
    chain,
    depth,
    risk_score: null,
    confidence: null,
    labels: [],
    cluster: { members: [], funding_ancestry: [], timing_correlation: {} },
    behavior: {
      entry_timing: null,
      hold_duration_distribution: {},
      realized_pnl: null,
    },
    verdict:
      `Beta response for ${address} on ${chain} (depth: ${depth}). ` +
      "The heuristics engine is not yet live; this call validated payment and API shape only.",
  };
  return c.json(response);
});
