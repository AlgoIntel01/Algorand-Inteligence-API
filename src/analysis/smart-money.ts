import { getCached, setCached } from "../cache.js";
import { fetchGroupTransactions } from "../adapters/algorand-tx.js";
import { fetchAccountHoldings } from "../adapters/algorand-account.js";
import {
  fetchAssets,
  fetchSwaps,
  fetchWalletFlows,
  type VestigeSwap,
} from "../adapters/vestige.js";

const SMART_MONEY_TTL_SECONDS = 10 * 60;
/** Swaps pulled from Vestige before any aggregation. */
const SWAP_SAMPLE = 120;
/** Groups checked against the chain to confirm the reported submitter. */
const SUBMITTER_SPOT_CHECKS = 5;
const RESOLVE_CONCURRENCY = 6;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 10;

export interface SmartMoneyTrader {
  address: string;
  /** True when this wallet reached the pool through an aggregator or router. */
  routed: boolean;
  swaps_sampled: number;
  amount_bought: number | null;
  bought_usd: number | null;
  amount_sold: number | null;
  sold_usd: number | null;
  avg_buy_price_usd: number | null;
  avg_sell_price_usd: number | null;
  /** Average sell price against average buy price, within the window only. */
  round_trip_roi: number | null;
  /** First buy to last sell, in hours. Null unless both happened in the window. */
  holding_period_hours: number | null;
  current_position: number | null;
  current_position_usd: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface SmartMoneyResponse {
  status: "ok";
  chain: "algorand";
  asset_id: number;
  asset_ticker: string | null;
  window_days: number;
  traders: SmartMoneyTrader[];
  cohort: {
    traders_ranked: number;
    with_computable_roi: number;
    win_rate: number | null;
    median_roi: number | null;
  };
  methodology: string[];
  data_source: string;
  cached: boolean;
}

interface Aggregate {
  address: string;
  routed: boolean;
  swaps: number;
  firstBuyTs: number | null;
  lastSellTs: number | null;
  firstTs: number;
  lastTs: number;
  volumeUsd: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Which side of the trade the wallet was on. Vestige reports pool deltas: when
 * the pool's balance of the asset falls, it handed the asset to the trader.
 */
function directionFor(swap: VestigeSwap, assetId: number): "buy" | "sell" | null {
  const delta =
    swap.asset_1_id === assetId
      ? swap.asset_1_delta
      : swap.asset_2_id === assetId
        ? swap.asset_2_delta
        : null;
  if (delta === null || delta === 0) return null;
  return delta < 0 ? "buy" : "sell";
}

function usdValueFor(swap: VestigeSwap, assetId: number): number | null {
  const value =
    swap.asset_1_id === assetId
      ? swap.asset_1_delta_value
      : swap.asset_2_id === assetId
        ? swap.asset_2_delta_value
        : null;
  return value === null ? null : Math.abs(value);
}

/**
 * Confirm on-chain that the wallet Vestige reports as a swap's submitter really
 * did send the group.
 *
 * The trader is `swap.address`: every outer transaction in a swap group carries
 * that same sender. It is emphatically not `swap.executor`, which for an
 * aggregated trade is the router's own account and recurs across unrelated
 * traders — ranking by executor would produce a leaderboard of routers.
 *
 * Rather than fetch a group per trade to re-derive a field we already hold, a
 * few groups are spot-checked and the agreement rate is reported alongside the
 * results, so the claim is backed by evidence without paying for it every time.
 */
async function verifySubmitter(swap: VestigeSwap): Promise<boolean | null> {
  if (swap.group === null || swap.address === null) return null;
  try {
    const group = await fetchGroupTransactions(swap.group, swap.block);
    const outerSender = group[0]?.sender;
    if (typeof outerSender !== "string" || outerSender.length === 0) return null;
    return outerSender === swap.address;
  } catch {
    return null;
  }
}

export interface SmartMoneyOptions {
  assetId: number;
  windowDays?: number;
  limit?: number;
}

export async function analyzeSmartMoney(
  options: SmartMoneyOptions,
): Promise<SmartMoneyResponse | null> {
  const windowDays = Math.min(Math.max(options.windowDays ?? DEFAULT_WINDOW_DAYS, 1), 90);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 25);
  const assetId = options.assetId;

  const cacheKey = `smart-money:${assetId}:${windowDays}:${limit}`;
  const cached = getCached<SmartMoneyResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const windowStart = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const swaps = await fetchSwaps({
    assetId,
    start: windowStart,
    limit: SWAP_SAMPLE,
    orderBy: "value",
    orderDir: "desc",
  });
  if (swaps.length === 0) return null;

  // Several swap legs can share one atomic group; resolving per group rather
  // than per leg keeps the indexer calls proportional to trades, not hops.
  const byGroup = new Map<string, VestigeSwap[]>();
  for (const swap of swaps) {
    const key = swap.group ?? `nogroup:${swap.block}:${swap.executor}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(swap);
    else byGroup.set(key, [swap]);
  }

  const groups = [...byGroup.values()].sort(
    (a, b) => (usdValueFor(b[0], assetId) ?? 0) - (usdValueFor(a[0], assetId) ?? 0),
  );

  const spotChecks = await mapLimit(groups.slice(0, SUBMITTER_SPOT_CHECKS), RESOLVE_CONCURRENCY, (group) =>
    verifySubmitter(group[0]),
  );
  const checked = spotChecks.filter((result): result is boolean => result !== null);
  const agreed = checked.filter(Boolean).length;

  const aggregates = new Map<string, Aggregate>();
  groups.forEach((group) => {
    const address = group[0].address;
    const routed = address !== null && group[0].executor !== null && group[0].executor !== address;
    if (address === null) return;
    const existing = aggregates.get(address) ?? {
      address,
      routed,
      swaps: 0,
      firstBuyTs: null,
      lastSellTs: null,
      firstTs: Number.POSITIVE_INFINITY,
      lastTs: 0,
      volumeUsd: 0,
    };
    for (const swap of group) {
      const direction = directionFor(swap, assetId);
      if (direction === null) continue;
      existing.swaps += 1;
      existing.volumeUsd += usdValueFor(swap, assetId) ?? 0;
      existing.firstTs = Math.min(existing.firstTs, swap.timestamp);
      existing.lastTs = Math.max(existing.lastTs, swap.timestamp);
      if (direction === "buy") {
        existing.firstBuyTs =
          existing.firstBuyTs === null ? swap.timestamp : Math.min(existing.firstBuyTs, swap.timestamp);
      } else {
        existing.lastSellTs =
          existing.lastSellTs === null ? swap.timestamp : Math.max(existing.lastSellTs, swap.timestamp);
      }
    }
    existing.routed = existing.routed || routed;
    aggregates.set(address, existing);
  });

  const ranked = [...aggregates.values()]
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, limit);

  const [assetMeta, measured] = await Promise.all([
    fetchAssets([assetId]),
    // Window totals come from Vestige per wallet, not from the sampled swaps —
    // the sample only identifies who to look at, it cannot measure them fully.
    mapLimit(ranked, RESOLVE_CONCURRENCY, async (trader) => {
      const [flows, holdings] = await Promise.all([
        fetchWalletFlows(trader.address, assetId, windowStart),
        fetchAccountHoldings(trader.address).catch(() => null),
      ]);
      return { trader, flows, holdings };
    }),
  ]);

  const asset = assetMeta.get(assetId) ?? null;
  const decimals = asset?.decimals ?? null;
  const price = asset?.price ?? null;

  const traders: SmartMoneyTrader[] = measured.map(({ trader, flows, holdings }) => {
    const amountBought = flows?.amount_bought ?? null;
    const boughtUsd = flows?.bought_usd ?? null;
    const amountSold = flows?.amount_sold ?? null;
    const soldUsd = flows?.sold_usd ?? null;

    const avgBuy =
      amountBought !== null && boughtUsd !== null && amountBought > 0
        ? boughtUsd / amountBought
        : null;
    const avgSell =
      amountSold !== null && soldUsd !== null && amountSold > 0 ? soldUsd / amountSold : null;

    const held = holdings?.assets.find((entry) => entry.assetId === assetId);
    const position =
      assetId === 0
        ? holdings
          ? holdings.microAlgos / 1_000_000
          : null
        : held && decimals !== null
          ? Number(held.amount) / 10 ** decimals
          : held
            ? null
            : 0;

    return {
      address: trader.address,
      routed: trader.routed,
      swaps_sampled: trader.swaps,
      amount_bought: amountBought,
      bought_usd: boughtUsd,
      amount_sold: amountSold,
      sold_usd: soldUsd,
      avg_buy_price_usd: avgBuy,
      avg_sell_price_usd: avgSell,
      round_trip_roi:
        avgBuy !== null && avgSell !== null && avgBuy > 0
          ? Number((avgSell / avgBuy - 1).toFixed(4))
          : null,
      holding_period_hours:
        trader.firstBuyTs !== null && trader.lastSellTs !== null && trader.lastSellTs > trader.firstBuyTs
          ? Number(((trader.lastSellTs - trader.firstBuyTs) / 3600).toFixed(1))
          : null,
      current_position: position,
      current_position_usd: position !== null && price !== null ? position * price : null,
      first_seen: Number.isFinite(trader.firstTs)
        ? new Date(trader.firstTs * 1000).toISOString()
        : null,
      last_seen: trader.lastTs > 0 ? new Date(trader.lastTs * 1000).toISOString() : null,
    };
  });

  const withRoi = traders
    .map((trader) => trader.round_trip_roi)
    .filter((roi): roi is number => roi !== null);
  const sortedRoi = [...withRoi].sort((a, b) => a - b);
  const median =
    sortedRoi.length === 0
      ? null
      : sortedRoi.length % 2 === 1
        ? sortedRoi[(sortedRoi.length - 1) / 2]
        : (sortedRoi[sortedRoi.length / 2 - 1] + sortedRoi[sortedRoi.length / 2]) / 2;

  const response: SmartMoneyResponse = {
    status: "ok",
    chain: "algorand",
    asset_id: assetId,
    asset_ticker: asset?.ticker ?? null,
    window_days: windowDays,
    traders,
    cohort: {
      traders_ranked: traders.length,
      with_computable_roi: withRoi.length,
      win_rate:
        withRoi.length > 0
          ? Number((withRoi.filter((roi) => roi > 0).length / withRoi.length).toFixed(4))
          : null,
      median_roi: median === null ? null : Number(median.toFixed(4)),
    },
    methodology: [
      `Traders are the wallets behind the largest swaps of asset ${assetId} by USD value in the ` +
        `last ${windowDays} ${windowDays === 1 ? "day" : "days"}. This ranks by size, not by ` +
        "proven skill: it answers who is moving this asset, and is not a curated list of good traders.",
      "A trader is the wallet that submitted the swap group, never the routing account that " +
        "executed it — an aggregator's account recurs across unrelated traders and would " +
        "otherwise dominate this list. Wallets whose trade went through a router are marked " +
        `routed. ${checked.length > 0 ? `${agreed} of ${checked.length} sampled groups were checked against the chain and the submitter matched.` : "On-chain spot checks were unavailable for this window."}`,
      "round_trip_roi is the average sell price against the average buy price within the window. " +
        "It is not lifetime profit: tokens bought before the window carry no visible cost basis, " +
        "so a wallet that sells an old position shows a sell price with nothing to compare it to.",
      `win_rate is the share of the ${withRoi.length} ranked traders with a computable ` +
        "round_trip_roi that came out positive — not a win rate across all their trades.",
      `Ranking sampled the largest ${SWAP_SAMPLE} swaps by value; per-wallet totals then come ` +
        "from complete window figures, so the totals are not limited to that sample.",
    ],
    data_source: "vestige+nodely",
    cached: false,
  };

  setCached(cacheKey, response, SMART_MONEY_TTL_SECONDS);
  return response;
}
