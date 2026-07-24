import "./config.js"; // ensures .env is loaded before we read process.env
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { RugScore } from "./analysis/token.js";
import type { TokenSignals } from "./types.js";
import { getCached, setCached } from "./cache.js";

const VERDICT_MODEL = process.env.VERDICT_MODEL ?? "claude-haiku-4-5";
const VERDICT_CACHE_TTL_SECONDS = 24 * 60 * 60; // keyed by signals hash, so safe to keep long

const apiKey = process.env.ANTHROPIC_API_KEY;
const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

export interface VerdictResult {
  verdict: string;
  verdict_source: "llm" | "template";
}

/** Stable hash of the decision-relevant signal set — verdict regenerates only when this changes. */
export function signalsHash(signals: TokenSignals, score: RugScore): string {
  const basis = JSON.stringify({
    a: signals.asset,
    c: signals.chain,
    f: [...signals.flags].sort(),
    p: [...signals.positives].sort(),
    r: score.rug_probability,
    t10: signals.holders.top_10_concentration,
    liq: signals.liquidity.depth_usd === null ? null : Math.round(Math.log10(signals.liquidity.depth_usd + 1) * 10),
  });
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function templateVerdict(signals: TokenSignals, score: RugScore): string {
  const name = signals.symbol ?? signals.name ?? `asset ${signals.asset}`;
  const risk =
    score.rug_probability >= 0.6
      ? "high-risk"
      : score.rug_probability >= 0.3
        ? "elevated-risk"
        : "low-risk";
  const parts: string[] = [
    `${name} on ${signals.chain} scores ${score.rug_probability} rug probability (${risk}).`,
  ];
  if (score.rug_signals.length > 0) {
    parts.push(`Driving signals: ${score.rug_signals.slice(0, 5).join(", ")}.`);
  } else {
    parts.push("No adverse structural signals detected.");
  }
  if (signals.positives.length > 0) {
    parts.push(`Mitigating: ${signals.positives.slice(0, 4).join(", ")}.`);
  }
  if (signals.liquidity.depth_usd !== null) {
    parts.push(`Tracked liquidity ≈ $${signals.liquidity.depth_usd.toLocaleString("en-US")}.`);
  }
  return parts.join(" ");
}

async function llmVerdict(signals: TokenSignals, score: RugScore): Promise<string> {
  if (!anthropic) throw new Error("no ANTHROPIC_API_KEY");
  const response = await anthropic.messages.create({
    model: VERDICT_MODEL,
    max_tokens: 300,
    system:
      "You write one-paragraph pre-trade token risk verdicts for AI trading agents. " +
      "Be direct and specific: state the risk level, the two or three signals that matter most " +
      "and why, and what would change the assessment. Base the verdict ONLY on the provided " +
      "signals — never invent data. 3-5 sentences, no headers, no bullet points, no hedging filler.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          token: { asset: signals.asset, chain: signals.chain, name: signals.name, symbol: signals.symbol },
          rug_probability: score.rug_probability,
          risk_signals: score.rug_signals,
          positive_signals: signals.positives,
          liquidity: signals.liquidity,
          holders: signals.holders,
        }),
      },
    ],
  });
  const text = response.content.find((b) => b.type === "text")?.text.trim();
  if (!text) throw new Error("empty verdict from model");
  return text;
}

/**
 * Produce the verdict paragraph. LLM-written when an Anthropic key is configured,
 * deterministic template otherwise; cached by signals hash so the LLM only runs
 * when the underlying signals actually change (the spec's margin requirement).
 */
export async function generateVerdict(signals: TokenSignals, score: RugScore): Promise<VerdictResult> {
  const hash = signalsHash(signals, score);
  const cacheKey = `verdict:${signals.chain}:${signals.asset}:${hash}`;
  const cached = getCached<VerdictResult>(cacheKey);
  if (cached) return cached;

  let result: VerdictResult;
  if (anthropic) {
    try {
      result = { verdict: await llmVerdict(signals, score), verdict_source: "llm" };
    } catch (err) {
      console.error(`[verdict] LLM failed, falling back to template: ${String(err)}`);
      result = { verdict: templateVerdict(signals, score), verdict_source: "template" };
    }
  } else {
    result = { verdict: templateVerdict(signals, score), verdict_source: "template" };
  }
  setCached(cacheKey, result, VERDICT_CACHE_TTL_SECONDS);
  return result;
}
