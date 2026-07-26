import { Hono } from "hono";
import { parseJsonBody, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { explainTransaction } from "../analysis/tx-explain.js";
import { SimulateInputError, simulateTransactions } from "../analysis/tx-simulate.js";

export const tx = new Hono();

/** Algorand transaction ids are 52-character base32. */
const TXID_PATTERN = /^[A-Z2-7]{52}$/;

tx.post("/explain", async (c) => {
  let txid: string;
  try {
    const body = await parseJsonBody(c.req.raw);
    txid = requireString(body, "txid").trim().toUpperCase();
    const chain = body.chain;
    // Transaction decoding is Algorand-only: it reads inner transactions and
    // atomic groups, which have no equivalent on the EVM chains we cover.
    if (typeof chain === "string" && chain !== "algorand") {
      return c.json(
        {
          error: "unsupported_chain",
          message: `Transaction explain supports algorand only; got "${chain}".`,
        },
        400,
      );
    }
    if (!TXID_PATTERN.test(txid)) {
      throw new ValidationError(
        '"txid" must be a 52-character Algorand transaction id (base32, A-Z and 2-7)',
      );
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    const explanation = await explainTransaction(txid);
    if (explanation === null) {
      return c.json(
        {
          error: "unknown_transaction",
          message:
            `Transaction ${txid} was not found on Algorand mainnet. Note that failed ` +
            "transactions are never written to the ledger, so they cannot be explained after the fact.",
        },
        404,
      );
    }
    return c.json(explanation);
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[tx/explain] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "Transaction data source is currently unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});

tx.post("/simulate", async (c) => {
  let txns: string[];
  try {
    const body = await parseJsonBody(c.req.raw);
    const raw = body.txns;
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      throw new ValidationError(
        '"txns" must be an array of base64-encoded Algorand transactions, unsigned or signed',
      );
    }
    txns = raw as string[];
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    return c.json(await simulateTransactions(txns));
  } catch (err) {
    if (err instanceof SimulateInputError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    if (err instanceof AdapterError) {
      console.error(`[tx/simulate] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "Algod is currently unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    throw err;
  }
});
