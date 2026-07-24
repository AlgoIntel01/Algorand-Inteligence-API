import type { Chain } from "./config.js";

/**
 * Shared response envelope. While the heuristics engine is not yet live,
 * every analysis response carries status "beta" and null scores — the shape
 * is final, the intelligence is not. Never fabricate signal values.
 */
export interface BetaEnvelope {
  status: "beta";
  note: string;
}

export interface WalletAnalyzeRequest {
  address: string;
  chain: Chain;
  depth?: "standard" | "deep";
}

/** One normalized transaction, shared across chain adapters. */
export interface WalletTx {
  hash: string;
  timestamp: number; // unix seconds
  from: string;
  to: string | null;
  /** Native value in the chain's base unit as a decimal string (wei / microalgo). */
  value: string;
  isContractCreation?: boolean;
}

/** One normalized token transfer (ERC-20 / ASA). */
export interface WalletTokenTransfer {
  timestamp: number;
  from: string;
  to: string | null;
  token: string; // contract address or ASA id
}

/** Common adapter output — everything the heuristics engine consumes. */
export interface WalletHistory {
  address: string;
  chain: Chain;
  isContract: boolean;
  /** Earliest transactions, ascending (funding ancestry lives here). */
  firstTxs: WalletTx[];
  /** Most recent transactions, descending. */
  recentTxs: WalletTx[];
  /** Token transfers involving the wallet (deep mode; may be empty). */
  tokenTransfers: WalletTokenTransfer[];
  /** Number of txs actually sampled (not necessarily the wallet's lifetime total). */
  txCountSampled: number;
  /** True when history is larger than what we sampled. */
  truncated: boolean;
}

export interface FundingHop {
  address: string;
  /** cex / mixer / contract / fresh_eoa / eoa / unknown */
  kind: string;
  /** Known-entity name when recognized (e.g. "Binance"). */
  name: string | null;
  funded_at: string | null; // ISO time of the funding tx into the previous hop
}

/** Heuristics output — the wallet analogue of TokenSignals. */
export interface WalletSignals {
  address: string;
  chain: Chain;
  depth: "standard" | "deep";
  is_contract: boolean;
  age_days: number | null;
  first_seen: string | null;
  last_seen: string | null;
  tx_count_sampled: number;
  history_truncated: boolean;
  txs_per_day: number | null;
  /** Share of sampled txs occurring <60s after the previous one (bot indicator). */
  burst_share: number | null;
  inbound_outbound_ratio: number | null;
  /** Longest inactivity gap in days within the sampled history. */
  longest_dormancy_days: number | null;
  funding_ancestry: FundingHop[];
  /** Wallets funded by the same funder within ±2h of this wallet (deep only). */
  co_funded_siblings: string[];
  labels: string[];
  source: string;
}

export interface WalletAnalyzeResponse {
  status: "ok" | "unsupported_chain";
  address: string;
  chain: Chain;
  depth: "standard" | "deep";
  risk_score: number | null;
  confidence: number | null;
  labels: string[];
  cluster: {
    members: string[];
    funding_ancestry: FundingHop[];
    timing_correlation: Record<string, number>;
    note?: string;
  };
  behavior: {
    age_days: number | null;
    first_seen: string | null;
    last_seen: string | null;
    tx_count_sampled: number;
    txs_per_day: number | null;
    burst_share: number | null;
    inbound_outbound_ratio: number | null;
    longest_dormancy_days: number | null;
    entry_timing: string | null;
    hold_duration_distribution: Record<string, number>;
    realized_pnl: number | null;
    note?: string;
  };
  verdict: string;
  verdict_source: "llm" | "template";
  data_source: string;
  cached: boolean;
  message?: string;
  supported_chains?: string[];
}

export interface TokenAnalyzeRequest {
  asset: string;
  chain: Chain;
}

/**
 * Normalized cross-chain token signals — the adapters' common output shape.
 * null means the source genuinely lacks the datum; never fabricate.
 */
export interface TokenSignals {
  asset: string;
  chain: Chain;
  name: string | null;
  symbol: string | null;
  liquidity: {
    depth_usd: number | null;
    lock_status: "locked" | "unlocked" | "unknown";
    lock_expiry: string | null;
  };
  holders: {
    count: number | null;
    top_10_concentration: number | null; // 0–1
    insider_overlap: number | null;
  };
  deployer: {
    address: string | null;
    prior_launches: number | null;
    prior_outcomes: string[];
  };
  /** Normalized risk flags, e.g. "honeypot", "clawback_key_set", "sell_tax_12pct" */
  flags: string[];
  /** Normalized positive signals, e.g. "open_source", "lp_locked" */
  positives: string[];
  source: string;
}

export interface TokenAnalyzeResponse {
  status: "ok";
  asset: string;
  chain: Chain;
  name: string | null;
  symbol: string | null;
  liquidity: {
    depth_usd: number | null;
    lock_status: "locked" | "unlocked" | "unknown";
    lock_expiry: string | null;
  };
  holders: {
    count: number | null;
    top_10_concentration: number | null;
    insider_overlap: number | null;
  };
  deployer: {
    address: string | null;
    prior_launches: number | null;
    prior_outcomes: string[];
  };
  rug_probability: number | null;
  rug_signals: string[];
  positive_signals: string[];
  /** Requires wallet tracking (v1.1) — always [] for now, see smart_money_note. */
  smart_money: Array<{ address: string; avg_entry: number }>;
  smart_money_note: string;
  verdict: string;
  verdict_source: "llm" | "template";
  data_source: string;
  cached: boolean;
}

export type WatchTarget =
  | { type: "wallet"; address: string; chain: Chain }
  | { type: "token"; asset: string; chain: Chain };

export interface WatchPollRequest {
  cursor?: string;
  watch: WatchTarget[];
}

export interface WatchChange {
  type: string;
  target: WatchTarget;
  observed_at: string;
  detail: Record<string, unknown>;
}

export interface WatchPollResponse extends BetaEnvelope {
  cursor: string;
  since: string | null;
  now: string;
  watched: number;
  changes: WatchChange[];
}
