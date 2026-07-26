import { Hono } from "hono";
import { parseOptionalJsonBody, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { discover, DISCOVER_SIGNALS, type DiscoverSignal } from "../analysis/discover.js";

export const discovery = new Hono();

discovery.post("/", async (c) => {
  let signals: DiscoverSignal[] | undefined;
  let limit: number | undefined;
  let createdAfter: number | undefined;

  try {
    // An empty body is valid and means "everything" — an agent exploring the
    // chain for the first time should not need to know the signal names.
    const body = await parseOptionalJsonBody(c.req.raw);

    const chain = body.chain;
    if (typeof chain === "string" && chain !== "algorand") {
      return c.json(
        {
          error: "unsupported_chain",
          message:
            `Discovery supports algorand only; got "${chain}". The DeFi data it reads ` +
            "(pools, protocol volume, asset creation) has no cross-chain equivalent here.",
        },
        400,
      );
    }

    if (body.signals !== undefined) {
      if (!Array.isArray(body.signals)) throw new ValidationError('"signals" must be an array');
      for (const signal of body.signals) {
        if (!DISCOVER_SIGNALS.includes(signal as DiscoverSignal)) {
          throw new ValidationError(
            `"${String(signal)}" is not a signal. Choose from: ${DISCOVER_SIGNALS.join(", ")}`,
          );
        }
      }
      signals = body.signals as DiscoverSignal[];
    }

    if (body.limit !== undefined) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit)) {
        throw new ValidationError('"limit" must be an integer');
      }
      limit = body.limit;
    }

    if (body.created_after !== undefined) {
      if (typeof body.created_after !== "number") {
        throw new ValidationError('"created_after" must be a unix timestamp in seconds');
      }
      createdAfter = body.created_after;
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    return c.json(await discover({ signals, limit, createdAfter }));
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[discover] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "The Algorand DeFi data source is currently unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});
