import type { Chain } from "../config.js";
import type { WalletHistory, WalletTokenTransfer, WalletTx } from "../types.js";
import { AdapterError } from "./goplus.js";

/**
 * EVM wallet history via Blockscout's Etherscan-compatible API (keyless for
 * ethereum/base). BSC has no public Blockscout instance — supported only when
 * a free ETHERSCAN_API_KEY is configured (Etherscan V2 multichain API).
 */
const PAGE_SIZE = 200;

interface EvmSource {
  base: string; // etherscan-compatible API root incl. any chainid/apikey params
}

function sourceFor(chain: Chain): EvmSource | null {
  const etherscanKey = process.env.ETHERSCAN_API_KEY;
  switch (chain) {
    case "ethereum":
      return { base: "https://eth.blockscout.com/api?" };
    case "base":
      return { base: "https://base.blockscout.com/api?" };
    case "bsc":
      return etherscanKey
        ? { base: `https://api.etherscan.io/v2/api?chainid=56&apikey=${etherscanKey}&` }
        : null;
    default:
      return null;
  }
}

export function evmWalletChainSupported(chain: Chain): boolean {
  return sourceFor(chain) !== null;
}

async function query(src: EvmSource, params: string): Promise<unknown[]> {
  let res: Response;
  const url = `${src.base}${params}`;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new AdapterError(`EVM explorer request failed: ${String(err)}`, "evm-explorer");
  }
  if (!res.ok) throw new AdapterError(`EVM explorer HTTP ${res.status}`, "evm-explorer");
  const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
  if (Array.isArray(body.result)) return body.result;
  // status "0" + "No transactions found" is a valid empty result, not an error
  if (body.status === "0" && /no transactions|no records/i.test(String(body.message ?? ""))) {
    return [];
  }
  throw new AdapterError(`EVM explorer error: ${String(body.message ?? "unknown")}`, "evm-explorer");
}

function toTx(raw: Record<string, unknown>): WalletTx {
  return {
    hash: String(raw.hash ?? ""),
    timestamp: Number(raw.timeStamp ?? 0),
    from: String(raw.from ?? "").toLowerCase(),
    to: raw.to ? String(raw.to).toLowerCase() : null,
    value: String(raw.value ?? "0"),
    isContractCreation: !raw.to && typeof raw.contractAddress === "string" && raw.contractAddress !== "",
  };
}

/** First incoming native transfer to an address (one asc page) — ancestry hops. */
export async function fetchEvmFirstIncoming(
  address: string,
  chain: Chain,
): Promise<{ tx: WalletTx | null; sampledTxs: number }> {
  const src = sourceFor(chain);
  if (!src) return { tx: null, sampledTxs: 0 };
  try {
    const rows = (await query(
      src,
      `module=account&action=txlist&address=${address}&sort=asc&page=1&offset=50`,
    )) as Record<string, unknown>[];
    const txs = rows.map(toTx);
    const incoming = txs.find((t) => t.to === address.toLowerCase() && BigInt(t.value || "0") > 0n);
    return { tx: incoming ?? null, sampledTxs: txs.length };
  } catch {
    return { tx: null, sampledTxs: 0 };
  }
}

/** Outgoing native transfers from `funder` in a time window — for co-funding cluster detection. */
export async function fetchEvmFunderTransfers(
  funder: string,
  chain: Chain,
  aroundTimestamp: number,
  windowSeconds: number,
): Promise<WalletTx[]> {
  const src = sourceFor(chain);
  if (!src) return [];
  try {
    // No timestamp filter in the API — take the funder's earliest pages around the
    // funding era only when the funder is small; for busy funders (CEX) this is
    // meaningless and the caller filters by the window anyway.
    const rows = (await query(
      src,
      `module=account&action=txlist&address=${funder}&sort=asc&page=1&offset=${PAGE_SIZE}`,
    )) as Record<string, unknown>[];
    return rows
      .map(toTx)
      .filter(
        (t) =>
          t.from === funder.toLowerCase() &&
          Math.abs(t.timestamp - aroundTimestamp) <= windowSeconds &&
          BigInt(t.value || "0") > 0n,
      );
  } catch {
    return []; // cluster expansion is enrichment — never fail the call over it
  }
}

export async function fetchEvmWalletHistory(
  address: string,
  chain: Chain,
  deep: boolean,
): Promise<WalletHistory | null> {
  const src = sourceFor(chain);
  if (!src) return null;
  const addr = address.toLowerCase();

  const [firstRows, recentRows] = await Promise.all([
    query(src, `module=account&action=txlist&address=${addr}&sort=asc&page=1&offset=${PAGE_SIZE}`),
    query(src, `module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=${PAGE_SIZE}`),
  ]);
  const firstTxs = (firstRows as Record<string, unknown>[]).map(toTx);
  const recentTxs = (recentRows as Record<string, unknown>[]).map(toTx);
  if (firstTxs.length === 0 && recentTxs.length === 0) {
    // Address may still exist with only internal/token activity; treat as thin history.
    return {
      address: addr,
      chain,
      isContract: false,
      firstTxs: [],
      recentTxs: [],
      tokenTransfers: [],
      txCountSampled: 0,
      truncated: false,
    };
  }

  let tokenTransfers: WalletTokenTransfer[] = [];
  if (deep) {
    try {
      const rows = (await query(
        src,
        `module=account&action=tokentx&address=${addr}&sort=desc&page=1&offset=${PAGE_SIZE}`,
      )) as Record<string, unknown>[];
      tokenTransfers = rows.map((r) => ({
        timestamp: Number(r.timeStamp ?? 0),
        from: String(r.from ?? "").toLowerCase(),
        to: r.to ? String(r.to).toLowerCase() : null,
        token: String(r.contractAddress ?? ""),
      }));
    } catch {
      tokenTransfers = []; // enrichment only
    }
  }

  // Contract check: a wallet whose first "tx" created it, or Blockscout address info.
  let isContract = false;
  try {
    const res = await fetch(
      `${src.base.replace(/\/api\?.*$/, "")}/api/v2/addresses/${addr}`.replace("?&", "?"),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      const info = (await res.json()) as { is_contract?: boolean };
      isContract = info.is_contract === true;
    }
  } catch {
    /* optional enrichment */
  }

  // Distinct hashes across both windows — for small wallets the asc and desc
  // pages overlap; when both pages are full AND disjoint, there is unseen
  // history in the middle.
  const sampled = new Set([...firstTxs, ...recentTxs].map((t) => t.hash)).size;
  const truncated =
    firstTxs.length === PAGE_SIZE &&
    recentTxs.length === PAGE_SIZE &&
    sampled === firstTxs.length + recentTxs.length;

  return {
    address: addr,
    chain,
    isContract,
    firstTxs,
    recentTxs,
    tokenTransfers,
    txCountSampled: sampled,
    truncated,
  };
}
