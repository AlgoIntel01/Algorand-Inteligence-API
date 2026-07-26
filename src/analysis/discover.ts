import { getCached, setCached } from "../cache.js";
import { getSnapshot, setSnapshot } from "../watch/store.js";
import {
  fetchAssets,
  fetchProtocols,
  listAssets,
  listPools,
  protocolVolume,
  type VestigeAsset,
} from "../adapters/vestige.js";
import { AdapterError } from "../adapters/goplus.js";

const DISCOVER_TTL_SECONDS = 60;
/** Below this TVL an asset is noise: anyone can mint an ASA with no liquidity behind it. */
const LIQUIDITY_FLOOR_USD = 1_000;
/** Liquidity moves are measured hour over hour, not against the last 60-second poll. */
const TVL_SNAPSHOT_WINDOW_MS = 60 * 60 * 1000;
const TVL_MOVE_MIN_RELATIVE = 0.1;
const TVL_MOVE_MIN_ABSOLUTE_USD = 5_000;
const SCAN_LIMIT = 100;

export const DISCOVER_SIGNALS = [
  "new_launches",
  "trending",
  "volume_growth",
  "liquidity_moves",
  "fresh_lps",
  "trending_protocols",
] as const;
export type DiscoverSignal = (typeof DISCOVER_SIGNALS)[number];

export interface DiscoveredAsset {
  asset_id: number;
  name: string | null;
  ticker: string | null;
  price_usd: number | null;
  tvl_usd: number | null;
  volume_1d_usd: number | null;
  created_at: string | null;
  age_days: number | null;
  /** Only populated for signals that rank on a computed measure. */
  measure: { label: string; value: number } | null;
}

export interface DiscoveredPool {
  protocol: string | null;
  protocol_id: number;
  application_id: number | null;
  assets: [string | null, string | null];
  asset_ids: [number, number];
  created_at: string | null;
  age_hours: number | null;
}

export interface DiscoveredProtocol {
  protocol_id: number;
  name: string | null;
  url: string | null;
  swaps_1d: number | null;
  volume_1d_usd: number | null;
}

export interface DiscoverResponse {
  status: "ok";
  chain: "algorand";
  generated_at: string;
  signals: {
    new_launches?: DiscoveredAsset[];
    trending?: DiscoveredAsset[];
    volume_growth?: DiscoveredAsset[];
    liquidity_moves?: DiscoveredAsset[];
    fresh_lps?: DiscoveredPool[];
    trending_protocols?: DiscoveredProtocol[];
  };
  notes: string[];
  data_source: string;
  cached: boolean;
}

const iso = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

function ageDays(createdAt: number | null): number | null {
  if (createdAt === null) return null;
  return Math.round((Date.now() / 1000 - createdAt) / 86_400);
}

function toDiscovered(
  asset: VestigeAsset,
  measure: { label: string; value: number } | null = null,
): DiscoveredAsset {
  return {
    asset_id: asset.id,
    name: asset.name,
    ticker: asset.ticker,
    price_usd: asset.price,
    tvl_usd: asset.tvl,
    volume_1d_usd: asset.volume1d,
    created_at: iso(asset.created_at),
    age_days: ageDays(asset.created_at),
    measure,
  };
}

/**
 * Assets whose 24h volume is running hot against their own 7-day average. Ranked
 * on the ratio rather than raw volume, so a small asset waking up outranks a
 * large one trading normally — the whole point of a discovery feed.
 */
function rankVolumeGrowth(assets: VestigeAsset[], limit: number): DiscoveredAsset[] {
  const scored: Array<{ asset: VestigeAsset; ratio: number }> = [];
  for (const asset of assets) {
    const daily = asset.volume1d;
    const weekly = asset.volume7d;
    if (daily === null || weekly === null || weekly <= 0) continue;
    const baseline = weekly / 7;
    // A baseline this thin makes the ratio meaningless — one trade would top the list.
    if (baseline < LIQUIDITY_FLOOR_USD / 10) continue;
    scored.push({ asset, ratio: daily / baseline });
  }
  return scored
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, limit)
    .map((entry) =>
      toDiscovered(entry.asset, {
        label: "volume_1d_vs_7d_average",
        value: Number(entry.ratio.toFixed(2)),
      }),
    );
}

/**
 * Liquidity moves, measured against a stored snapshot rather than computed from
 * a single reading. The first call for an asset can only establish a baseline —
 * the same honest model /watch/poll uses for its first poll.
 */
function detectLiquidityMoves(assets: VestigeAsset[], limit: number): DiscoveredAsset[] {
  const moves: Array<{ asset: VestigeAsset; delta: number; from: number }> = [];
  const now = Date.now();

  for (const asset of assets) {
    const tvl = asset.tvl;
    if (tvl === null || tvl <= 0) continue;
    const key = `discover:tvl:${asset.id}`;
    const previous = getSnapshot<{ tvl: number; at: number }>(key);

    if (previous === null) {
      setSnapshot(key, { tvl, at: now });
      continue;
    }

    const delta = tvl - previous.tvl;
    const relative = previous.tvl > 0 ? Math.abs(delta) / previous.tvl : 0;
    if (relative >= TVL_MOVE_MIN_RELATIVE && Math.abs(delta) >= TVL_MOVE_MIN_ABSOLUTE_USD) {
      moves.push({ asset, delta, from: previous.tvl });
    }
    // Roll the baseline forward only once the window has elapsed, so the measure
    // stays "change over the last hour" instead of "change since 60 seconds ago".
    if (now - previous.at >= TVL_SNAPSHOT_WINDOW_MS) {
      setSnapshot(key, { tvl, at: now });
    }
  }

  return moves
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit)
    .map((move) =>
      toDiscovered(move.asset, {
        label: "tvl_change_usd_since_last_hourly_baseline",
        value: Math.round(move.delta),
      }),
    );
}

export interface DiscoverOptions {
  signals?: DiscoverSignal[];
  limit?: number;
  createdAfter?: number;
}

/**
 * The discovery feed. Every signal is computed from live Vestige data; where a
 * measure needs history we keep our own snapshots rather than inferring a trend
 * from a single reading.
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoverResponse> {
  const signals = options.signals?.length ? options.signals : [...DISCOVER_SIGNALS];
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const cacheKey = `discover:${[...signals].sort().join(",")}:${limit}:${options.createdAfter ?? "any"}`;
  const cached = getCached<DiscoverResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const notes: string[] = [];
  const wants = (signal: DiscoverSignal): boolean => signals.includes(signal);

  // One broad scan feeds trending, volume growth and liquidity moves; asking
  // Vestige three times for overlapping slices of the same table would be waste.
  const needsScan = wants("trending") || wants("volume_growth") || wants("liquidity_moves");
  const [newLaunches, scan, pools, protocolVolume, protocols] = await Promise.all([
    wants("new_launches")
      ? listAssets({
          orderBy: "created_at",
          orderDir: "desc",
          limit,
          tvlGt: LIQUIDITY_FLOOR_USD,
          createdAfter: options.createdAfter,
        })
      : Promise.resolve([]),
    needsScan
      ? listAssets({ orderBy: "volume1d", orderDir: "desc", limit: SCAN_LIMIT })
      : Promise.resolve([]),
    wants("fresh_lps")
      ? listPools({ orderBy: "created_at", orderDir: "desc", limit })
      : Promise.resolve([]),
    wants("trending_protocols") ? fetchProtocolVolume() : Promise.resolve(new Map()),
    wants("fresh_lps") || wants("trending_protocols") ? fetchProtocols() : Promise.resolve(new Map()),
  ]);

  const response: DiscoverResponse = {
    status: "ok",
    chain: "algorand",
    generated_at: new Date().toISOString(),
    signals: {},
    notes,
    data_source: "vestige",
    cached: false,
  };

  if (wants("new_launches")) {
    response.signals.new_launches = newLaunches.map((asset) => toDiscovered(asset));
    notes.push(
      `new_launches lists the most recently created assets holding at least $${LIQUIDITY_FLOOR_USD.toLocaleString("en-US")} ` +
        "of liquidity. Assets below that floor are excluded: minting an ASA costs almost nothing " +
        "and most carry no liquidity at all.",
    );
    if (newLaunches.length === 0) {
      notes.push("No asset met both the creation window and the liquidity floor.");
    }
  }

  if (wants("trending")) {
    const trending = [...scan]
      .filter((asset) => asset.swaps1d !== null)
      .sort((a, b) => (b.swaps1d ?? 0) - (a.swaps1d ?? 0))
      .slice(0, limit)
      .map((asset) =>
        toDiscovered(asset, { label: "swaps_1d", value: asset.swaps1d ?? 0 }),
      );
    response.signals.trending = trending;
  }

  if (wants("volume_growth")) {
    response.signals.volume_growth = rankVolumeGrowth(scan, limit);
  }

  if (wants("liquidity_moves")) {
    const moves = detectLiquidityMoves(scan, limit);
    response.signals.liquidity_moves = moves;
    notes.push(
      "liquidity_moves compares current TVL against our own hourly snapshot. An asset seen for " +
        "the first time can only establish a baseline, so it will not appear until the next hour.",
    );
  }

  if (wants("fresh_lps")) {
    const assetIds = pools.flatMap((pool) => [pool.asset_1_id, pool.asset_2_id]);
    const meta = await fetchAssets(assetIds);
    response.signals.fresh_lps = pools.map((pool) => ({
      protocol: protocols.get(pool.protocol_id)?.name ?? null,
      protocol_id: pool.protocol_id,
      application_id: pool.application_id,
      assets: [
        meta.get(pool.asset_1_id)?.ticker ?? null,
        meta.get(pool.asset_2_id)?.ticker ?? null,
      ],
      asset_ids: [pool.asset_1_id, pool.asset_2_id],
      created_at: iso(pool.created_at),
      age_hours:
        pool.created_at === null
          ? null
          : Math.round((Date.now() / 1000 - pool.created_at) / 3600),
    }));
  }

  if (wants("trending_protocols")) {
    const ranked: DiscoveredProtocol[] = [...protocolVolume.entries()]
      .map(([protocolId, stats]) => ({
        protocol_id: protocolId,
        name: protocols.get(protocolId)?.name ?? null,
        url: protocols.get(protocolId)?.url ?? null,
        swaps_1d: stats.swaps,
        volume_1d_usd: stats.volume,
      }))
      .sort((a, b) => (b.volume_1d_usd ?? 0) - (a.volume_1d_usd ?? 0))
      .slice(0, limit);
    response.signals.trending_protocols = ranked;
  }

  notes.push(
    "Smart-money positioning is deliberately absent here — it belongs to /smart-money, where the " +
      "methodology and its window can be stated alongside the numbers.",
  );

  setCached(cacheKey, response, DISCOVER_TTL_SECONDS);
  return response;
}

/** Protocol volume totals keyed by protocol id. Enrichment: degrades to empty. */
async function fetchProtocolVolume(): Promise<Map<number, { swaps: number; volume: number }>> {
  const out = new Map<number, { swaps: number; volume: number }>();
  try {
    const body = await protocolVolume();
    for (const [protocolId, stats] of Object.entries(body)) {
      const record = stats as Record<string, unknown>;
      out.set(Number(protocolId), {
        swaps: Number(record.total_swaps ?? 0),
        volume: Number(record.total_volume ?? 0),
      });
    }
  } catch (err) {
    if (err instanceof AdapterError) {
      console.error(`[discover] protocol volume unavailable: ${err.message}`);
      return out;
    }
    throw err;
  }
  return out;
}
