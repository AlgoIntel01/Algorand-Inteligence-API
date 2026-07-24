import type { TokenSignals } from "../types.js";
import { AdapterError } from "./goplus.js";

const INDEXER = "https://mainnet-idx.algonode.cloud";
const VESTIGE = "https://api.vestigelabs.org";
const USDC_ASA = 31566704;
// algosdk.encodeAddress(new Uint8Array(32)) — a key set to this is effectively removed
const ZERO_ADDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

async function getJson(url: string, upstream: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new AdapterError(`${upstream} request failed: ${String(err)}`, upstream);
  }
  if (res.status === 404) throw new AdapterError(`asset not found on ${upstream}`, upstream);
  if (!res.ok) throw new AdapterError(`${upstream} returned HTTP ${res.status}`, upstream);
  return (await res.json()) as Record<string, unknown>;
}

interface VestigePrice {
  price: number;
  confidence: number;
  total_lockup: number;
}

/** Price + TVL denominated in USDC. Returns null when Vestige doesn't track the asset. */
async function fetchVestige(assetId: number): Promise<VestigePrice | null> {
  try {
    const body = (await getJson(
      `${VESTIGE}/assets/price?asset_ids=${assetId}&network_id=0&denominating_asset_id=${USDC_ASA}`,
      "vestige",
    )) as unknown as VestigePrice[];
    const entry = Array.isArray(body) ? body[0] : undefined;
    if (!entry || typeof entry.price !== "number") return null;
    return entry;
  } catch {
    // Liquidity data is enrichment, not the core of the analysis — degrade to nulls
    // rather than failing a paid call over a secondary source.
    return null;
  }
}

const PAGE_LIMIT = 1000;
const MAX_PAGES = 2;

/**
 * Top-10 concentration among circulating holders. The indexer pages balances in
 * address order (not amount order), so this is only computable when the full
 * holder set fits within MAX_PAGES; larger assets (and indexer hiccups) return
 * honest nulls rather than failing or stalling the paid call. Note: a page can
 * carry a next-token even when it is the final page — a short page (< limit)
 * is the practical completion signal.
 */
async function fetchHolders(
  assetId: number,
  creator: string,
  reserve: string | null,
): Promise<{ count: number | null; top10: number | null }> {
  const balances: Array<{ address: string; amount: bigint }> = [];
  try {
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        `${INDEXER}/v2/assets/${assetId}/balances?limit=${PAGE_LIMIT}&currency-greater-than=0` +
        (next ? `&next=${encodeURIComponent(next)}` : "");
      const body = await getJson(url, "nodely");
      const pageBalances = (body.balances ?? []) as Array<Record<string, unknown>>;
      for (const b of pageBalances) {
        balances.push({ address: String(b.address), amount: BigInt(String(b.amount)) });
      }
      next = typeof body["next-token"] === "string" ? body["next-token"] : undefined;
      if (pageBalances.length < PAGE_LIMIT || !next) {
        // Complete sweep: exclude reserve/creator treasuries from circulating math.
        const treasury = new Set([creator, reserve ?? "", ZERO_ADDR]);
        const circulating = balances.filter((b) => !treasury.has(b.address) && b.amount > 0n);
        const circTotal = circulating.reduce((acc, b) => acc + b.amount, 0n);
        if (circulating.length === 0 || circTotal === 0n) {
          return { count: circulating.length, top10: null };
        }
        const top = [...circulating]
          .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
          .slice(0, 10)
          .reduce((acc, b) => acc + b.amount, 0n);
        // bigint ratio at 4 decimal places
        const top10 = Number((top * 10_000n) / circTotal) / 10_000;
        return { count: circulating.length, top10 };
      }
    }
  } catch (err) {
    console.error(`[algorand] holder sweep failed for ${assetId}: ${String(err)}`);
  }
  return { count: null, top10: null };
}

/** Fetch token signals for an Algorand ASA from the Nodely indexer + Vestige. */
export async function fetchAlgorandSignals(asset: string): Promise<TokenSignals | null> {
  if (!/^\d+$/.test(asset)) return null; // ASA ids are numeric
  const assetId = Number(asset);

  let body: Record<string, unknown>;
  try {
    body = await getJson(`${INDEXER}/v2/assets/${assetId}`, "nodely");
  } catch (err) {
    if (err instanceof AdapterError && err.message.includes("not found")) return null;
    throw err;
  }
  const params = ((body.asset ?? {}) as Record<string, unknown>).params as
    | Record<string, unknown>
    | undefined;
  if (!params) return null;

  const flags: string[] = [];
  const positives: string[] = [];
  const addr = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 && v !== ZERO_ADDR ? v : null;

  const creator = String(params.creator ?? "");
  const clawback = addr(params.clawback);
  const freeze = addr(params.freeze);
  const manager = addr(params.manager);
  const reserve = addr(params.reserve);

  // On Algorand the rug surface is the ASA key configuration itself.
  if (clawback) flags.push("clawback_key_set");
  else positives.push("clawback_key_removed");
  if (freeze) flags.push("freeze_key_set");
  else positives.push("freeze_key_removed");
  if (manager) flags.push("manager_key_set");
  else positives.push("manager_key_removed");
  if (params["default-frozen"] === true) flags.push("default_frozen");

  const [vestige, holders] = await Promise.all([
    fetchVestige(assetId),
    fetchHolders(assetId, creator, reserve),
  ]);
  if (vestige && vestige.confidence < 0.5) flags.push("low_price_confidence");

  return {
    asset,
    chain: "algorand",
    name: typeof params.name === "string" ? params.name : null,
    symbol: typeof params["unit-name"] === "string" ? (params["unit-name"] as string) : null,
    liquidity: {
      depth_usd: vestige ? Math.round(vestige.total_lockup) : null,
      lock_status: "unknown", // LP lock conventions vary per Algorand AMM; not derivable here
      lock_expiry: null,
    },
    holders: {
      count: holders.count,
      top_10_concentration: holders.top10,
      insider_overlap: null,
    },
    deployer: { address: creator || null, prior_launches: null, prior_outcomes: [] },
    flags,
    positives,
    source: "nodely+vestige",
  };
}
