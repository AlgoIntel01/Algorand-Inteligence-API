import { Hono } from "hono";
import { parseJsonBody, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { analyzeContract } from "../analysis/contract.js";

export const contract = new Hono();

contract.post("/analyze", async (c) => {
  let appId: number;
  try {
    const body = await parseJsonBody(c.req.raw);
    const chain = body.chain;
    if (typeof chain === "string" && chain !== "algorand") {
      return c.json(
        {
          error: "unsupported_chain",
          message:
            `Contract analysis supports algorand only; got "${chain}". It reads TEAL programs ` +
            "and application global state, which are Algorand-specific.",
        },
        400,
      );
    }
    const app = requireString(body, "app_id").trim();
    if (!/^\d+$/.test(app)) {
      throw new ValidationError('"app_id" must be a numeric Algorand application id');
    }
    appId = Number(app);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    const analysis = await analyzeContract(appId);
    if (analysis === null) {
      return c.json(
        {
          error: "unknown_application",
          message: `Application ${appId} was not found on Algorand mainnet.`,
        },
        404,
      );
    }
    return c.json(analysis);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[contract/analyze] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "Application data source is currently unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});
