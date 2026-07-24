import "./config.js"; // ensures .env is loaded before we read process.env
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { RugScore } from "./analysis/token.js";
import type { WalletAnalysis } from "./analysis/wallet.js";
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

function shortHash(basis: unknown): string {
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

/**
 * Shared verdict plumbing: LLM-written when a key is configured, deterministic
 * template otherwise; cached by a hash of the decision-relevant signals so the
 * LLM only runs when the underlying picture actually changes (margin control).
 */
async function synthesize(
  cacheKey: string,
  systemPrompt: string,
  payload: unknown,
  template: () => string,
): Promise<VerdictResult> {
  const cached = getCached<VerdictResult>(cacheKey);
  if (cached) return cached;

  let result: VerdictResult;
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: VERDICT_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      });
      const text = response.content.find((b) => b.type === "text")?.text.trim();
      if (!text) throw new Error("empty verdict from model");
      result = { verdict: text, verdict_source: "llm" };
    } catch (err) {
      console.error(`[verdict] LLM failed, falling back to template: ${String(err)}`);
      result = { verdict: template(), verdict_source: "template" };
    }
  } else {
    result = { verdict: template(), verdict_source: "template" };
  }
  setCached(cacheKey, result, VERDICT_CACHE_TTL_SECONDS);
  return result;
}

// ---------------------------------------------------------------------------
// Token verdicts
// ---------------------------------------------------------------------------

const TOKEN_SYSTEM_PROMPT =
  "You write one-paragraph pre-trade token risk verdicts for AI trading agents. " +
  "Be direct and specific: state the risk level, the two or three signals that matter most " +
  "and why, and what would change the assessment. Base the verdict ONLY on the provided " +
  "signals — never invent data. 3-5 sentences, no headers, no bullet points, no hedging filler.";

function tokenTemplate(signals: TokenSignals, score: RugScore): string {
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

export async function generateVerdict(signals: TokenSignals, score: RugScore): Promise<VerdictResult> {
  const hash = shortHash({
    a: signals.asset,
    c: signals.chain,
    f: [...signals.flags].sort(),
    p: [...signals.positives].sort(),
    r: score.rug_probability,
    t10: signals.holders.top_10_concentration,
    liq:
      signals.liquidity.depth_usd === null
        ? null
        : Math.round(Math.log10(signals.liquidity.depth_usd + 1) * 10),
  });
  return synthesize(
    `verdict:${signals.chain}:${signals.asset}:${hash}`,
    TOKEN_SYSTEM_PROMPT,
    {
      token: { asset: signals.asset, chain: signals.chain, name: signals.name, symbol: signals.symbol },
      rug_probability: score.rug_probability,
      risk_signals: score.rug_signals,
      positive_signals: signals.positives,
      liquidity: signals.liquidity,
      holders: signals.holders,
    },
    () => tokenTemplate(signals, score),
  );
}

// ---------------------------------------------------------------------------
// Wallet verdicts
// ---------------------------------------------------------------------------

const WALLET_SYSTEM_PROMPT =
  "You write one-paragraph wallet intelligence verdicts for AI trading agents deciding whether " +
  "to trust or follow a counterparty wallet. Be direct: state what kind of actor this wallet " +
  "looks like, the two or three behavioral signals that matter most (funding origin, age, " +
  "activity pattern, cluster membership), and the confidence caveats. Base the verdict ONLY on " +
  "the provided signals — never invent data. 3-5 sentences, no headers, no bullets, no filler.";

function walletTemplate(analysis: WalletAnalysis): string {
  const { signals, score } = analysis;
  const risk =
    score.risk_score >= 0.6 ? "high-risk" : score.risk_score >= 0.3 ? "elevated-risk" : "low-risk";
  const parts: string[] = [
    `Wallet ${signals.address.slice(0, 10)}… on ${signals.chain} scores ${score.risk_score} risk (${risk}, confidence ${score.confidence}).`,
  ];
  if (signals.labels.length > 0) parts.push(`Labels: ${signals.labels.join(", ")}.`);
  else parts.push("No adverse behavioral labels detected in the sampled history.");
  const funder = signals.funding_ancestry[0];
  if (funder) {
    parts.push(
      `Funded by ${funder.name ?? funder.address.slice(0, 10) + "…"} (${funder.kind})${funder.funded_at ? ` on ${funder.funded_at.slice(0, 10)}` : ""}.`,
    );
  }
  if (signals.age_days !== null) {
    parts.push(
      `Age ${signals.age_days} days, ${signals.tx_count_sampled} txs sampled${signals.history_truncated ? " (history truncated — partial view)" : ""}.`,
    );
  }
  if (signals.co_funded_siblings.length > 0) {
    parts.push(`Co-funded with ${signals.co_funded_siblings.length} sibling wallets.`);
  }
  return parts.join(" ");
}

export async function generateWalletVerdict(analysis: WalletAnalysis): Promise<VerdictResult> {
  const { signals, score } = analysis;
  const hash = shortHash({
    a: signals.address,
    c: signals.chain,
    d: signals.depth,
    l: [...signals.labels].sort(),
    r: score.risk_score,
    anc: signals.funding_ancestry.map((h) => `${h.kind}:${h.address}`),
    sib: signals.co_funded_siblings.length,
  });
  return synthesize(
    `verdict:wallet:${signals.chain}:${signals.address}:${hash}`,
    WALLET_SYSTEM_PROMPT,
    {
      wallet: { address: signals.address, chain: signals.chain, depth: signals.depth },
      risk_score: score.risk_score,
      confidence: score.confidence,
      labels: signals.labels,
      funding_ancestry: signals.funding_ancestry,
      co_funded_siblings_count: signals.co_funded_siblings.length,
      behavior: {
        age_days: signals.age_days,
        txs_per_day: signals.txs_per_day,
        burst_share: signals.burst_share,
        longest_dormancy_days: signals.longest_dormancy_days,
        history_truncated: signals.history_truncated,
      },
    },
    () => walletTemplate(analysis),
  );
}
