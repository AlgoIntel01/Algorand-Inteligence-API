import type { WalletHistory, WalletTokenTransfer, WalletTx } from "../types.js";
import { AdapterError } from "./goplus.js";

const INDEXER = "https://mainnet-idx.algonode.cloud";
const PAGE_SIZE = 500;
/** Rounds ≈ 2.9s each; ~25k rounds ≈ one day around account creation. */
const EARLY_WINDOW_ROUNDS = 25_000;

async function getJson(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new AdapterError(`nodely request failed: ${String(err)}`, "nodely");
  }
  if (res.status === 404) throw new AdapterError("account not found on nodely", "nodely");
  if (!res.ok) throw new AdapterError(`nodely HTTP ${res.status}`, "nodely");
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Normalize one indexer transaction into WalletTx. Payment amount for pay txns;
 * axfer txns normalize into token transfers separately.
 */
function toTx(raw: Record<string, unknown>): WalletTx {
  const pay = (raw["payment-transaction"] ?? {}) as Record<string, unknown>;
  return {
    hash: String(raw.id ?? ""),
    timestamp: Number(raw["round-time"] ?? 0),
    from: String(raw.sender ?? ""),
    to: typeof pay.receiver === "string" ? pay.receiver : null,
    value: String(pay.amount ?? "0"),
  };
}

function toTokenTransfer(raw: Record<string, unknown>): WalletTokenTransfer | null {
  const axfer = raw["asset-transfer-transaction"] as Record<string, unknown> | undefined;
  if (!axfer) return null;
  return {
    timestamp: Number(raw["round-time"] ?? 0),
    from: String(raw.sender ?? ""),
    to: typeof axfer.receiver === "string" ? axfer.receiver : null,
    token: String(axfer["asset-id"] ?? ""),
  };
}

async function fetchTxPage(params: string): Promise<Record<string, unknown>[]> {
  const body = await getJson(`${INDEXER}/v2/transactions?limit=${PAGE_SIZE}&${params}`);
  return (body.transactions ?? []) as Record<string, unknown>[];
}

/** All transactions touching an address since a unix time (for /watch/poll). */
export async function fetchAlgorandTxsSince(
  address: string,
  sinceSec: number,
): Promise<WalletTx[]> {
  const after = new Date(sinceSec * 1000).toISOString();
  const rows = await fetchTxPage(
    `address=${address}&after-time=${encodeURIComponent(after)}`,
  );
  return rows.map(toTx);
}

/** First incoming payment to an address — ancestry hops. */
export async function fetchAlgorandFirstIncoming(
  address: string,
): Promise<{ tx: WalletTx | null; sampledTxs: number }> {
  try {
    const body = await getJson(`${INDEXER}/v2/accounts/${address}`);
    const account = (body.account ?? {}) as Record<string, unknown>;
    const createdRound = Number(account["created-at-round"] ?? 0);
    const rows = await fetchTxPage(
      `address=${address}&address-role=receiver&tx-type=pay&min-round=${createdRound}&max-round=${createdRound + EARLY_WINDOW_ROUNDS}`,
    );
    const txs = rows.map(toTx).reverse(); // window pages newest-first → ascending
    const incoming = txs.find((t) => t.to === address && BigInt(t.value || "0") > 0n);
    return { tx: incoming ?? null, sampledTxs: txs.length };
  } catch {
    return { tx: null, sampledTxs: 0 };
  }
}

/** Outgoing payments from `funder` in a round/time window — co-funding cluster detection. */
export async function fetchAlgorandFunderTransfers(
  funder: string,
  aroundTimestamp: number,
  windowSeconds: number,
): Promise<WalletTx[]> {
  try {
    const after = new Date((aroundTimestamp - windowSeconds) * 1000).toISOString();
    const before = new Date((aroundTimestamp + windowSeconds) * 1000).toISOString();
    const rows = await fetchTxPage(
      `address=${funder}&address-role=sender&tx-type=pay&after-time=${encodeURIComponent(after)}&before-time=${encodeURIComponent(before)}`,
    );
    return rows.map(toTx).filter((t) => BigInt(t.value || "0") > 0n);
  } catch {
    return []; // enrichment only
  }
}

export async function fetchAlgorandWalletHistory(
  address: string,
  deep: boolean,
): Promise<WalletHistory | null> {
  let account: Record<string, unknown>;
  try {
    const body = await getJson(`${INDEXER}/v2/accounts/${address}`);
    account = (body.account ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AdapterError && err.message.includes("not found")) return null;
    throw err;
  }
  const createdRound = Number(account["created-at-round"] ?? 0);

  // Earliest txs: bounded round window starting at account creation (indexer
  // pages newest-first and has no ascending sort, so we window instead).
  // Recent txs: plain newest-first page.
  const [earlyRows, recentRows] = await Promise.all([
    fetchTxPage(
      `address=${address}&min-round=${createdRound}&max-round=${createdRound + EARLY_WINDOW_ROUNDS}`,
    ),
    fetchTxPage(`address=${address}`),
  ]);

  // The early window is newest-first within itself — reverse to ascending.
  const firstTxs = earlyRows
    .filter((r) => r["tx-type"] === "pay")
    .map(toTx)
    .reverse();
  const recentAll = recentRows;
  const recentTxs = recentAll.filter((r) => r["tx-type"] === "pay").map(toTx);

  const tokenTransfers: WalletTokenTransfer[] = deep
    ? (recentAll.map(toTokenTransfer).filter(Boolean) as WalletTokenTransfer[])
    : [];

  const sampled = new Set(
    [...earlyRows, ...recentAll].map((r) => String(r.id)),
  ).size;
  const truncated = recentAll.length === PAGE_SIZE || earlyRows.length === PAGE_SIZE;

  return {
    address,
    chain: "algorand",
    // sig-type "lsig"/"msig" are still accounts; Algorand "contracts" are apps —
    // an indexer account with created apps is closest, but plain false is honest here.
    isContract: false,
    firstTxs,
    recentTxs,
    tokenTransfers,
    txCountSampled: sampled,
    truncated,
  };
}
