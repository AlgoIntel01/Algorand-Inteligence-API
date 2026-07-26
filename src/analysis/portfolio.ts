import { getCached, setCached } from "../cache.js";
import { fetchAccountHoldings } from "../adapters/algorand-account.js";
import { fetchAssetParams } from "../adapters/algorand-tx.js";
import { fetchWalletFlows, fetchWalletValue } from "../adapters/vestige.js";

const PORTFOLIO_TTL_SECONDS = 60;
const FLOW_WINDOW_DAYS = 30;
/** Per-asset flow lookups fan out; hold the line at the largest positions. */
const MAX_FLOW_LOOKUPS = 15;
const FLOW_CONCURRENCY = 5;
const ALGO = 0;

export interface Holding {
  asset_id: number;
  name: string | null;
  ticker: string | null;
  amount: number;
  price_usd: number | null;
  value_usd: number | null;
  /** Share of the priced portfolio, 0-1. Null while nothing can be priced. */
  allocation: number | null;
  flows_30d: {
    bought_usd: number | null;
    sold_usd: number | null;
    net_usd: number | null;
  } | null;
}

export interface LpPosition {
  pool_id: string;
  detail: unknown;
}

export interface PortfolioResponse {
  status: "ok";
  chain: "algorand";
  address: string;
  total_value_usd: number | null;
  priced_holdings: number;
  unpriced_holdings: number;
  holdings: Holding[];
  lp_positions: LpPosition[];
  realized_flows_30d: {
    bought_usd: number;
    sold_usd: number;
    net_usd: number;
    basis: string;
  } | null;
  notes: string[];
  data_source: string;
  cached: boolean;
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
 * Everything an address holds, what it is worth, and what it traded recently.
 *
 * Holdings come from the indexer because the chain is the authority on balances;
 * prices and LP positions come from Vestige. An asset Vestige cannot price keeps
 * its balance and reports a null value rather than being dropped from the list —
 * a portfolio that silently omits positions is worse than one that admits it
 * cannot price them.
 */
export async function analyzePortfolio(address: string): Promise<PortfolioResponse | null> {
  const cacheKey = `portfolio:algorand:${address}`;
  const cached = getCached<PortfolioResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const holdingsOnChain = await fetchAccountHoldings(address);
  if (holdingsOnChain === null) return null;

  const value = await fetchWalletValue(address);
  const notes: string[] = [];

  const priceOf = (assetId: number): number | null => {
    const raw = value?.assets?.[String(assetId)];
    const price = raw?.price;
    return typeof price === "number" && Number.isFinite(price) ? price : null;
  };
  const metaOf = (assetId: number): { name: string | null; ticker: string | null; decimals: number | null } => {
    const raw = value?.assets?.[String(assetId)];
    return {
      name: typeof raw?.name === "string" ? raw.name : null,
      ticker: typeof raw?.ticker === "string" ? raw.ticker : null,
      decimals: typeof raw?.decimals === "number" ? raw.decimals : null,
    };
  };

  const rows: Holding[] = [];

  // Native ALGO first: it is the reserve asset and every account has it.
  const algoMeta = metaOf(ALGO);
  const algoAmount = holdingsOnChain.microAlgos / 1_000_000;
  const algoPrice = priceOf(ALGO);
  rows.push({
    asset_id: ALGO,
    name: algoMeta.name ?? "Algorand",
    ticker: "ALGO",
    amount: algoAmount,
    price_usd: algoPrice,
    value_usd: algoPrice === null ? null : algoAmount * algoPrice,
    allocation: null,
    flows_30d: null,
  });

  for (const asset of holdingsOnChain.assets) {
    const meta = metaOf(asset.assetId);
    let decimals = meta.decimals;
    if (decimals === null) {
      // Vestige does not track it, so the chain has to supply the decimals —
      // without them the balance cannot be rendered as a real quantity.
      const params = await fetchAssetParams(asset.assetId);
      decimals = params?.decimals ?? null;
      if (params) {
        meta.name = meta.name ?? params.name;
        meta.ticker = meta.ticker ?? params.unitName;
      }
    }
    if (decimals === null) continue;

    const amount = Number(asset.amount) / 10 ** decimals;
    const price = priceOf(asset.assetId);
    rows.push({
      asset_id: asset.assetId,
      name: meta.name,
      ticker: meta.ticker,
      amount,
      price_usd: price,
      value_usd: price === null ? null : amount * price,
      allocation: null,
      flows_30d: null,
    });
  }

  const priced = rows.filter((row) => row.value_usd !== null);
  const totalValue = priced.reduce((sum, row) => sum + (row.value_usd ?? 0), 0);
  for (const row of rows) {
    row.allocation =
      row.value_usd !== null && totalValue > 0
        ? Number((row.value_usd / totalValue).toFixed(4))
        : null;
  }
  rows.sort((a, b) => (b.value_usd ?? -1) - (a.value_usd ?? -1));

  // Trade flows for the largest positions only. Each is a separate upstream call,
  // and a wallet holding fifty dust assets should not turn into fifty lookups.
  const windowStart = Math.floor(Date.now() / 1000) - FLOW_WINDOW_DAYS * 86_400;
  const lookups = rows.slice(0, MAX_FLOW_LOOKUPS);
  const flows = await mapLimit(lookups, FLOW_CONCURRENCY, (row) =>
    fetchWalletFlows(address, row.asset_id, windowStart),
  );
  let boughtTotal = 0;
  let soldTotal = 0;
  let sawFlows = false;
  lookups.forEach((row, index) => {
    const flow = flows[index];
    if (flow === null) return;
    const bought = flow.bought_usd;
    const sold = flow.sold_usd;
    if (bought === null && sold === null) return;
    sawFlows = true;
    boughtTotal += bought ?? 0;
    soldTotal += sold ?? 0;
    row.flows_30d = {
      bought_usd: bought,
      sold_usd: sold,
      net_usd: bought !== null && sold !== null ? sold - bought : null,
    };
  });

  if (rows.length > MAX_FLOW_LOOKUPS) {
    notes.push(
      `Trade flows were fetched for the ${MAX_FLOW_LOOKUPS} largest positions only; ` +
        `${rows.length - MAX_FLOW_LOOKUPS} smaller holdings show null flows.`,
    );
  }
  const unpriced = rows.length - priced.length;
  if (unpriced > 0) {
    notes.push(
      `${unpriced} holding${unpriced === 1 ? "" : "s"} could not be priced and ${unpriced === 1 ? "is" : "are"} ` +
        "excluded from total_value_usd. Their balances are still listed.",
    );
  }
  notes.push(
    "Yield earned on LP positions is not reported: no data source exposes per-position APY for " +
      "these pools, and estimating it would be a guess.",
  );

  const lpPositions: LpPosition[] = Object.entries(value?.pools ?? {}).map(([poolId, detail]) => ({
    pool_id: poolId,
    detail,
  }));

  const response: PortfolioResponse = {
    status: "ok",
    chain: "algorand",
    address,
    total_value_usd: priced.length > 0 ? Number(totalValue.toFixed(2)) : null,
    priced_holdings: priced.length,
    unpriced_holdings: unpriced,
    holdings: rows,
    lp_positions: lpPositions,
    realized_flows_30d: sawFlows
      ? {
          bought_usd: Number(boughtTotal.toFixed(2)),
          sold_usd: Number(soldTotal.toFixed(2)),
          net_usd: Number((soldTotal - boughtTotal).toFixed(2)),
          basis:
            `USD sold minus USD bought over the last ${FLOW_WINDOW_DAYS} days, across the ` +
            "positions checked. This is not profit: a position opened before this window has no " +
            "visible cost basis, so its sale counts as inflow with nothing to subtract against.",
        }
      : null,
    notes,
    data_source: "nodely+vestige",
    cached: false,
  };

  setCached(cacheKey, response, PORTFOLIO_TTL_SECONDS);
  return response;
}
