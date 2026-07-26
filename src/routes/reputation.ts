import { Hono } from "hono";
import { ALGORAND_ADDRESS_REGEX } from "@x402-avm/avm";
import { parseJsonBody, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { analyzeReputation } from "../analysis/reputation.js";

export const reputation = new Hono();

reputation.post("/", async (c) => {
  let address: string;
  try {
    const body = await parseJsonBody(c.req.raw);
    const chain = body.chain;
    if (typeof chain === "string" && chain !== "algorand") {
      return c.json(
        {
          error: "unsupported_chain",
          message: `Reputation supports algorand only; got "${chain}".`,
        },
        400,
      );
    }
    address = requireString(body, "address").trim();
    if (!ALGORAND_ADDRESS_REGEX.test(address)) {
      throw new ValidationError('"address" must be a valid Algorand address');
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    const result = await analyzeReputation(address);
    if (result === null) {
      return c.json(
        {
          error: "unknown_account",
          message:
            `Account ${address} was not found on Algorand mainnet. An address with no on-chain ` +
            "history has no reputation to report, rather than a low one.",
        },
        404,
      );
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[reputation] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "Account data source is currently unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});
