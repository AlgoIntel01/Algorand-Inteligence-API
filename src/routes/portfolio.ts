import { Hono } from "hono";
import { ALGORAND_ADDRESS_REGEX } from "@x402-avm/avm";
import { parseJsonBody, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { analyzePortfolio } from "../analysis/portfolio.js";

export const portfolio = new Hono();

portfolio.post("/", async (c) => {
  let address: string;
  try {
    const body = await parseJsonBody(c.req.raw);
    address = requireString(body, "address").trim();
    const chain = body.chain;
    if (typeof chain === "string" && chain !== "algorand") {
      return c.json(
        {
          error: "unsupported_chain",
          message:
            `Portfolio supports algorand only; got "${chain}". Holdings, pricing and LP ` +
            "positions come from Algorand-native sources with no cross-chain equivalent here.",
        },
        400,
      );
    }
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
    const result = await analyzePortfolio(address);
    if (result === null) {
      return c.json(
        {
          error: "unknown_account",
          message: `Account ${address} was not found on Algorand mainnet.`,
        },
        404,
      );
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[portfolio] upstream failure (${err.upstream}): ${err.message}`);
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
