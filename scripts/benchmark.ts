/**
 * Measure real latency per endpoint and print a table for the README.
 *
 *   npm run benchmark                       # against the live deployment
 *   API_URL=http://localhost:3402 npm run benchmark
 *   npm run benchmark -- --runs 10
 *
 * By default this measures the UNPAID path: the request reaches the paywall and
 * returns 402. That isolates our own routing and payment-terms overhead from
 * upstream data time, and it costs nothing to run.
 *
 * With BUYER_PRIVATE_KEY_B64 set and --paid, it measures the full paid path
 * including settlement. Do not run --paid against mainnet with the seller's own
 * buyer wallet: paying yourself is wash trading.
 */
import { existsSync } from "node:fs";
import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402-avm/fetch";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  ExactAvmScheme,
  toClientAvmSigner,
} from "@x402-avm/avm";

if (existsSync(".env")) process.loadEnvFile(".env");

const apiUrl = (process.env.API_URL ?? "https://algoverdict.xyz").replace(/\/$/, "");
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 5;
const paid = args.includes("--paid");

interface Target {
  label: string;
  path: string;
  body: unknown;
}

const TARGETS: Target[] = [
  { label: "GET /", path: "/", body: null },
  { label: "GET /health", path: "/health", body: null },
  { label: "POST /reputation", path: "/reputation", body: { address: "PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM" } },
  { label: "POST /tx/explain", path: "/tx/explain", body: { txid: "FPGSILQHO2KB5VLPV7YF73ZXL4PSCAZFYSSIET7H5LUVOSG2DTTQ" } },
  { label: "POST /discover", path: "/discover", body: { signals: ["trending"], limit: 10 } },
  { label: "POST /portfolio", path: "/portfolio", body: { address: "PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM" } },
  { label: "POST /token/analyze", path: "/token/analyze", body: { asset: "31566704", chain: "algorand" } },
  { label: "POST /contract/analyze", path: "/contract/analyze", body: { app_id: "1002541853" } },
  { label: "POST /smart-money", path: "/smart-money", body: { asset: "31566704", window_days: 1, limit: 5 } },
];

function buildFetch(): typeof fetch {
  if (!paid) return fetch;
  const key = process.env.BUYER_PRIVATE_KEY_B64;
  if (!key) {
    console.error("--paid needs BUYER_PRIVATE_KEY_B64 (base64 secret key or 25-word mnemonic).");
    process.exit(1);
  }
  const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
  const secretKeyB64 = key.trim().includes(" ")
    ? Buffer.from(algosdk.mnemonicToSecretKey(key.trim()).sk).toString("base64")
    : key.trim();
  const signer = toClientAvmSigner(secretKeyB64);
  const caip2 = network === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;
  const algodUrl =
    network === "mainnet"
      ? "https://mainnet-api.algonode.cloud"
      : "https://testnet-api.algonode.cloud";
  const client = new x402Client().register(caip2, new ExactAvmScheme(signer, { algodUrl }));
  return wrapFetchWithPayment(fetch, client);
}

const doFetch = buildFetch();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank: with a handful of runs, interpolation would invent precision.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

async function measure(target: Target): Promise<{
  label: string;
  p50: number;
  p95: number;
  min: number;
  max: number;
  bytes: number;
  statuses: string;
}> {
  const timings: number[] = [];
  const statuses = new Set<number>();
  let bytes = 0;

  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    const res =
      target.body === null
        ? await doFetch(`${apiUrl}${target.path}`)
        : await doFetch(`${apiUrl}${target.path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(target.body),
          });
    const text = await res.text();
    timings.push(performance.now() - started);
    statuses.add(res.status);
    bytes = Math.max(bytes, new TextEncoder().encode(text).length);
  }

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    label: target.label,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    bytes,
    statuses: [...statuses].join("/"),
  };
}

/**
 * Time the analysis layer directly, cold and warm.
 *
 * This is the number that actually describes the product: how long it takes to
 * gather and compute the intelligence. The HTTP modes above cannot show it — an
 * unpaid request stops at the paywall, and a paid one mixes settlement into the
 * measurement. Cold versus warm is reported separately because shared caching is
 * central to how these endpoints are priced.
 */
async function benchmarkAnalysis(): Promise<void> {
  const { db } = await import("../src/cache.js");
  const { analyzeToken } = await import("../src/analysis/token-service.js");
  const { explainTransaction } = await import("../src/analysis/tx-explain.js");
  const { discover } = await import("../src/analysis/discover.js");
  const { analyzePortfolio } = await import("../src/analysis/portfolio.js");
  const { analyzeContract } = await import("../src/analysis/contract.js");
  const { analyzeReputation } = await import("../src/analysis/reputation.js");
  const { analyzeSmartMoney } = await import("../src/analysis/smart-money.js");

  const address = "PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM";
  // `llm` marks capabilities whose cold path includes a model call to write the
  // verdict prose. Clearing the cache forces that call on every cold run, so the
  // figure is data-gathering plus generation — worth separating rather than
  // letting the table imply the data layer is slow.
  const cases: Array<{ label: string; llm?: boolean; run: () => Promise<unknown> }> = [
    { label: "reputation", run: () => analyzeReputation(address) },
    { label: "tx/explain", run: () => explainTransaction("FPGSILQHO2KB5VLPV7YF73ZXL4PSCAZFYSSIET7H5LUVOSG2DTTQ") },
    { label: "token/analyze", llm: true, run: () => analyzeToken("31566704", "algorand") },
    { label: "discover (all)", run: () => discover({ limit: 10 }) },
    { label: "portfolio", run: () => analyzePortfolio(address) },
    { label: "contract/analyze", run: () => analyzeContract(1002541853) },
    { label: "smart-money", run: () => analyzeSmartMoney({ assetId: 31566704, windowDays: 1, limit: 5 }) },
  ];

  console.log("Analysis layer — real data-gathering and compute time\n");
  const rows: Array<{ label: string; cold: number; warm: number; llm: boolean }> = [];
  for (const testCase of cases) {
    // Upstream APIs are noisy enough that one cold sample is not a measurement.
    // Take the median of three so a single slow response cannot set the number.
    const coldSamples: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      db.prepare("DELETE FROM cache").run();
      const started = performance.now();
      await testCase.run();
      coldSamples.push(performance.now() - started);
    }
    const cold = Math.round(coldSamples.sort((a, b) => a - b)[1]);

    const warmStart = performance.now();
    await testCase.run();
    const warm = Math.round(performance.now() - warmStart);

    rows.push({ label: testCase.label, cold, warm, llm: testCase.llm === true });
    console.log(
      `${testCase.label.padEnd(20)} cold ${String(cold).padStart(5)}ms (median of 3)   warm ${String(warm).padStart(4)}ms`,
    );
  }

  console.log("\nMarkdown:\n");
  console.log("| Capability | Cold | Cached |");
  console.log("|---|---|---|");
  for (const row of rows) {
    console.log(
      `| \`${row.label}\`${row.llm ? " *" : ""} | ${row.cold}ms | ${row.warm}ms |`,
    );
  }
  if (rows.some((row) => row.llm)) {
    console.log(
      "\n\\* Cold path includes an LLM call to write the verdict. That prose is cached against a " +
        "hash of the signals, so it is only regenerated when the underlying picture changes — " +
        "clearing the cache forces it on every cold run here.",
    );
  }
  console.log(
    `\nCold is the median of 3 cache-cleared runs on ${new Date().toISOString().slice(0, 10)}; ` +
      "cached is the same call served from SQLite. Upstream APIs dominate the cold figure and it " +
      "varies with their load.",
  );
}

if (args.includes("--analysis")) {
  await benchmarkAnalysis();
  process.exit(0);
}

console.log(`Algo Verdict API benchmark — ${apiUrl}`);
console.log(`${runs} runs per endpoint, ${paid ? "PAID path (includes settlement)" : "unpaid path (402 at the paywall)"}\n`);

const results = [];
for (const target of TARGETS) {
  try {
    const result = await measure(target);
    results.push(result);
    console.log(
      `${result.label.padEnd(24)} p50 ${String(result.p50).padStart(5)}ms  ` +
        `p95 ${String(result.p95).padStart(5)}ms  ` +
        `min ${String(result.min).padStart(5)}ms  max ${String(result.max).padStart(5)}ms  ` +
        `${String(result.bytes).padStart(6)}B  HTTP ${result.statuses}`,
    );
  } catch (err) {
    console.log(`${target.label.padEnd(24)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\nMarkdown:\n");
console.log("| Endpoint | p50 | p95 | Response size |");
console.log("|---|---|---|---|");
for (const result of results) {
  console.log(`| \`${result.label}\` | ${result.p50}ms | ${result.p95}ms | ${(result.bytes / 1024).toFixed(1)} KB |`);
}
console.log(
  `\nMeasured over ${runs} runs per endpoint on ${new Date().toISOString().slice(0, 10)}. ` +
    (paid
      ? "Paid path: includes x402 settlement."
      : "Unpaid path: these are routing and paywall timings, not full analysis timings — " +
        "analysis latency is dominated by upstream data sources and varies with cache state."),
);
