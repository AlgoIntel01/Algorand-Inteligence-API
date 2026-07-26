import { AdapterError } from "./goplus.js";

const VESTIGE = "https://api.vestigelabs.org";
const MAINNET = 0;
const TIMEOUT_MS = 15_000;

/** USDC ASA on Algorand mainnet — the denominator for every figure in this module. */
export const USDC_ASA = 31566704;
/** Vestige represents native ALGO as asset id 0. */
export const ALGO_ASA = 0;

/**
 * Shared Vestige client. Vestige denominates price, TVL and volume in ALGO
 * unless `denominating_asset_id` is passed — with no denominator USDC itself
 * comes back priced at ~11.8, and every "USD" figure downstream would be wrong
 * by the ALGO price. Every request built here pins the denominator to USDC, so
 * callers can treat these numbers as USD.
 */
function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${VESTIGE}${path}`);
  url.searchParams.set("network_id", String(MAINNET));
  url.searchParams.set("denominating_asset_id", String(USDC_ASA));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function get<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, params), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AdapterError(`vestige request failed: ${String(err)}`, "vestige");
  }
  if (res.status === 404) throw new AdapterError("not found on vestige", "vestige");
  if (!res.ok) throw new AdapterError(`vestige returned HTTP ${res.status}`, "vestige");
  return (await res.json()) as T;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface VestigeAsset {
  id: number;
  name: string | null;
  ticker: string | null;
  decimals: number | null;
  price: number | null;
  price1h: number | null;
  price1d: number | null;
  price7d: number | null;
  volume1d: number | null;
  volume7d: number | null;
  swaps1d: number | null;
  tvl: number | null;
  market_cap: number | null;
  created_at: number | null;
  rank: number | null;
}

function toAsset(raw: Record<string, unknown>): VestigeAsset {
  return {
    id: Number(raw.id),
    name: str(raw.name),
    ticker: str(raw.ticker),
    decimals: num(raw.decimals),
    price: num(raw.price),
    price1h: num(raw.price1h),
    price1d: num(raw.price1d),
    price7d: num(raw.price7d),
    volume1d: num(raw.volume1d),
    volume7d: num(raw.volume7d),
    swaps1d: num(raw.swaps1d),
    tvl: num(raw.tvl),
    market_cap: num(raw.market_cap),
    created_at: num(raw.created_at),
    rank: num(raw.rank),
  };
}

interface ListResponse {
  results?: Array<Record<string, unknown>>;
}

/**
 * Asset ids per request. The ids go in the query string, and an account holding
 * hundreds of assets otherwise produces a URI long enough for Vestige to reject
 * the request outright with HTTP 414.
 */
const ASSET_BATCH = 100;

/** Batch asset metadata (decimals, ticker, spot price). Untracked ids are absent. */
export async function fetchAssets(ids: number[]): Promise<Map<number, VestigeAsset>> {
  const out = new Map<number, VestigeAsset>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  for (let offset = 0; offset < unique.length; offset += ASSET_BATCH) {
    const batch = unique.slice(offset, offset + ASSET_BATCH);
    try {
      const body = await get<ListResponse>("/assets/list", {
        asset_ids: batch.join(","),
        limit: batch.length,
      });
      for (const raw of body.results ?? []) {
        const asset = toAsset(raw);
        out.set(asset.id, asset);
      }
    } catch (err) {
      // Metadata is enrichment: callers fall back to indexer asset params, or to
      // honest nulls. Never fail a paid call over a secondary source.
      console.error(`[vestige] asset metadata batch failed: ${String(err)}`);
    }
  }
  return out;
}

export interface ListAssetsOptions {
  orderBy?: string;
  orderDir?: "asc" | "desc";
  limit?: number;
  createdAfter?: number;
  volume1dGt?: number;
  tvlGt?: number;
}

/** Sorted/filtered asset list — the backbone of /discover. Throws on failure. */
export async function listAssets(opts: ListAssetsOptions = {}): Promise<VestigeAsset[]> {
  const body = await get<ListResponse>("/assets/list", {
    order_by: opts.orderBy,
    order_dir: opts.orderDir,
    limit: opts.limit ?? 25,
    created_at__gt: opts.createdAfter,
    volume1d__gt: opts.volume1dGt,
    tvl__gt: opts.tvlGt,
  });
  return (body.results ?? []).map(toAsset);
}

export interface HistoricPrice {
  price: number;
  /**
   * Vestige's own confidence in the quote, 0–1. Thinly traded assets come back
   * near zero, which makes the price usable as a rough valuation but useless as
   * a benchmark to compare an executed rate against.
   */
  confidence: number | null;
}

/**
 * Price of an asset in USD at a past moment, from hourly candles. Returns null
 * when Vestige has no candle covering that hour — an honest null beats pricing
 * a two-year-old transaction at today's rate.
 */
export async function priceAt(
  assetId: number,
  unixSeconds: number,
  hoursBack = 0,
): Promise<HistoricPrice | null> {
  const interval = 3600;
  const start = Math.floor(unixSeconds / interval) * interval - hoursBack * interval;
  try {
    const rows = await get<Array<Record<string, unknown>>>(`/assets/${assetId}/candles`, {
      interval,
      start,
      end: start + interval,
    });
    const candle = Array.isArray(rows) ? rows[0] : undefined;
    if (!candle) return null;
    const price = num(candle.close) ?? num(candle.open);
    if (price === null) return null;
    return { price, confidence: num(candle.confidence) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Swaps, pools, protocols
// ---------------------------------------------------------------------------

export interface VestigeSwap {
  block: number;
  timestamp: number;
  group: string | null;
  /**
   * The wallet that submitted the swap — the trader. Verified against the chain:
   * every outer transaction in a swap group carries this same sender.
   */
  address: string | null;
  /**
   * The account that executed the routing, which for an aggregated trade is the
   * router's own account and recurs across unrelated traders. NOT the trader.
   */
  executor: string | null;
  asset_1_id: number;
  asset_2_id: number;
  asset_1_delta: number | null;
  asset_2_delta: number | null;
  asset_1_delta_value: number | null;
  asset_2_delta_value: number | null;
}

function toSwap(raw: Record<string, unknown>): VestigeSwap {
  return {
    block: Number(raw.block ?? 0),
    timestamp: Number(raw.timestamp ?? 0),
    group: str(raw.group),
    address: str(raw.address),
    executor: str(raw.executor),
    asset_1_id: Number(raw.asset_1_id ?? 0),
    asset_2_id: Number(raw.asset_2_id ?? 0),
    asset_1_delta: num(raw.asset_1_delta),
    asset_2_delta: num(raw.asset_2_delta),
    asset_1_delta_value: num(raw.asset_1_delta_value),
    asset_2_delta_value: num(raw.asset_2_delta_value),
  };
}

export interface SwapQuery {
  assetId?: number;
  executor?: string;
  start?: number;
  end?: number;
  limit?: number;
  orderBy?: "offset" | "value";
  orderDir?: "asc" | "desc";
}

export async function fetchSwaps(query: SwapQuery): Promise<VestigeSwap[]> {
  const body = await get<ListResponse>("/swaps", {
    asset_id: query.assetId,
    executor: query.executor,
    start: query.start,
    end: query.end,
    limit: query.limit ?? 50,
    order_by: query.orderBy,
    order_dir: query.orderDir,
  });
  return (body.results ?? []).map(toSwap);
}

export interface VestigePool {
  protocol_id: number;
  application_id: number | null;
  address: string | null;
  asset_1_id: number;
  asset_2_id: number;
  created_at: number | null;
}

export async function listPools(opts: {
  limit?: number;
  orderBy?: string;
  orderDir?: "asc" | "desc";
  protocolId?: number;
}): Promise<VestigePool[]> {
  const body = await get<ListResponse>("/pools", {
    limit: opts.limit ?? 25,
    order_by: opts.orderBy,
    order_dir: opts.orderDir,
    protocol_id: opts.protocolId,
  });
  return (body.results ?? []).map((raw) => ({
    protocol_id: Number(raw.protocol_id ?? -1),
    application_id: num(raw.application_id),
    address: str(raw.address),
    asset_1_id: Number(raw.asset_1_id ?? 0),
    asset_2_id: Number(raw.asset_2_id ?? 0),
    created_at: num(raw.created_at),
  }));
}

/** 24h swap counts and USD volume per protocol, keyed by protocol id as a string. */
export async function protocolVolume(): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>("/protocols/volume", {});
}

export interface VestigeProtocol {
  id: number;
  name: string;
  version: string | null;
  url: string | null;
  tvl: number | null;
  active: boolean;
}

/** Protocol registry (Tinyman, Pact, HumbleSwap …), keyed by protocol id. */
export async function fetchProtocols(): Promise<Map<number, VestigeProtocol>> {
  const out = new Map<number, VestigeProtocol>();
  try {
    const rows = await get<Array<Record<string, unknown>>>("/protocols", {});
    for (const raw of Array.isArray(rows) ? rows : []) {
      const id = Number(raw.id);
      out.set(id, {
        id,
        name: String(raw.name ?? `protocol ${id}`),
        version: str(raw.version),
        url: str(raw.url),
        tvl: num(raw.tvl),
        active: raw.active === true,
      });
    }
  } catch (err) {
    console.error(`[vestige] protocol registry unavailable: ${String(err)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export interface WalletValue {
  /** Whole-unit balances keyed by asset id; native ALGO is id 0. */
  balances: Record<string, number>;
  /** Asset metadata (ticker, decimals, price) keyed by asset id. */
  assets: Record<string, Record<string, unknown>>;
  /** LP positions keyed by pool id. Empty for wallets that provide no liquidity. */
  pools: Record<string, unknown>;
}

/** Balances, prices and LP positions for one wallet in a single call. */
export async function fetchWalletValue(address: string): Promise<WalletValue | null> {
  try {
    const body = await get<Record<string, unknown>>(`/wallets/${address}/value`, {});
    return {
      balances: (body.balances ?? {}) as Record<string, number>,
      assets: (body.assets ?? {}) as Record<string, Record<string, unknown>>,
      pools: (body.pools ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export interface WalletAssetFlows {
  asset_id: number;
  amount_bought: number | null;
  bought_usd: number | null;
  amount_sold: number | null;
  sold_usd: number | null;
}

/**
 * Buy and sell flows for ONE asset over a window. Vestige scopes this per asset
 * (asset_id is required), and it reports traded amounts and their USD value —
 * not a profit figure. Cost basis established before the window is not visible
 * here, so anything derived from this must say which window it covers.
 */
export async function fetchWalletFlows(
  address: string,
  assetId: number,
  start: number,
  end?: number,
): Promise<WalletAssetFlows | null> {
  try {
    const body = await get<Record<string, unknown>>(`/wallets/${address}/pnl`, {
      asset_id: assetId,
      start,
      end,
    });
    const rec = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    if (!rec) return null;
    return {
      asset_id: assetId,
      amount_bought: num(rec.amount_bought),
      bought_usd: num(rec.amount_bought_value),
      amount_sold: num(rec.amount_sold),
      sold_usd: num(rec.amount_sold_value),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy price endpoint (used by token analysis)
// ---------------------------------------------------------------------------

export interface VestigePrice {
  price: number;
  confidence: number;
  total_lockup: number;
}

/** Price + TVL for one asset. Returns null when Vestige doesn't track it. */
export async function fetchAssetPrice(assetId: number): Promise<VestigePrice | null> {
  try {
    const body = await get<VestigePrice[]>("/assets/price", { asset_ids: assetId });
    const entry = Array.isArray(body) ? body[0] : undefined;
    if (!entry || typeof entry.price !== "number") return null;
    return entry;
  } catch {
    // Liquidity data is enrichment, not the core of the analysis — degrade to
    // nulls rather than failing a paid call over a secondary source.
    return null;
  }
}
