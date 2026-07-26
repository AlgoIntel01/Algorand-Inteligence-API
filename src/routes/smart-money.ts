import { Hono } from "hono";
import { parseJsonBody, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { analyzeSmartMoney } from "../analysis/smart-money.js";

export const smartMoney = new Hono();

smartMoney.post("/", async (c) => {
  let assetId: number;
  let windowDays: number | undefined;
  let limit: number | undefined;

  try {
    const body = await parseJsonBody(c.req.raw);
    const chain = body.chain;
    if (typeof chain === "string" && chain !== "algorand") {
      return c.json(
        {
          error: "unsupported_chain",
          message: `Smart money supports algorand only; got "${chain}".`,
        },
        400,
      );
    }

    const asset = requireString(body, "asset").trim();
    if (!/^\d+$/.test(asset)) {
      throw new ValidationError('"asset" must be an Algorand ASA id (0 for native ALGO)');
    }
    assetId = Number(asset);

    if (body.window_days !== undefined) {
      if (typeof body.window_days !== "number" || !Number.isInteger(body.window_days)) {
        throw new ValidationError('"window_days" must be an integer between 1 and 90');
      }
      windowDays = body.window_days;
    }
    if (body.limit !== undefined) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit)) {
        throw new ValidationError('"limit" must be an integer between 1 and 25');
      }
      limit = body.limit;
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    const result = await analyzeSmartMoney({ assetId, windowDays, limit });
    if (result === null) {
      return c.json(
        {
          error: "no_trades",
          message:
            `No swaps for asset ${assetId} in the requested window. Either the asset is not ` +
            "traded on a venue Vestige indexes, or nothing changed hands in that period.",
        },
        404,
      );
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[smart-money] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "Trade data source is currently unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});
