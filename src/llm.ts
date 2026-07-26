import "./config.js"; // ensures .env is loaded before we read process.env
import Anthropic from "@anthropic-ai/sdk";

/**
 * The one Anthropic client in the process. Both the verdict writer and /ask use
 * it, so a missing key produces the same answer everywhere: no model, and the
 * caller is told rather than served something invented.
 */
const apiKey = process.env.ANTHROPIC_API_KEY;

export const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

/** Whether model-backed features can run at all. */
export const hasLlm = anthropic !== null;

/** Short prose written from already-computed signals. Cheap and cached upstream. */
export const VERDICT_MODEL = process.env.VERDICT_MODEL ?? "claude-haiku-4-5";

/**
 * Routing and synthesis across several capabilities. Separate from the verdict
 * model so the cheap per-analysis prose and the multi-step reasoning endpoint
 * can be tuned independently.
 */
export const ASK_MODEL = process.env.ASK_MODEL ?? "claude-haiku-4-5";
