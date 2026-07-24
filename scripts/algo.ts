/**
 * Shared Algorand helpers for the wallet scripts: network config, key parsing,
 * and the USDCa opt-in (a 0-amount self-transfer). Importing this loads .env.
 */
import { existsSync } from "node:fs";
import algosdk from "algosdk";

if (existsSync(".env")) process.loadEnvFile(".env");

export const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
export const ASA_ID = network === "mainnet" ? 31566704 : 10458941;
const ALGOD_URL =
  network === "mainnet"
    ? "https://mainnet-api.algonode.cloud"
    : "https://testnet-api.algonode.cloud";

export const algod = new algosdk.Algodv2("", ALGOD_URL, "");

export interface KeyPair {
  addr: string;
  sk: Uint8Array;
}

/** Accepts a 25-word mnemonic or a base64-encoded 64-byte secret key. */
export function accountFromKey(keyInput: string): KeyPair {
  const trimmed = keyInput.trim();
  if (trimmed.includes(" ")) {
    const { addr, sk } = algosdk.mnemonicToSecretKey(trimmed);
    return { addr: addr.toString(), sk };
  }
  const sk = new Uint8Array(Buffer.from(trimmed, "base64"));
  if (sk.length !== 64) {
    throw new Error(
      "Key must be a 25-word mnemonic or a base64-encoded 64-byte Algorand secret key.",
    );
  }
  return { addr: algosdk.encodeAddress(sk.subarray(32)), sk };
}

/** Opts an account into the USDC ASA. Idempotent; throws if underfunded. */
export async function optInToUsdca(account: KeyPair): Promise<void> {
  const info = await algod.accountInformation(account.addr).do();
  const balance = Number(info.amount) / 1e6;
  console.log(`Account ${account.addr}`);
  console.log(`Network ${network}, ASA ${ASA_ID}, balance ${balance} ALGO`);

  const alreadyOptedIn = (info.assets ?? []).some((a) => Number(a.assetId) === ASA_ID);
  if (alreadyOptedIn) {
    console.log("Already opted in to USDCa — nothing to do.");
    return;
  }
  if (Number(info.amount) < 201_000) {
    throw new Error(
      `Insufficient balance: the opt-in needs ≥0.201 ALGO (min-balance bump + fee). ` +
        `Fund ${account.addr} and re-run.`,
    );
  }

  const params = await algod.getTransactionParams().do();
  const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    assetIndex: ASA_ID,
    suggestedParams: params,
  });
  const signed = optIn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  console.log(`Submitted opt-in: ${txid}`);
  await algosdk.waitForConfirmation(algod, txid, 8);
  console.log(`Confirmed. ${account.addr} can now hold USDCa (ASA ${ASA_ID}).`);
}
