import type { Chain } from "../config.js";
import type { TokenSignals } from "../types.js";

const EVM_CHAIN_IDS: Partial<Record<Chain, string>> = {
  ethereum: "1",
  base: "8453",
  bsc: "56",
};

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly upstream: string,
  ) {
    super(message);
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new AdapterError(`GoPlus request failed: ${String(err)}`, "goplus");
  }
  if (!res.ok) {
    throw new AdapterError(`GoPlus returned HTTP ${res.status}`, "goplus");
  }
  return (await res.json()) as Record<string, unknown>;
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const flag = (v: unknown): boolean => v === "1" || v === 1;

/** Sum of the top-10 holder `percent` fields (GoPlus reports fractions of 1). */
function topTenConcentration(holders: unknown): number | null {
  if (!Array.isArray(holders) || holders.length === 0) return null;
  const sum = holders
    .slice(0, 10)
    .reduce((acc: number, h) => acc + (num((h as Record<string, unknown>).percent) ?? 0), 0);
  return Math.min(1, Math.round(sum * 10_000) / 10_000);
}

function evmSignals(asset: string, chain: Chain, t: Record<string, unknown>): TokenSignals {
  const flags: string[] = [];
  const positives: string[] = [];

  if (flag(t.is_honeypot)) flags.push("honeypot");
  if (flag(t.is_mintable)) flags.push("mintable");
  if (flag(t.owner_change_balance)) flags.push("owner_can_change_balance");
  if (flag(t.hidden_owner)) flags.push("hidden_owner");
  if (flag(t.selfdestruct)) flags.push("selfdestruct_present");
  if (flag(t.can_take_back_ownership)) flags.push("ownership_reclaimable");
  if (flag(t.transfer_pausable)) flags.push("transfers_pausable");
  if (flag(t.is_blacklisted)) flags.push("blacklist_function");
  if (flag(t.cannot_sell_all)) flags.push("cannot_sell_all");
  if (flag(t.is_proxy)) flags.push("proxy_contract");
  const buyTax = num(t.buy_tax);
  const sellTax = num(t.sell_tax);
  if (buyTax !== null && buyTax > 0.05) flags.push(`buy_tax_${Math.round(buyTax * 100)}pct`);
  if (sellTax !== null && sellTax > 0.05) flags.push(`sell_tax_${Math.round(sellTax * 100)}pct`);

  if (flag(t.is_open_source)) positives.push("open_source");
  else flags.push("closed_source");
  const owner = typeof t.owner_address === "string" ? t.owner_address : null;
  if (owner === "" || owner === "0x0000000000000000000000000000000000000000") {
    positives.push("ownership_renounced");
  }

  // Liquidity: sum tracked DEX pools; LP lock from lp_holders.
  const dex = Array.isArray(t.dex) ? (t.dex as Record<string, unknown>[]) : [];
  const depth = dex.reduce((acc, d) => acc + (num(d.liquidity) ?? num(d.tvl) ?? 0), 0);
  const lpHolders = Array.isArray(t.lp_holders) ? (t.lp_holders as Record<string, unknown>[]) : [];
  const lockedPct = lpHolders.reduce(
    (acc, h) => acc + (flag(h.is_locked) ? (num(h.percent) ?? 0) : 0),
    0,
  );
  let lockStatus: TokenSignals["liquidity"]["lock_status"] = "unknown";
  if (lpHolders.length > 0) {
    lockStatus = lockedPct >= 0.5 ? "locked" : "unlocked";
    if (lockStatus === "locked") positives.push("lp_locked");
    else flags.push("lp_unlocked");
  }

  return {
    asset,
    chain,
    name: typeof t.token_name === "string" ? t.token_name : null,
    symbol: typeof t.token_symbol === "string" ? t.token_symbol : null,
    liquidity: {
      depth_usd: dex.length > 0 ? Math.round(depth) : null,
      lock_status: lockStatus,
      lock_expiry: null,
    },
    holders: {
      count: num(t.holder_count),
      top_10_concentration: topTenConcentration(t.holders),
      insider_overlap: null,
    },
    deployer: {
      address: typeof t.creator_address === "string" ? t.creator_address : null,
      prior_launches: null,
      prior_outcomes: [],
    },
    flags,
    positives,
    source: "goplus",
  };
}

function solanaSignals(asset: string, chain: Chain, t: Record<string, unknown>): TokenSignals {
  const flags: string[] = [];
  const positives: string[] = [];
  const status = (v: unknown): boolean =>
    typeof v === "object" && v !== null && flag((v as Record<string, unknown>).status);

  if (status(t.mintable)) flags.push("mint_authority_set");
  if (status(t.freezable)) flags.push("freeze_authority_set");
  if (status(t.closable)) flags.push("closable");
  if (status(t.balance_mutable_authority)) flags.push("balance_mutable");
  if (status(t.transfer_hook)) flags.push("transfer_hook");
  if (status(t.non_transferable)) flags.push("non_transferable");
  if (status(t.metadata_mutable)) flags.push("metadata_mutable");
  if (flag(t.trusted_token)) positives.push("trusted_token_list");
  if (!status(t.mintable)) positives.push("mint_authority_revoked");
  if (!status(t.freezable)) positives.push("freeze_authority_revoked");

  const dex = Array.isArray(t.dex) ? (t.dex as Record<string, unknown>[]) : [];
  const depth = dex.reduce((acc, d) => acc + (num(d.tvl) ?? 0), 0);
  const lpHolders = Array.isArray(t.lp_holders) ? (t.lp_holders as Record<string, unknown>[]) : [];
  const lockedPct = lpHolders.reduce(
    (acc, h) => acc + (flag(h.is_locked) ? (num(h.percent) ?? 0) : 0),
    0,
  );
  let lockStatus: TokenSignals["liquidity"]["lock_status"] = "unknown";
  if (lpHolders.length > 0) {
    lockStatus = lockedPct >= 0.5 ? "locked" : "unlocked";
    if (lockStatus === "locked") positives.push("lp_locked");
    else flags.push("lp_unlocked");
  }

  const creators = Array.isArray(t.creators) ? (t.creators as Record<string, unknown>[]) : [];
  const metadata = (t.metadata ?? {}) as Record<string, unknown>;

  return {
    asset,
    chain,
    name: typeof metadata.name === "string" ? metadata.name : null,
    symbol: typeof metadata.symbol === "string" ? metadata.symbol : null,
    liquidity: {
      depth_usd: dex.length > 0 ? Math.round(depth) : null,
      lock_status: lockStatus,
      lock_expiry: null,
    },
    holders: {
      count: num(t.holder_count),
      top_10_concentration: topTenConcentration(t.holders),
      insider_overlap: null,
    },
    deployer: {
      address: typeof creators[0]?.address === "string" ? (creators[0].address as string) : null,
      prior_launches: null,
      prior_outcomes: [],
    },
    flags,
    positives,
    source: "goplus",
  };
}

/** Fetch token security signals from GoPlus for EVM chains and Solana. */
export async function fetchGoPlusSignals(asset: string, chain: Chain): Promise<TokenSignals | null> {
  const url =
    chain === "solana"
      ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(asset)}`
      : `https://api.gopluslabs.io/api/v1/token_security/${EVM_CHAIN_IDS[chain]}?contract_addresses=${encodeURIComponent(asset)}`;

  const body = await fetchJson(url);
  if (Number(body.code) !== 1) {
    throw new AdapterError(`GoPlus error: ${String(body.message ?? body.code)}`, "goplus");
  }
  const result = (body.result ?? {}) as Record<string, Record<string, unknown>>;
  const entry = result[asset] ?? result[asset.toLowerCase()];
  if (!entry || Object.keys(entry).length === 0) return null; // token unknown to GoPlus

  return chain === "solana" ? solanaSignals(asset, chain, entry) : evmSignals(asset, chain, entry);
}
