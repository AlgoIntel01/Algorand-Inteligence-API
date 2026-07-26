import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, ASK_MODEL } from "../llm.js";
import { SUPPORTED_CHAINS, type Chain } from "../config.js";
import { analyzeToken } from "./token-service.js";
import { analyzeWallet } from "./wallet.js";
import { explainTransaction } from "./tx-explain.js";
import { discover, DISCOVER_SIGNALS, type DiscoverSignal } from "./discover.js";
import { analyzePortfolio } from "./portfolio.js";
import { analyzeSmartMoney } from "./smart-money.js";
import { analyzeContract } from "./contract.js";
import { analyzeReputation } from "./reputation.js";
import { fetchAlgorandWalletHistory } from "../adapters/algorand-wallet.js";
import { fetchEvmWalletHistory } from "../adapters/evm-wallet.js";

/** Model turns allowed before the loop is cut off. */
const MAX_STEPS = 6;
const MAX_TOKENS = 1024;
/** Tool results are truncated before going back to the model to bound cost. */
const MAX_RESULT_CHARS = 6_000;

export class AskUnavailableError extends Error {}

export interface AskResponse {
  status: "ok";
  question: string;
  answer: string;
  /** Capabilities the model actually called, in order. */
  tools_used: Array<{ tool: string; input: Record<string, unknown> }>;
  /** The structured output every claim in the answer must rest on. */
  data: Record<string, unknown>;
  steps: number;
  truncated: boolean;
  model: string;
  notes: string[];
}

const SYSTEM_PROMPT =
  "You answer questions about Algorand and EVM blockchain activity for AI agents and developers.\n\n" +
  "You have tools that return real on-chain data. Rules you must follow:\n" +
  "- Answer ONLY from what the tools return. Never state a number, address, name or date the " +
  "tools did not give you.\n" +
  "- If the tools cannot answer the question, say plainly what is missing and stop. Do not guess.\n" +
  "- A null field means the data source could not provide it. Say so rather than treating it as " +
  "zero or as an absence of risk.\n" +
  "- Carry over the caveats the tools report. If a figure covers only a window, or a score is a " +
  "heuristic, or a benchmark was unavailable, the answer must say so.\n" +
  "- Call a tool when it would answer the question. Do not ask the user for information you can " +
  "look up.\n" +
  "- Be direct and concrete. Plain prose, no markdown, no bullet points, no headings. Lead with " +
  "the answer, then the evidence.\n\n" +
  "One hard fact about Algorand you must never contradict: the ledger stores only committed " +
  "transactions. A transaction that FAILED was never written to a block, so it cannot be looked " +
  "up or explained afterwards — not by these tools and not by any other service. If you are asked " +
  "why a transaction failed, say that plainly and explain that the only way to get that answer is " +
  "to simulate the transaction before submitting it (POST /tx/simulate). Never ask for the id of " +
  "a failed transaction and never offer to diagnose one after the fact.";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "analyze_token",
    description:
      "Rug risk and structure for a token: liquidity, holder concentration, deployer history, " +
      "rug probability with named signals. Works on ethereum, base, bsc, solana and algorand.",
    input_schema: {
      type: "object",
      properties: {
        asset: { type: "string", description: "Contract address, or ASA id on Algorand" },
        chain: { type: "string", enum: [...SUPPORTED_CHAINS] },
      },
      required: ["asset", "chain"],
    },
  },
  {
    name: "analyze_wallet",
    description:
      "Wallet behaviour and risk: funding ancestry, behavioural labels, age, activity pattern, " +
      "risk score with confidence. Chains: algorand, ethereum, base. Set deep for multi-hop " +
      "ancestry and co-funded wallet clusters.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string" },
        chain: { type: "string", enum: ["algorand", "ethereum", "base"] },
        deep: { type: "boolean", description: "Multi-hop ancestry and clustering. Slower." },
      },
      required: ["address", "chain"],
    },
  },
  {
    name: "explain_transaction",
    description:
      "What one Algorand transaction did: net asset movement for the sender across the whole " +
      "atomic group and inner transactions, protocol, fees, realised versus pre-trade rate, " +
      "safety flags. Committed transactions ONLY — a failed transaction is absent from the " +
      "ledger entirely, so this tool can never explain one and calling it for that is pointless.",
    input_schema: {
      type: "object",
      properties: { txid: { type: "string", description: "52-character Algorand transaction id" } },
      required: ["txid"],
    },
  },
  {
    name: "discover",
    description:
      "What is happening on Algorand DeFi right now: new_launches, trending, volume_growth, " +
      "liquidity_moves, fresh_lps, trending_protocols. Omit signals to get all of them.",
    input_schema: {
      type: "object",
      properties: {
        signals: { type: "array", items: { type: "string", enum: [...DISCOVER_SIGNALS] } },
        limit: { type: "integer", description: "Results per signal, 1-50" },
      },
    },
  },
  {
    name: "portfolio",
    description:
      "What an Algorand address holds: balances, USD valuation, allocation, LP positions and " +
      "30-day buy/sell flows on the largest positions.",
    input_schema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
  },
  {
    name: "smart_money",
    description:
      "The wallets moving an Algorand asset: buy and sell volume, average buy versus sell price, " +
      "holding period, current position, ranked by size over a window.",
    input_schema: {
      type: "object",
      properties: {
        asset: { type: "string", description: "Algorand ASA id; 0 for native ALGO" },
        window_days: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["asset"],
    },
  },
  {
    name: "analyze_contract",
    description:
      "An Algorand application: creator, privileged addresses in global state, state schemas, " +
      "TEAL version, which OnCompletion types the approval program tests for, and app-account TVL.",
    input_schema: {
      type: "object",
      properties: { app_id: { type: "string" } },
      required: ["app_id"],
    },
  },
  {
    name: "reputation",
    description:
      "Standing score for an Algorand address with every weighted component named, a rekey " +
      "penalty, and known burn or mixer addresses flagged. Cheaper and lighter than analyze_wallet.",
    input_schema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
  },
];

const str = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));

/**
 * Run one capability and return a compact view of it.
 *
 * Compact rather than complete on purpose: the model reasons better over the
 * decision-relevant fields, and every token of a full response envelope is paid
 * for on the way in and the way out. Callers wanting full fidelity call the
 * dedicated endpoint.
 */
async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "analyze_token": {
      const result = await analyzeToken(str(input.asset), input.chain as Chain);
      if (result === null) return { error: "asset not found on that chain" };
      return {
        asset: result.asset,
        chain: result.chain,
        name: result.name,
        symbol: result.symbol,
        rug_probability: result.rug_probability,
        rug_signals: result.rug_signals,
        positive_signals: result.positive_signals,
        liquidity: result.liquidity,
        holders: result.holders,
        verdict: result.verdict,
      };
    }
    case "analyze_wallet": {
      const chain = input.chain as Chain;
      const address = str(input.address);
      const deep = input.deep === true;
      const history =
        chain === "algorand"
          ? await fetchAlgorandWalletHistory(address, deep)
          : await fetchEvmWalletHistory(address, chain, deep);
      if (history === null) return { error: "address not found on that chain" };
      const { signals, score } = await analyzeWallet(history, deep);
      return {
        address: signals.address,
        chain: signals.chain,
        depth: signals.depth,
        risk_score: score.risk_score,
        confidence: score.confidence,
        labels: signals.labels,
        age_days: signals.age_days,
        txs_per_day: signals.txs_per_day,
        history_truncated: signals.history_truncated,
        funding_ancestry: signals.funding_ancestry.slice(0, 3),
        co_funded_siblings_count: signals.co_funded_siblings.length,
      };
    }
    case "explain_transaction": {
      const result = await explainTransaction(str(input.txid).toUpperCase());
      if (result === null) {
        return {
          error:
            "transaction not found. Failed transactions are never written to the Algorand " +
            "ledger, so they cannot be explained after the fact.",
        };
      }
      return {
        summary: result.summary,
        kind: result.kind,
        net_flows: result.net_flows,
        fees: result.fees,
        rate: result.rate,
        pricing: result.pricing,
        safety_flags: result.safety_flags,
      };
    }
    case "discover": {
      const signals = Array.isArray(input.signals)
        ? (input.signals as DiscoverSignal[])
        : undefined;
      const limit = typeof input.limit === "number" ? input.limit : 5;
      const result = await discover({ signals, limit });
      return { signals: result.signals, notes: result.notes };
    }
    case "portfolio": {
      const result = await analyzePortfolio(str(input.address));
      if (result === null) return { error: "account not found on Algorand" };
      return {
        total_value_usd: result.total_value_usd,
        priced_holdings: result.priced_holdings,
        unpriced_holdings: result.unpriced_holdings,
        holdings: result.holdings.slice(0, 8),
        lp_positions: result.lp_positions.length,
        realized_flows_30d: result.realized_flows_30d,
        notes: result.notes,
      };
    }
    case "smart_money": {
      const result = await analyzeSmartMoney({
        assetId: Number(str(input.asset)),
        windowDays: typeof input.window_days === "number" ? input.window_days : undefined,
        limit: typeof input.limit === "number" ? input.limit : 5,
      });
      if (result === null) return { error: "no swaps for that asset in the window" };
      return {
        asset_id: result.asset_id,
        asset_ticker: result.asset_ticker,
        window_days: result.window_days,
        traders: result.traders,
        cohort: result.cohort,
        methodology: result.methodology,
      };
    }
    case "analyze_contract": {
      const result = await analyzeContract(Number(str(input.app_id)));
      if (result === null) return { error: "application not found on Algorand" };
      return {
        app_id: result.app_id,
        creator: result.creator,
        deleted: result.deleted,
        privileged_addresses: result.privileged_addresses,
        program: result.program,
        holdings: result.holdings,
        audit_status: result.audit_status,
        methods: result.methods,
        risk_flags: result.risk_flags,
        notes: result.notes,
      };
    }
    case "reputation": {
      const result = await analyzeReputation(str(input.address));
      if (result === null) return { error: "account not found on Algorand" };
      return {
        trust_score: result.trust_score,
        computed_score: result.computed_score,
        tier: result.tier,
        known_entity: result.known_entity,
        confidence: result.confidence,
        components: result.components,
        positive_signals: result.positive_signals,
        negative_signals: result.negative_signals,
        identity: result.identity,
        account: result.account,
        activity: result.activity,
      };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function serialize(value: unknown): { text: string; truncated: boolean } {
  const json = JSON.stringify(value);
  if (json.length <= MAX_RESULT_CHARS) return { text: json, truncated: false };
  return {
    text:
      json.slice(0, MAX_RESULT_CHARS) +
      '… [truncated: ask a narrower question or call the endpoint directly for the full result]',
    truncated: true,
  };
}

/**
 * Answer a natural-language question by routing it across the other
 * capabilities, returning both the prose and the structured data behind it so
 * every claim can be checked against its source.
 */
export async function ask(question: string): Promise<AskResponse> {
  if (anthropic === null) {
    throw new AskUnavailableError(
      "No model is configured on this deployment, so /ask cannot answer.",
    );
  }

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const toolsUsed: AskResponse["tools_used"] = [];
  const data: Record<string, unknown> = {};
  const notes: string[] = [];
  let truncated = false;
  let answer = "";
  let steps = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    steps = step + 1;
    const response = await anthropic.messages.create({
      model: ASK_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      answer = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text.trim())
        .join(" ")
        .trim();
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      toolsUsed.push({ tool: block.name, input });

      let output: unknown;
      try {
        output = await runTool(block.name, input);
      } catch (err) {
        // A failing capability is data too: the model should say what could not
        // be read rather than the whole request collapsing.
        output = { error: `capability failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const key = `${block.name}:${Object.values(input).join(",")}`;
      data[key] = output;
      const serialized = serialize(output);
      truncated = truncated || serialized.truncated;
      results.push({ type: "tool_result", tool_use_id: block.id, content: serialized.text });
    }

    messages.push({ role: "user", content: results });
  }

  if (answer.length === 0) {
    answer =
      "I could not reach a final answer within the allowed number of steps. Try a narrower " +
      "question, or call the specific endpoint directly.";
    notes.push(`Stopped after ${MAX_STEPS} steps without a final answer.`);
  }
  if (toolsUsed.length === 0) {
    notes.push(
      "No capability was called for this question, so the answer rests on no on-chain data.",
    );
  }
  if (truncated) {
    notes.push("At least one tool result was truncated before the model saw it.");
  }
  notes.push(
    "Every figure in the answer comes from the structured results in `data`. Check them there " +
      "rather than trusting the prose.",
  );

  return {
    status: "ok",
    question,
    answer,
    tools_used: toolsUsed,
    data,
    steps,
    truncated,
    model: ASK_MODEL,
    notes,
  };
}
