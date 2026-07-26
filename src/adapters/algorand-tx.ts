import { AdapterError } from "./goplus.js";

const INDEXER = "https://mainnet-idx.algonode.cloud";
const TIMEOUT_MS = 15_000;

/**
 * One indexer transaction. Only the fields we actually read are typed; the
 * indexer returns a great deal more. `inner-txns` nests recursively — an app
 * call can spawn inner calls that spawn their own.
 */
export interface RawTxn {
  id?: string;
  "tx-type"?: string;
  sender?: string;
  fee?: number;
  group?: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  "rekey-to"?: string;
  "inner-txns"?: RawTxn[];
  "payment-transaction"?: {
    receiver?: string;
    amount?: number;
    "close-remainder-to"?: string;
    "close-amount"?: number;
  };
  "asset-transfer-transaction"?: {
    receiver?: string;
    amount?: number;
    "asset-id"?: number;
    "close-to"?: string;
    "close-amount"?: number;
  };
  "application-transaction"?: {
    "application-id"?: number;
    "on-completion"?: string;
    "application-args"?: string[];
  };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AdapterError(`nodely request failed: ${String(err)}`, "nodely");
  }
  if (res.status === 404) throw new AdapterError("not found on nodely", "nodely");
  if (!res.ok) throw new AdapterError(`nodely HTTP ${res.status}`, "nodely");
  return (await res.json()) as Record<string, unknown>;
}

/** One transaction by id. Returns null when the indexer has never seen it. */
export async function fetchTransaction(txid: string): Promise<RawTxn | null> {
  try {
    const body = await getJson(`${INDEXER}/v2/transactions/${encodeURIComponent(txid)}`);
    return (body.transaction ?? null) as RawTxn | null;
  } catch (err) {
    if (err instanceof AdapterError && err.message.includes("not found")) return null;
    throw err;
  }
}

/**
 * Every transaction in an atomic group. The group-id query needs a round window
 * to stay cheap, and a group is by definition confined to a single round.
 */
export async function fetchGroupTransactions(groupId: string, round: number): Promise<RawTxn[]> {
  const url =
    `${INDEXER}/v2/transactions?group-id=${encodeURIComponent(groupId)}` +
    `&min-round=${round}&max-round=${round}&limit=100`;
  const body = await getJson(url);
  return (body.transactions ?? []) as RawTxn[];
}

export interface AssetParams {
  name: string | null;
  unitName: string | null;
  decimals: number;
}

/**
 * Asset metadata straight from the chain. Used as the fallback for assets
 * Vestige doesn't track — without decimals we cannot render an amount, and
 * rendering base units as if they were whole tokens would be a lie.
 */
export async function fetchAssetParams(assetId: number): Promise<AssetParams | null> {
  if (assetId === 0) return { name: "Algorand", unitName: "ALGO", decimals: 6 };
  try {
    const body = await getJson(`${INDEXER}/v2/assets/${assetId}`);
    const params = ((body.asset ?? {}) as Record<string, unknown>).params as
      | Record<string, unknown>
      | undefined;
    if (!params) return null;
    return {
      name: typeof params.name === "string" ? params.name : null,
      unitName: typeof params["unit-name"] === "string" ? (params["unit-name"] as string) : null,
      decimals: Number(params.decimals ?? 0),
    };
  } catch {
    return null;
  }
}
