import type { Chain } from "../config.js";
import type {
  WatchChange,
  WatchTarget,
  WatchWarning,
  WalletTx,
} from "../types.js";
import { analyzeToken } from "../analysis/token-service.js";
import { evmWalletChainSupported, fetchEvmTxsSince } from "../adapters/evm-wallet.js";
import { fetchAlgorandTxsSince } from "../adapters/algorand-wallet.js";
import { appendEvent, eventsSince, getSnapshot, pruneOldEvents, setSnapshot } from "./store.js";

const CONCURRENCY = 5;
const RUG_DELTA = 0.1;
const TOP10_DELTA = 0.05;
const LIQUIDITY_REL_DELTA = 0.2;
const LIQUIDITY_ABS_FLOOR_USD = 1_000;
const HOLDER_REL_DELTA = 0.1;

interface TokenWatchSnapshot {
  rug: number | null;
  flags: string[];
  depth: number | null;
  top10: number | null;
  holders: number | null;
}

const targetKey = (t: WatchTarget): string =>
  t.type === "wallet" ? `watch:wallet:${t.chain}:${t.address}` : `watch:token:${t.chain}:${t.asset}`;

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Refresh a token target and append diff events to the shared log. The analysis
 * comes through the shared 10-min token cache, so frequent polls are cheap and
 * change detection has ~10-min granularity by design.
 */
async function refreshTokenTarget(
  target: WatchTarget & { type: "token" },
): Promise<WatchWarning | null> {
  const key = targetKey(target);
  const analysis = await analyzeToken(target.asset, target.chain);
  if (analysis === null) {
    return { target, message: `Asset ${target.asset} not found on ${target.chain}.` };
  }
  const current: TokenWatchSnapshot = {
    rug: analysis.rug_probability,
    flags: [...analysis.rug_signals].sort(),
    depth: analysis.liquidity.depth_usd,
    top10: analysis.holders.top_10_concentration,
    holders: analysis.holders.count,
  };
  const prev = getSnapshot<TokenWatchSnapshot>(key);
  if (prev === null) {
    setSnapshot(key, current); // baseline — nothing to compare against yet
    return null;
  }

  let changed = false;
  const flagsAdded = current.flags.filter((f) => !prev.flags.includes(f));
  const flagsRemoved = prev.flags.filter((f) => !current.flags.includes(f));
  if (
    flagsAdded.length > 0 ||
    flagsRemoved.length > 0 ||
    (current.rug !== null && prev.rug !== null && Math.abs(current.rug - prev.rug) >= RUG_DELTA)
  ) {
    appendEvent(key, "token_risk_change", {
      rug_probability: { from: prev.rug, to: current.rug },
      flags_added: flagsAdded,
      flags_removed: flagsRemoved,
    });
    changed = true;
  }
  if (current.depth !== null && prev.depth !== null) {
    const delta = current.depth - prev.depth;
    if (
      Math.abs(delta) >= LIQUIDITY_ABS_FLOOR_USD &&
      prev.depth > 0 &&
      Math.abs(delta) / prev.depth >= LIQUIDITY_REL_DELTA
    ) {
      appendEvent(key, "token_liquidity_shift", {
        depth_usd: { from: prev.depth, to: current.depth },
        direction: delta > 0 ? "added" : "removed",
      });
      changed = true;
    }
  }
  const top10Moved =
    current.top10 !== null && prev.top10 !== null && Math.abs(current.top10 - prev.top10) >= TOP10_DELTA;
  const holdersMoved =
    current.holders !== null &&
    prev.holders !== null &&
    prev.holders > 0 &&
    Math.abs(current.holders - prev.holders) / prev.holders >= HOLDER_REL_DELTA;
  if (top10Moved || holdersMoved) {
    appendEvent(key, "token_holder_shift", {
      top_10_concentration: { from: prev.top10, to: current.top10 },
      holder_count: { from: prev.holders, to: current.holders },
    });
    changed = true;
  }
  if (changed) setSnapshot(key, current);
  return null;
}

/** Wallet activity since the subscriber's cursor — computed live, no event log. */
async function checkWalletTarget(
  target: WatchTarget & { type: "wallet" },
  sinceSec: number,
): Promise<{ change: WatchChange | null; warning: WatchWarning | null }> {
  const chain: Chain = target.chain;
  if (chain !== "algorand" && !evmWalletChainSupported(chain)) {
    return {
      change: null,
      warning: {
        target,
        message: `Wallet watching does not support ${chain} yet (supported: algorand, ethereum, base).`,
      },
    };
  }
  const txs: WalletTx[] =
    chain === "algorand"
      ? await fetchAlgorandTxsSince(target.address, sinceSec)
      : await fetchEvmTxsSince(target.address, chain, sinceSec);
  if (txs.length === 0) return { change: null, warning: null };

  const addr = chain === "algorand" ? target.address : target.address.toLowerCase();
  let largest: WalletTx | null = null;
  for (const t of txs) {
    if (BigInt(t.value || "0") > BigInt(largest?.value || "0")) largest = t;
  }
  const lastTs = Math.max(...txs.map((t) => t.timestamp));
  return {
    change: {
      type: "wallet_activity",
      target,
      observed_at: iso(Date.now()),
      detail: {
        tx_count_since_cursor: txs.length,
        last_activity: iso(lastTs * 1000),
        largest_native_transfer: largest
          ? {
              amount_base_units: largest.value,
              direction: largest.from === addr ? "out" : "in",
              counterparty: largest.from === addr ? largest.to : largest.from,
              at: iso(largest.timestamp * 1000),
            }
          : null,
      },
    },
    warning: null,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface WatchPollResult {
  changes: WatchChange[];
  warnings: WatchWarning[];
}

/**
 * Process one poll: refresh token targets (appending shared events), read events
 * newer than the subscriber's cursor, and compute wallet activity live for the
 * cursor window. Per-target failures become warnings, never a failed poll.
 */
export async function processPoll(
  targets: WatchTarget[],
  sinceMs: number | null,
): Promise<WatchPollResult> {
  pruneOldEvents();
  const changes: WatchChange[] = [];
  const warnings: WatchWarning[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  // First poll (no cursor): establish baselines and report nothing — the agent
  // gets a cursor and deltas begin from here. Honest and documented.
  const sinceSec = sinceMs !== null ? Math.floor(sinceMs / 1000) : nowSec;

  await mapLimit(targets, CONCURRENCY, async (target) => {
    try {
      if (target.type === "token") {
        const warning = await refreshTokenTarget(target);
        if (warning) warnings.push(warning);
        if (sinceMs !== null) {
          for (const ev of eventsSince(targetKey(target), sinceMs)) {
            changes.push({
              type: ev.type as WatchChange["type"],
              target,
              observed_at: iso(ev.ts),
              detail: ev.detail as Record<string, unknown>,
            });
          }
        }
      } else {
        const { change, warning } = await checkWalletTarget(target, sinceSec);
        if (change && sinceMs !== null) changes.push(change);
        if (warning) warnings.push(warning);
      }
    } catch (err) {
      warnings.push({
        target,
        message: `Check failed: ${err instanceof Error ? err.message : String(err)}. Retry next poll.`,
      });
    }
  });

  changes.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  return { changes, warnings };
}
