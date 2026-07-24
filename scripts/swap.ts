/**
 * Vestige aggregator swap helpers, kept separate from the CLI so the
 * safety-critical verification is importable and testable on its own.
 */
import algosdk from "algosdk";
import { ASA_ID } from "./algo.js";

const VESTIGE = "https://api.vestigelabs.org";

export interface VestigeQuote {
  amount_out: number;
  price_impact: number;
  network_fee: number;
  [k: string]: unknown;
}

export interface UnsignedSwapTxn {
  txn: string;
  signers: string[];
}

/** Quote ALGO → USDCa for `amountMicro` microALGO. */
export async function getQuote(amountMicro: bigint): Promise<VestigeQuote> {
  const res = await fetch(
    `${VESTIGE}/swap/v4?from_asa=0&to_asa=${ASA_ID}&amount=${amountMicro}&mode=sef`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`Vestige quote failed: HTTP ${res.status}`);
  return (await res.json()) as VestigeQuote;
}

/** Turn a quote into unsigned transactions for `sender` to sign locally. */
export async function getSwapTransactions(
  quote: VestigeQuote,
  sender: string,
  slippage: number,
): Promise<UnsignedSwapTxn[]> {
  const res = await fetch(
    `${VESTIGE}/swap/v4/transactions?sender=${encodeURIComponent(sender)}&slippage=${slippage}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quote),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`Vestige transactions failed: HTTP ${res.status}`);
  const body = (await res.json()) as UnsignedSwapTxn[] | null;
  if (!body || body.length === 0) throw new Error("Vestige returned no transactions");
  return body;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Safety gate: refuse to sign anything that could move funds somewhere
 * unexpected. The aggregator is trusted for routing, never with our keys —
 * every transaction is decoded and checked locally before signing.
 */
export function verifySwapGroup(decoded: algosdk.Transaction[], sender: string): VerifyResult {
  if (decoded.length === 0) return { ok: false, reason: "empty transaction group" };
  if (decoded.length > 16) return { ok: false, reason: "group exceeds Algorand's 16-txn limit" };

  for (const txn of decoded) {
    const t = txn as unknown as {
      type?: string;
      sender?: { toString(): string };
      rekeyTo?: unknown;
      payment?: { closeRemainderTo?: unknown };
      assetTransfer?: { closeRemainderTo?: unknown; assetIndex?: bigint };
      fee?: bigint;
    };
    const from = String(t.sender ?? "");
    const isOurs = from === sender;

    // Rekeying hands control of the account to someone else — never acceptable.
    if (t.rekeyTo) return { ok: false, reason: "transaction attempts a rekey" };
    // close-to drains the entire remaining balance/holding to another address.
    if (t.payment?.closeRemainderTo) return { ok: false, reason: "payment attempts close-to" };
    if (t.assetTransfer?.closeRemainderTo) {
      return { ok: false, reason: "asset transfer attempts close-to" };
    }
    if (isOurs && t.fee !== undefined && t.fee > BigInt(20_000)) {
      return { ok: false, reason: `unreasonable fee on our transaction: ${t.fee} microALGO` };
    }
    const type = String(t.type ?? "");
    if (!["pay", "axfer", "appl"].includes(type)) {
      return { ok: false, reason: `unexpected transaction type: ${type}` };
    }
    // We only ever part with ALGO or USDCa in this flow.
    if (isOurs && type === "axfer" && t.assetTransfer?.assetIndex !== undefined) {
      const asaId = Number(t.assetTransfer.assetIndex);
      if (asaId !== 0 && asaId !== ASA_ID) {
        return { ok: false, reason: `sends unexpected asset ${asaId}` };
      }
    }
  }
  return { ok: true };
}
