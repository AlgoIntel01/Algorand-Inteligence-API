/**
 * TestNet qualification check for the Global x402 Challenge.
 *
 * The challenge requires proving the full flow — x402 request → pay → settle →
 * paid response — on Algorand TestNet before it counts on MainNet. This drives
 * that across every paid route and reports the settlement txid for each.
 *
 *   NETWORK=testnet npm run dev            # in one terminal
 *   npm run verify-testnet                 # in another
 *
 * Refuses to run against mainnet. Paying your own endpoint with real USDC would
 * both cost money and, repeated, count as wash trading under the contest rules —
 * this exists precisely so that never has to happen for testing.
 *
 * Note on data: only PAYMENT moves to testnet. The intelligence itself still
 * reads mainnet chain data, because that is where the assets and wallets are.
 * A testnet-settled response containing mainnet analysis is correct, not a bug.
 */
import { existsSync } from "node:fs";
import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402-avm/fetch";
import {
  ALGORAND_TESTNET_CAIP2,
  ExactAvmScheme,
  toClientAvmSigner,
  USDC_TESTNET_ASA_ID,
} from "@x402-avm/avm";

if (existsSync(".env")) process.loadEnvFile(".env");

const ALGOD = "https://testnet-api.algonode.cloud";
const apiUrl = (process.env.API_URL ?? "http://localhost:3402").replace(/\/$/, "");

// Hard gate. The whole point of this script is that it cannot spend real money.
if (process.env.NETWORK !== "testnet") {
  console.error("Refusing to run: NETWORK is not 'testnet'.");
  console.error("Set NETWORK=testnet for both the server and this script, then retry.");
  process.exit(1);
}

const buyerKey = process.env.BUYER_PRIVATE_KEY_B64?.trim();
if (!buyerKey) {
  console.error("BUYER_PRIVATE_KEY_B64 is empty — run `npm run create-buyer` first.");
  process.exit(1);
}

const secretKeyB64 = buyerKey.includes(" ")
  ? Buffer.from(algosdk.mnemonicToSecretKey(buyerKey).sk).toString("base64")
  : buyerKey;
const signer = toClientAvmSigner(secretKeyB64);
const algod = new algosdk.Algodv2("", ALGOD, "");

interface Ready {
  ok: boolean;
  algo: number;
  usdc: number;
  optedIn: boolean;
}

async function readiness(address: string): Promise<Ready> {
  try {
    const info = (await algod.accountInformation(address).do()) as unknown as {
      amount: number | bigint;
      assets?: Array<{ assetId?: number | bigint; "asset-id"?: number; amount: number | bigint }>;
    };
    // The SDK exports asset ids as strings; the indexer returns numbers.
    const usdcId = Number(USDC_TESTNET_ASA_ID);
    const holding = (info.assets ?? []).find(
      (a) => Number(a.assetId ?? a["asset-id"]) === usdcId,
    );
    return {
      ok: true,
      algo: Number(info.amount) / 1e6,
      usdc: holding ? Number(holding.amount) / 1e6 : 0,
      optedIn: holding !== undefined,
    };
  } catch {
    return { ok: false, algo: 0, usdc: 0, optedIn: false };
  }
}

const sellerAddress = process.env.SELLER_ADDRESS ?? "";
const [buyer, seller] = await Promise.all([
  readiness(signer.address),
  readiness(sellerAddress),
]);

console.log("TestNet readiness");
console.log(`  buyer  ${signer.address}`);
console.log(`    ${buyer.algo} ALGO | ${buyer.usdc} USDC | opted in: ${buyer.optedIn}`);
console.log(`  seller ${sellerAddress}`);
console.log(`    ${seller.algo} ALGO | ${seller.usdc} USDC | opted in: ${seller.optedIn}`);
console.log();

const blockers: string[] = [];
if (buyer.algo < 0.2) blockers.push(`buyer needs ~0.3 testnet ALGO (has ${buyer.algo})`);
if (!buyer.optedIn) blockers.push("buyer must opt into testnet USDC: NETWORK=testnet npm run optin-buyer");
if (buyer.usdc < 0.6) blockers.push(`buyer needs ~1 testnet USDC to cover a full pass (has ${buyer.usdc})`);
if (seller.algo < 0.2) blockers.push(`seller needs ~0.3 testnet ALGO (has ${seller.algo})`);
if (!seller.optedIn) {
  blockers.push("seller must opt into testnet USDC to receive: NETWORK=testnet npm run optin-usdca");
}
if (blockers.length > 0) {
  console.error("Not ready:");
  for (const b of blockers) console.error(`  - ${b}`);
  console.error("\nFund testnet ALGO at https://lora.algokit.io/testnet/fund");
  console.error("Fund testnet USDC at https://faucet.circle.com (choose Algorand testnet)");
  process.exit(1);
}

const client = new x402Client().register(
  ALGORAND_TESTNET_CAIP2,
  new ExactAvmScheme(signer, { algodUrl: ALGOD }),
);
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const address = "PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM";

/** An unsigned testnet transaction for /tx/simulate to evaluate. */
async function unsignedTxn(): Promise<string> {
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: signer.address,
    receiver: signer.address,
    amount: 1000,
    suggestedParams: params,
  });
  return Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64");
}

interface Case {
  route: string;
  price: number;
  body: unknown;
}

const cases: Case[] = [
  { route: "/watch/poll", price: 0.01, body: { watch: [{ type: "token", asset: "31566704", chain: "algorand" }] } },
  { route: "/tx/explain", price: 0.02, body: { txid: "FPGSILQHO2KB5VLPV7YF73ZXL4PSCAZFYSSIET7H5LUVOSG2DTTQ" } },
  { route: "/tx/simulate", price: 0.02, body: { txns: [await unsignedTxn()] } },
  { route: "/reputation", price: 0.02, body: { address } },
  { route: "/discover", price: 0.03, body: { signals: ["trending"], limit: 3 } },
  { route: "/portfolio", price: 0.04, body: { address } },
  { route: "/token/analyze", price: 0.05, body: { asset: "31566704", chain: "algorand" } },
  { route: "/contract/analyze", price: 0.05, body: { app_id: "1002541853" } },
  { route: "/wallet/analyze", price: 0.08, body: { address, chain: "algorand" } },
  { route: "/smart-money", price: 0.1, body: { asset: "31566704", window_days: 1, limit: 3 } },
  { route: "/ask", price: 0.12, body: { question: "Is ASA 31566704 safe to trade?" } },
];

console.log(`Paying ${cases.length} routes on TestNet against ${apiUrl}\n`);

const results: Array<{ route: string; status: number; txid: string | null; note: string }> = [];
let spent = 0;

for (const testCase of cases) {
  let status = 0;
  let txid: string | null = null;
  let note = "";
  try {
    const res = await fetchWithPay(`${apiUrl}${testCase.route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testCase.body),
    });
    status = res.status;
    const header = res.headers.get("X-PAYMENT-RESPONSE");
    if (header) {
      try {
        const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
          transaction?: string;
          success?: boolean;
        };
        txid = decoded.transaction ?? null;
        if (decoded.success === false) note = "settle reported failure";
      } catch {
        note = "payment response header not decodable";
      }
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (status === 200) {
      spent += testCase.price;
      if (!note) note = typeof body.status === "string" ? body.status : "ok";
    } else {
      note = String(body.error ?? body.message ?? "").slice(0, 60) || `HTTP ${status}`;
    }
  } catch (err) {
    note = err instanceof Error ? err.message.slice(0, 70) : String(err);
  }
  results.push({ route: testCase.route, status, txid, note });
  console.log(
    `  ${testCase.route.padEnd(19)} HTTP ${String(status).padEnd(4)} ` +
      `${txid ? txid.slice(0, 12) + "…" : "no settle txid".padEnd(15)}  ${note}`,
  );
}

const paid = results.filter((r) => r.status === 200 && r.txid !== null);
const failed = results.filter((r) => r.status !== 200);

console.log(`\nSettled ${paid.length}/${cases.length} routes, ~${spent.toFixed(2)} testnet USDC spent.`);
if (failed.length > 0) {
  console.log("Failed:");
  for (const f of failed) console.log(`  ${f.route}: HTTP ${f.status} — ${f.note}`);
}
const after = await readiness(signer.address);
console.log(`Buyer USDC: ${buyer.usdc} → ${after.usdc}`);

if (paid.length === cases.length) {
  console.log("\nPASS — full x402 flow verified on TestNet across every paid route.");
} else {
  console.log("\nINCOMPLETE — see failures above.");
  process.exit(1);
}
