/**
 * End-to-end paid call against the API using the x402 fetch client.
 *
 * Needs a funded buyer wallet (USDCa; no ALGO needed thanks to fee abstraction):
 *   BUYER_PRIVATE_KEY_B64 — base64 of the 64-byte Algorand secret key, or a 25-word mnemonic
 *   API_URL               — defaults to http://localhost:3402
 */
import { existsSync } from "node:fs";
import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402-avm/fetch";
import { ExactAvmScheme, toClientAvmSigner, ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from "@x402-avm/avm";

if (existsSync(".env")) process.loadEnvFile(".env");

const apiUrl = process.env.API_URL ?? "http://localhost:3402";
const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const caip2 = network === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;

const keyInput = process.env.BUYER_PRIVATE_KEY_B64;
if (!keyInput) {
  console.error("BUYER_PRIVATE_KEY_B64 is not set. Provide a base64 secret key or 25-word mnemonic.");
  process.exit(1);
}
const privateKeyB64 = keyInput.trim().includes(" ")
  ? Buffer.from(algosdk.mnemonicToSecretKey(keyInput.trim()).sk).toString("base64")
  : keyInput.trim();

const signer = toClientAvmSigner(privateKeyB64);
console.log(`Buyer address: ${signer.address}`);

const client = new x402Client().register(caip2, new ExactAvmScheme(signer));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

console.log(`\nPOST ${apiUrl}/watch/poll ($0.01) ...`);
const res = await fetchWithPay(`${apiUrl}/watch/poll`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    watch: [{ type: "token", asset: "31566704", chain: "algorand" }],
  }),
});

console.log(`HTTP ${res.status}`);
const paymentResponse = res.headers.get("X-PAYMENT-RESPONSE");
if (paymentResponse) {
  console.log(`X-PAYMENT-RESPONSE: ${Buffer.from(paymentResponse, "base64").toString("utf8")}`);
}
console.log(JSON.stringify(await res.json(), null, 2));
