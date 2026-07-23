/**
 * Opts the seller account into the USDC ASA (a 0-amount asset transfer to self).
 * Requires the account to hold ~0.3 ALGO first. Reads SELLER_MNEMONIC from .env.
 */
import { existsSync } from "node:fs";
import algosdk from "algosdk";

if (existsSync(".env")) process.loadEnvFile(".env");

const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const ASA_ID = network === "mainnet" ? 31566704 : 10458941;
const ALGOD_URL =
  network === "mainnet"
    ? "https://mainnet-api.algonode.cloud"
    : "https://testnet-api.algonode.cloud";

const mnemonic = process.env.SELLER_MNEMONIC;
if (!mnemonic) {
  console.error("SELLER_MNEMONIC is not set in .env — run `npm run create-wallet` first.");
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(mnemonic);
const address = account.addr.toString();
const algod = new algosdk.Algodv2("", ALGOD_URL, "");

console.log(`Network: ${network}, ASA: ${ASA_ID}, account: ${address}`);

const info = await algod.accountInformation(address).do();
const balance = Number(info.amount) / 1e6;
console.log(`Balance: ${balance} ALGO`);

const alreadyOptedIn = (info.assets ?? []).some((a) => Number(a.assetId) === ASA_ID);
if (alreadyOptedIn) {
  console.log("Account is already opted in to the USDC ASA — nothing to do.");
  process.exit(0);
}
if (Number(info.amount) < 201_000) {
  console.error(
    `Insufficient balance: opt-in needs ≥0.201 ALGO (0.1 min balance + 0.1 ASA min balance + fee). ` +
      `Fund ${address} and re-run.`,
  );
  process.exit(1);
}

const params = await algod.getTransactionParams().do();
const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: address,
  receiver: address,
  amount: 0,
  assetIndex: ASA_ID,
  suggestedParams: params,
});

const signed = optIn.signTxn(account.sk);
const { txid } = await algod.sendRawTransaction(signed).do();
console.log(`Submitted opt-in transaction: ${txid}`);
await algosdk.waitForConfirmation(algod, txid, 8);
console.log(`Confirmed. ${address} can now receive USDCa (ASA ${ASA_ID}).`);
