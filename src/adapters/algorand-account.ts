import { AdapterError } from "./goplus.js";

const INDEXER = "https://mainnet-idx.algonode.cloud";
const TIMEOUT_MS = 15_000;

export interface AccountHoldings {
  address: string;
  microAlgos: number;
  assets: Array<{ assetId: number; amount: bigint }>;
  createdAtRound: number | null;
}

/**
 * On-chain balances for an account. The chain is the authority on what an
 * address holds — price sources may disagree slightly because some subtract the
 * minimum-balance reserve, so balances always come from here.
 * Returns null when the indexer has no such account.
 */
export async function fetchAccountHoldings(address: string): Promise<AccountHoldings | null> {
  let res: Response;
  try {
    res = await fetch(`${INDEXER}/v2/accounts/${address}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AdapterError(`nodely request failed: ${String(err)}`, "nodely");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AdapterError(`nodely HTTP ${res.status}`, "nodely");

  const body = (await res.json()) as Record<string, unknown>;
  const account = (body.account ?? {}) as Record<string, unknown>;
  if (Object.keys(account).length === 0) return null;

  const assets: AccountHoldings["assets"] = [];
  for (const raw of (account.assets ?? []) as Array<Record<string, unknown>>) {
    const amount = BigInt(String(raw.amount ?? 0));
    // Opted-in but empty positions are noise in a portfolio view.
    if (amount > 0n) assets.push({ assetId: Number(raw["asset-id"]), amount });
  }

  return {
    address,
    microAlgos: Number(account.amount ?? 0),
    assets,
    createdAtRound:
      typeof account["created-at-round"] === "number" ? account["created-at-round"] : null,
  };
}

export interface AccountProfile {
  address: string;
  createdAtRound: number | null;
  /** Present only when the account has been rekeyed to another key. */
  authAddr: string | null;
  status: string | null;
  assetsOptedIn: number | null;
  appsOptedIn: number | null;
  createdAssets: number | null;
  createdApps: number | null;
  microAlgos: number;
  deleted: boolean;
}

/** Account profile fields used for reputation. Null when the account is unknown. */
export async function fetchAccountProfile(address: string): Promise<AccountProfile | null> {
  let res: Response;
  try {
    res = await fetch(`${INDEXER}/v2/accounts/${address}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AdapterError(`nodely request failed: ${String(err)}`, "nodely");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AdapterError(`nodely HTTP ${res.status}`, "nodely");

  const body = (await res.json()) as Record<string, unknown>;
  const account = (body.account ?? {}) as Record<string, unknown>;
  if (Object.keys(account).length === 0) return null;

  const numberOrNull = (value: unknown): number | null =>
    typeof value === "number" ? value : null;

  return {
    address,
    createdAtRound: numberOrNull(account["created-at-round"]),
    authAddr: typeof account["auth-addr"] === "string" ? account["auth-addr"] : null,
    status: typeof account.status === "string" ? account.status : null,
    assetsOptedIn: numberOrNull(account["total-assets-opted-in"]),
    appsOptedIn: numberOrNull(account["total-apps-opted-in"]),
    createdAssets: numberOrNull(account["total-created-assets"]),
    createdApps: numberOrNull(account["total-created-apps"]),
    microAlgos: Number(account.amount ?? 0),
    deleted: account.deleted === true,
  };
}

export interface RecentActivity {
  sampled: number;
  lastActiveAt: number | null;
  distinctCounterparties: number;
  /** True when the sample filled the page, so older activity exists beyond it. */
  truncated: boolean;
}

const ACTIVITY_PAGE = 100;

/** A bounded page of recent transactions, for activity and counterparty spread. */
export async function fetchRecentActivity(address: string): Promise<RecentActivity | null> {
  let res: Response;
  try {
    res = await fetch(`${INDEXER}/v2/transactions?address=${address}&limit=${ACTIVITY_PAGE}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json()) as Record<string, unknown>;
  const rows = (body.transactions ?? []) as Array<Record<string, unknown>>;
  const counterparties = new Set<string>();
  let lastActiveAt: number | null = null;

  for (const row of rows) {
    const roundTime = typeof row["round-time"] === "number" ? row["round-time"] : null;
    if (roundTime !== null) lastActiveAt = Math.max(lastActiveAt ?? 0, roundTime);
    const sender = typeof row.sender === "string" ? row.sender : null;
    if (sender && sender !== address) counterparties.add(sender);
    const pay = (row["payment-transaction"] ?? {}) as Record<string, unknown>;
    const axfer = (row["asset-transfer-transaction"] ?? {}) as Record<string, unknown>;
    for (const receiver of [pay.receiver, axfer.receiver]) {
      if (typeof receiver === "string" && receiver !== address) counterparties.add(receiver);
    }
  }

  return {
    sampled: rows.length,
    lastActiveAt,
    distinctCounterparties: counterparties.size,
    truncated: rows.length === ACTIVITY_PAGE,
  };
}

/** Unix seconds for a round, from its block header. Null when unavailable. */
export async function fetchRoundTime(round: number): Promise<number | null> {
  try {
    const res = await fetch(`${INDEXER}/v2/blocks/${round}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body.timestamp === "number" ? body.timestamp : null;
  } catch {
    return null;
  }
}
