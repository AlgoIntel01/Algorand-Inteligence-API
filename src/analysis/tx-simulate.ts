import algosdk from "algosdk";
import { AdapterError } from "../adapters/goplus.js";

const ALGOD = "https://mainnet-api.algonode.cloud";
const MICROALGO = 1_000_000;

export interface SimulatedTxn {
  index: number;
  type: string;
  sender: string;
  /** Populated only for the transaction that failed. */
  failure: string | null;
  budget_consumed: number | null;
}

export interface TxSimulateResponse {
  status: "ok";
  chain: "algorand";
  /** Whether the group would commit if submitted now. */
  would_succeed: boolean;
  /** The failure in a few words. Null when the group would succeed. */
  failure_summary: string | null;
  /** Algod's complete evaluation error, including the account dump it appends. */
  failure_reason: string | null;
  /** Index within the group of the transaction that failed. */
  failed_at: number | null;
  group_size: number;
  transactions: SimulatedTxn[];
  fees: { total_algo: number };
  simulated_against_round: number | null;
  note: string;
}

export class SimulateInputError extends Error {}

/**
 * Algod states the reason first and then appends the offending account's entire
 * state — useful to keep, unreadable to lead with. This lifts the reason out;
 * the untouched original stays in failure_reason.
 */
function summarizeFailure(message: string): string | null {
  if (message.length === 0) return null;
  const withoutPrefix = message.replace(/^transaction(Group)?:?\s*[A-Z2-7]*:?\s*/i, "");
  const beforeDump = withoutPrefix.split(/\s*\(account\s/)[0].trim();
  const summary = beforeDump.length > 0 ? beforeDump : withoutPrefix.trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
}

/**
 * Decode one caller-supplied transaction into the SignedTransaction shape the
 * simulate endpoint expects. Accepts either an unsigned transaction (the normal
 * case for a pre-flight check) or an already-signed blob, because an agent
 * checking a transaction it is about to submit may have signed it already.
 */
function decodeToSigned(base64: string, index: number): algosdk.SignedTransaction {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    throw new SimulateInputError(`txns[${index}] is not valid base64`);
  }
  if (bytes.length === 0) throw new SimulateInputError(`txns[${index}] is empty`);

  try {
    return algosdk.decodeSignedTransaction(bytes);
  } catch {
    // Not a signed blob — the expected path for a pre-flight check.
  }
  try {
    const unsigned = algosdk.decodeUnsignedTransaction(bytes);
    return algosdk.decodeSignedTransaction(algosdk.encodeUnsignedSimulateTransaction(unsigned));
  } catch (err) {
    throw new SimulateInputError(
      `txns[${index}] is neither a signed nor an unsigned Algorand transaction (${String(err)})`,
    );
  }
}

/**
 * Ask algod what would happen if this group were submitted right now.
 *
 * This is the only honest answer to "why did my transaction fail": a failed
 * transaction is never written to the Algorand ledger, so there is nothing to
 * look up afterwards. Simulation runs the group against current chain state
 * without submitting it, and returns the same evaluation error the network
 * would have produced.
 */
export async function simulateTransactions(txnsBase64: string[]): Promise<TxSimulateResponse> {
  if (txnsBase64.length === 0) throw new SimulateInputError('"txns" must contain at least one transaction');
  if (txnsBase64.length > 16) {
    throw new SimulateInputError("An Algorand atomic group holds at most 16 transactions");
  }

  const signed = txnsBase64.map(decodeToSigned);
  const request = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [new algosdk.modelsv2.SimulateRequestTransactionGroup({ txns: signed })],
    // Unsigned transactions are the point of a pre-flight check; without this
    // algod rejects the group for missing signatures before evaluating it.
    allowEmptySignatures: true,
  });

  const client = new algosdk.Algodv2("", ALGOD, "");
  let response: algosdk.modelsv2.SimulateResponse;
  try {
    response = await client.simulateTransactions(request).do();
  } catch (err) {
    throw new AdapterError(`algod simulate failed: ${String(err)}`, "algod");
  }

  const group = response.txnGroups[0];
  const failureMessage = group?.failureMessage ?? "";
  const wouldSucceed = failureMessage.length === 0;
  const failedAt = group?.failedAt?.[0];

  const transactions: SimulatedTxn[] = signed.map((entry, index) => ({
    index,
    type: String(entry.txn.type),
    sender: entry.txn.sender.toString(),
    failure: !wouldSucceed && failedAt === index ? failureMessage : null,
    budget_consumed: group?.txnResults[index]?.appBudgetConsumed ?? null,
  }));

  const totalFee = signed.reduce((sum, entry) => sum + Number(entry.txn.fee ?? 0), 0);

  return {
    status: "ok",
    chain: "algorand",
    would_succeed: wouldSucceed,
    failure_summary: wouldSucceed ? null : summarizeFailure(failureMessage),
    failure_reason: wouldSucceed ? null : failureMessage,
    failed_at: !wouldSucceed && failedAt !== undefined ? failedAt : null,
    group_size: signed.length,
    transactions,
    fees: { total_algo: totalFee / MICROALGO },
    simulated_against_round: response.lastRound !== undefined ? Number(response.lastRound) : null,
    note:
      "Simulated against current chain state without submitting. A transaction that already " +
      "failed cannot be analysed after the fact — failed transactions are never written to the " +
      "Algorand ledger — so this runs the same evaluation ahead of submission instead.",
  };
}
