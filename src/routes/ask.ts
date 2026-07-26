import { Hono } from "hono";
import { parseJsonBody, requireString, ValidationError } from "../validate.js";
import { AdapterError } from "../adapters/goplus.js";
import { ask, AskUnavailableError } from "../analysis/ask.js";

export const askRoute = new Hono();

const MAX_QUESTION_CHARS = 500;

askRoute.post("/", async (c) => {
  let question: string;
  try {
    const body = await parseJsonBody(c.req.raw);
    question = requireString(body, "question").trim();
    if (question.length > MAX_QUESTION_CHARS) {
      throw new ValidationError(`"question" must be ${MAX_QUESTION_CHARS} characters or fewer`);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  try {
    return c.json(await ask(question));
  } catch (err) {
    if (err instanceof AskUnavailableError) {
      return c.json({ error: "ask_unavailable", message: err.message }, 503);
    }
    if (err instanceof AdapterError) {
      console.error(`[ask] upstream failure (${err.upstream}): ${err.message}`);
      return c.json(
        {
          error: "upstream_unavailable",
          message: "A data source needed for this question is unavailable; retry shortly.",
          upstream: err.upstream,
        },
        502,
      );
    }
    console.error(`[ask] failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json(
      { error: "ask_failed", message: "The question could not be answered; retry shortly." },
      500,
    );
  }
});
