import type { TokenSignals } from "../types.js";

/**
 * Deterministic weighted rug score over normalized signals.
 * Weights sum informally toward 1.0 for a worst-case token; the score is
 * clamped to [0, 0.98] — certainty is never claimed in either direction.
 */
const FLAG_WEIGHTS: Record<string, number> = {
  // Fatal-class signals
  honeypot: 0.9,
  cannot_sell_all: 0.5,
  non_transferable: 0.6,
  // Supply/balance control
  owner_can_change_balance: 0.45,
  balance_mutable: 0.45,
  clawback_key_set: 0.35,
  mintable: 0.25,
  mint_authority_set: 0.25,
  // Freeze/pause control
  freeze_key_set: 0.15,
  freeze_authority_set: 0.15,
  transfers_pausable: 0.2,
  blacklist_function: 0.12,
  default_frozen: 0.2,
  // Ownership/config control
  hidden_owner: 0.3,
  ownership_reclaimable: 0.25,
  manager_key_set: 0.1,
  selfdestruct_present: 0.3,
  closable: 0.3,
  metadata_mutable: 0.05,
  transfer_hook: 0.1,
  // Market structure
  lp_unlocked: 0.25,
  closed_source: 0.15,
  proxy_contract: 0.08,
  low_price_confidence: 0.1,
};
const TAX_FLAG_WEIGHT = 0.2; // buy_tax_*/sell_tax_* flags

const POSITIVE_WEIGHTS: Record<string, number> = {
  trusted_token_list: 0.3,
  open_source: 0.05,
  ownership_renounced: 0.1,
  lp_locked: 0.1,
  mint_authority_revoked: 0.05,
  freeze_authority_revoked: 0.03,
  clawback_key_removed: 0.05,
};

export interface RugScore {
  rug_probability: number;
  rug_signals: string[];
  positive_signals: string[];
}

export function scoreRugProbability(signals: TokenSignals): RugScore {
  let score = 0;
  const contributing: string[] = [];

  for (const f of signals.flags) {
    const weight = FLAG_WEIGHTS[f] ?? (/^(buy|sell)_tax_\d+pct$/.test(f) ? TAX_FLAG_WEIGHT : 0.05);
    score += weight;
    contributing.push(f);
  }

  const top10 = signals.holders.top_10_concentration;
  if (top10 !== null && top10 > 0.5) {
    score += Math.min(0.3, (top10 - 0.5) * 0.8);
    contributing.push(`top10_holds_${Math.round(top10 * 100)}pct`);
  }
  if (signals.liquidity.depth_usd !== null && signals.liquidity.depth_usd < 10_000) {
    score += 0.15;
    contributing.push("thin_liquidity_under_10k_usd");
  }
  if (signals.holders.count !== null && signals.holders.count < 100) {
    score += 0.1;
    contributing.push("under_100_holders");
  }

  for (const p of signals.positives) {
    score -= POSITIVE_WEIGHTS[p] ?? 0.02;
  }

  return {
    rug_probability: Math.round(Math.min(0.98, Math.max(0, score)) * 100) / 100,
    rug_signals: contributing,
    positive_signals: signals.positives,
  };
}
