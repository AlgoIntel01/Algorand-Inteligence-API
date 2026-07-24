import type { Chain } from "../config.js";
import type { FundingHop, WalletHistory, WalletSignals, WalletTx } from "../types.js";
import { lookupKnownAddress } from "../data/known-addresses.js";
import {
  fetchEvmFirstIncoming,
  fetchEvmFunderTransfers,
} from "../adapters/evm-wallet.js";
import {
  fetchAlgorandFirstIncoming,
  fetchAlgorandFunderTransfers,
} from "../adapters/algorand-wallet.js";

const DAY = 86_400;
const FRESH_FUNDED_DAYS = 7;
const DORMANCY_DAYS = 90;
const BURST_WINDOW_SECONDS = 60;
const SIBLING_WINDOW_SECONDS = 2 * 60 * 60;
const MAX_ANCESTRY_HOPS_DEEP = 3;

const iso = (ts: number | undefined | null): string | null =>
  ts ? new Date(ts * 1000).toISOString() : null;

function firstIncomingOf(history: WalletHistory): WalletTx | null {
  return (
    history.firstTxs.find(
      (t) => t.to === history.address && BigInt(t.value || "0") > 0n,
    ) ?? null
  );
}

async function classifyHop(
  address: string,
  chain: Chain,
): Promise<{ kind: FundingHop["kind"]; name: string | null; firstIncoming: WalletTx | null }> {
  const known = lookupKnownAddress(address, chain);
  if (known) return { kind: known.label, name: known.name, firstIncoming: null };
  const { tx, sampledTxs } = await (chain === "algorand"
    ? fetchAlgorandFirstIncoming(address)
    : fetchEvmFirstIncoming(address, chain));
  // A funder with almost no history of its own is itself a fresh throwaway —
  // a classic layering pattern.
  const kind = sampledTxs > 0 && sampledTxs <= 5 ? "fresh_eoa" : sampledTxs > 0 ? "eoa" : "unknown";
  return { kind, name: null, firstIncoming: tx };
}

/**
 * Walk the funding chain upward: who funded this wallet, who funded the funder…
 * Stops at known entities (cex/mixer — the trail ends somewhere meaningful),
 * at wallets with no discoverable incoming transfer, or at the hop limit.
 */
async function walkFundingAncestry(
  history: WalletHistory,
  deep: boolean,
): Promise<FundingHop[]> {
  const hops: FundingHop[] = [];
  const maxHops = deep ? MAX_ANCESTRY_HOPS_DEEP : 1;
  const seen = new Set<string>([history.address]);

  let funding = firstIncomingOf(history);
  for (let i = 0; i < maxHops && funding; i++) {
    const funder = funding.from;
    if (seen.has(funder)) break; // cycle guard
    seen.add(funder);
    const { kind, name, firstIncoming } = await classifyHop(funder, history.chain);
    hops.push({ address: funder, kind, name, funded_at: iso(funding.timestamp) });
    if (kind === "cex" || kind === "mixer") break; // terminal: trail reaches an entity
    funding = firstIncoming;
  }
  return hops;
}

/** Wallets funded by the same funder within the sibling window (deep only). */
async function findCoFundedSiblings(
  history: WalletHistory,
  ancestry: FundingHop[],
): Promise<string[]> {
  const funding = firstIncomingOf(history);
  const funder = ancestry[0];
  if (!funding || !funder) return [];
  // A CEX hot wallet funds thousands of unrelated wallets — siblings would be noise.
  if (funder.kind === "cex") return [];
  const transfers =
    history.chain === "algorand"
      ? await fetchAlgorandFunderTransfers(funder.address, funding.timestamp, SIBLING_WINDOW_SECONDS)
      : await fetchEvmFunderTransfers(
          funder.address,
          history.chain,
          funding.timestamp,
          SIBLING_WINDOW_SECONDS,
        );
  const siblings = new Set<string>();
  for (const t of transfers) {
    if (t.to && t.to !== history.address && t.to !== funder.address) siblings.add(t.to);
  }
  return [...siblings].slice(0, 25);
}

interface BehaviorMetrics {
  ageDays: number | null;
  firstSeen: number | null;
  lastSeen: number | null;
  txsPerDay: number | null;
  burstShare: number | null;
  inOutRatio: number | null;
  longestDormancyDays: number | null;
}

function computeBehavior(history: WalletHistory): BehaviorMetrics {
  const all = [...history.firstTxs, ...history.recentTxs]
    .filter((t) => t.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (all.length === 0) {
    return {
      ageDays: null,
      firstSeen: null,
      lastSeen: null,
      txsPerDay: null,
      burstShare: null,
      inOutRatio: null,
      longestDormancyDays: null,
    };
  }
  const firstSeen = all[0].timestamp;
  const lastSeen = all[all.length - 1].timestamp;
  const ageDays = Math.max(0, (Date.now() / 1000 - firstSeen) / DAY);

  // Burst share and dormancy over the recent window only (contiguous sample).
  const recent = [...history.recentTxs].sort((a, b) => a.timestamp - b.timestamp);
  let bursts = 0;
  let longestGap = 0;
  for (let i = 1; i < recent.length; i++) {
    const gap = recent[i].timestamp - recent[i - 1].timestamp;
    if (gap < BURST_WINDOW_SECONDS) bursts++;
    if (gap > longestGap) longestGap = gap;
  }
  const activeSpanDays = Math.max(1 / 24, (lastSeen - firstSeen) / DAY);
  const inbound = recent.filter((t) => t.to === history.address).length;
  const outbound = recent.filter((t) => t.from === history.address).length;

  return {
    ageDays: Math.round(ageDays * 10) / 10,
    firstSeen,
    lastSeen,
    txsPerDay: history.truncated
      ? null // sampled windows over a truncated history make rates misleading
      : Math.round((history.txCountSampled / activeSpanDays) * 100) / 100,
    burstShare: recent.length > 5 ? Math.round((bursts / (recent.length - 1)) * 100) / 100 : null,
    inOutRatio:
      outbound > 0 ? Math.round((inbound / outbound) * 100) / 100 : inbound > 0 ? Infinity : null,
    longestDormancyDays: recent.length > 1 ? Math.round((longestGap / DAY) * 10) / 10 : null,
  };
}

function deriveLabels(
  history: WalletHistory,
  behavior: BehaviorMetrics,
  ancestry: FundingHop[],
  siblings: string[],
): string[] {
  const labels = new Set<string>();
  const funder = ancestry[0];

  if (behavior.ageDays !== null && behavior.ageDays <= FRESH_FUNDED_DAYS) labels.add("fresh_funded");
  if (funder?.kind === "cex") labels.add("cex_funded");
  if (ancestry.some((h) => h.kind === "mixer")) labels.add("mixer_adjacent");
  if (ancestry.length >= 2 && ancestry.slice(0, 2).every((h) => h.kind === "fresh_eoa")) {
    labels.add("layered_funding");
  }
  if (behavior.burstShare !== null && behavior.burstShare >= 0.5) labels.add("bot_like");
  // Rate labels need a meaningful sample — 5 txs in an hour is not "high frequency".
  if (
    behavior.txsPerDay !== null &&
    behavior.txsPerDay >= 50 &&
    history.txCountSampled >= 20
  ) {
    labels.add("high_frequency");
  }
  if (
    behavior.longestDormancyDays !== null &&
    behavior.longestDormancyDays >= DORMANCY_DAYS &&
    behavior.lastSeen !== null &&
    Date.now() / 1000 - behavior.lastSeen < 30 * DAY
  ) {
    labels.add("dormant_awakened");
  }
  if (behavior.inOutRatio !== null) {
    if (behavior.inOutRatio === Infinity || behavior.inOutRatio >= 10) labels.add("accumulator");
    else if (behavior.inOutRatio <= 0.1) labels.add("distributor");
  }
  if (history.recentTxs.some((t) => t.isContractCreation)) labels.add("contract_deployer");
  if (history.isContract) labels.add("is_contract");
  if (siblings.length >= 3) labels.add("cluster_member");

  return [...labels];
}

const LABEL_WEIGHTS: Record<string, number> = {
  mixer_adjacent: 0.45,
  layered_funding: 0.25,
  cluster_member: 0.2,
  fresh_funded: 0.15,
  bot_like: 0.15,
  dormant_awakened: 0.1,
  distributor: 0.05,
  high_frequency: 0.05,
  // risk reducers
  cex_funded: -0.15,
};

export interface WalletScore {
  risk_score: number;
  confidence: number;
}

export function scoreWallet(signals: WalletSignals): WalletScore {
  let score = 0.1; // base: an unknown wallet is never zero-risk
  for (const label of signals.labels) score += LABEL_WEIGHTS[label] ?? 0;
  // Age reduces risk, asymptotically (a 2-year wallet ≈ -0.2)
  if (signals.age_days !== null) score -= Math.min(0.2, signals.age_days / 3650);

  // Confidence: how much of the picture we actually saw.
  let confidence = 0.5;
  if (!signals.history_truncated) confidence += 0.2;
  if (signals.funding_ancestry.length > 0) confidence += 0.15;
  if (signals.tx_count_sampled > 20) confidence += 0.1;
  if (signals.depth === "deep") confidence += 0.05;
  if (signals.tx_count_sampled === 0) confidence = 0.2;

  return {
    risk_score: Math.round(Math.min(0.98, Math.max(0.01, score)) * 100) / 100,
    confidence: Math.round(Math.min(0.95, confidence) * 100) / 100,
  };
}

/** Hold-duration distribution from token transfers: time between first receiving
 * a token and first sending it on (deep mode; bucketed, best-effort). */
function holdDurations(history: WalletHistory): Record<string, number> {
  const firstIn = new Map<string, number>();
  const buckets: Record<string, number> = {};
  const sorted = [...history.tokenTransfers].sort((a, b) => a.timestamp - b.timestamp);
  for (const t of sorted) {
    if (t.to === history.address && !firstIn.has(t.token)) firstIn.set(t.token, t.timestamp);
    else if (t.from === history.address && firstIn.has(t.token)) {
      const held = t.timestamp - (firstIn.get(t.token) ?? t.timestamp);
      const bucket =
        held < 3600 ? "under_1h" : held < DAY ? "1h_24h" : held < 7 * DAY ? "1d_7d" : "over_7d";
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      firstIn.delete(t.token);
    }
  }
  return buckets;
}

export interface WalletAnalysis {
  signals: WalletSignals;
  score: WalletScore;
  holdDistribution: Record<string, number>;
}

export async function analyzeWallet(
  history: WalletHistory,
  deep: boolean,
): Promise<WalletAnalysis> {
  const ancestry = await walkFundingAncestry(history, deep);
  const siblings = deep ? await findCoFundedSiblings(history, ancestry) : [];
  const behavior = computeBehavior(history);
  const labels = deriveLabels(history, behavior, ancestry, siblings);

  const signals: WalletSignals = {
    address: history.address,
    chain: history.chain,
    depth: deep ? "deep" : "standard",
    is_contract: history.isContract,
    age_days: behavior.ageDays,
    first_seen: iso(behavior.firstSeen),
    last_seen: iso(behavior.lastSeen),
    tx_count_sampled: history.txCountSampled,
    history_truncated: history.truncated,
    txs_per_day: behavior.txsPerDay,
    burst_share: behavior.burstShare,
    inbound_outbound_ratio: behavior.inOutRatio === Infinity ? null : behavior.inOutRatio,
    longest_dormancy_days: behavior.longestDormancyDays,
    funding_ancestry: ancestry,
    co_funded_siblings: siblings,
    labels,
    source: history.chain === "algorand" ? "nodely" : "blockscout",
  };
  return { signals, score: scoreWallet(signals), holdDistribution: holdDurations(history) };
}
