import { Hono } from "hono";
import { parseJsonBody, requireChain, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { analyzeToken } from "../analysis/token-service.js";

export const token = new Hono();

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

  try {
    const analysis = await analyzeToken(asset, chain);
    if (analysis === null) {
      return c.json(
        {
          error: "unknown_asset",
          message: `Asset ${asset} was not found on ${chain} by our data sources.`,
        },
        404,
      );
    }
    return c.json(analysis);
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
});
