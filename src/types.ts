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

export interface WalletAnalyzeResponse extends BetaEnvelope {
  address: string;
  chain: Chain;
  depth: "standard" | "deep";
  risk_score: number | null;
  confidence: number | null;
  labels: string[];
  cluster: {
    members: string[];
    funding_ancestry: string[];
    timing_correlation: Record<string, number>;
  };
  behavior: {
    entry_timing: string | null;
    hold_duration_distribution: Record<string, number>;
    realized_pnl: number | null;
  };
  verdict: string;
}

export interface TokenAnalyzeRequest {
  asset: string;
  chain: Chain;
}

export interface TokenAnalyzeResponse extends BetaEnvelope {
  asset: string;
  chain: Chain;
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
  smart_money: Array<{ address: string; avg_entry: number }>;
  verdict: string;
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
