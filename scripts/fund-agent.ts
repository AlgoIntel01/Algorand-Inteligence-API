/**
 * Algo Verdict API funding rail — turn "money on an exchange" into a ready-to-pay x402
 * agent wallet on Algorand, in one command:
 *
 *   npm run fund-agent                # human mode
 *   npm run fund-agent -- --json      # machine-readable output for agents
 *   npm run fund-agent -- --dry-run   # stop before submitting the swap
 *
 * Flow: generate a fresh keypair locally → you send it ALGO from anywhere
 * (every major exchange withdraws native ALGO) → CLI opts the account into
 * USDCa → swaps spare ALGO→USDCa via the Vestige aggregator (transactions are
 * verified locally before signing; keys never leave this machine) → prints the
 * ready-to-pay wallet.
 *
 * Free public good: use it for any x402 service on Algorand, not just Algo Verdict API.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import algosdk from "algosdk";
import { ASA_ID, algod, network, optInToUsdca, type KeyPair } from "./algo.js";
import { getQuote, getSwapTransactions, verifySwapGroup } from "./swap.js";

const MICRO = 1_000_000;
/** 0.1 base reserve + 0.1 ASA reserve + fee headroom, kept in ALGO post-swap. */
const KEEP_MICROALGO = 300_000;
const MIN_DEPOSIT_MICROALGO = 1 * MICRO;

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const jsonMode = flag("json");
const dryRun = flag("dry-run");
const slippage = Number(opt("slippage") ?? "0.01");

if (flag("help") || flag("h")) {
  console.log(`
Algo Verdict API funding rail — get an x402-ready agent wallet on Algorand.

  npm run fund-agent [-- <flags>]

Flags:
  --json              machine-readable output (for agents)
  --dry-run           quote and safety-check the swap, then stop before submitting
  --resume <file>     continue with an existing mnemonic file
  --out <file>        where to write the generated mnemonic
  --slippage <n>      swap slippage tolerance (default 0.01 = 1%)
  --help              show this message

Flow: generates a keypair locally -> you send it native ALGO from any exchange ->
opts into USDCa -> swaps spare ALGO to USDCa (transactions verified before signing)
-> prints a wallet ready to pay any x402 service on Algorand. Keys never leave your machine.
`);
  process.exit(0);
}

const log = (...parts: unknown[]) => {
  if (!jsonMode) console.log(...parts);
};

function loadOrCreateAccount(): { account: KeyPair; mnemonic: string; resumed: boolean } {
  const resumePath = opt("resume");
  if (resumePath && existsSync(resumePath)) {
    const mnemonic = readFileSync(resumePath, "utf8").trim();
    const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic);
    return { account: { addr: addr.toString(), sk }, mnemonic, resumed: true };
  }
  const generated = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(generated.sk);
  const account = { addr: generated.addr.toString(), sk: generated.sk };
  const outPath = opt("out") ?? `agent-wallet-${account.addr.slice(0, 8)}.mnemonic`;
  writeFileSync(outPath, mnemonic + "\n", { mode: 0o600 });
  log(`Mnemonic saved to ${outPath} — BACK IT UP; it is the only key to this wallet.`);
  return { account, mnemonic, resumed: false };
}

/** Live ALGO→USDCa rate, so the operator can size the deposit before sending. */
async function quoteRatePerAlgo(): Promise<number | null> {
  try {
    const q = await getQuote(BigInt(MICRO));
    return q.amount_out / MICRO;
  } catch {
    return null;
  }
}

async function waitForDeposit(address: string): Promise<bigint> {
  const rate = await quoteRatePerAlgo();
  log(`\nSend at least ${MIN_DEPOSIT_MICROALGO / MICRO} ALGO to:\n\n  ${address}\n`);
  if (rate !== null) {
    const reserve = KEEP_MICROALGO / MICRO;
    log(`Current rate: 1 ALGO ≈ ${rate.toFixed(4)} USDCa.`);
    log(
      `About ${reserve} ALGO stays behind for on-chain reserves and fees, so a deposit of ` +
        `N ALGO converts to roughly ${rate.toFixed(4)} × (N − ${reserve}) USDCa. ` +
        `Algo Verdict API calls cost $0.01–$0.50, so send enough for the volume you plan.`,
    );
  }
  log("\nWithdraw native ALGO from any major exchange or wallet. Waiting for deposit…");
  for (;;) {
    try {
      const info = await algod.accountInformation(address).do();
      const amount = BigInt(info.amount);
      if (amount >= BigInt(MIN_DEPOSIT_MICROALGO)) return amount;
      if (amount > 0n) {
        log(
          `  received ${Number(amount) / MICRO} ALGO — need ≥ ${MIN_DEPOSIT_MICROALGO / MICRO}, still waiting…`,
        );
      }
    } catch {
      /* account not funded yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

async function main(): Promise<void> {
  if (network !== "mainnet") log("(NETWORK=testnet — running against testnet)");
  const { account, mnemonic, resumed } = loadOrCreateAccount();
  log(resumed ? `Resuming wallet ${account.addr}` : `Generated agent wallet ${account.addr}`);

  const balance = await waitForDeposit(account.addr);
  log(`Deposit received: ${Number(balance) / MICRO} ALGO. Opting into USDCa…`);

  await optInToUsdca(account);

  const info = await algod.accountInformation(account.addr).do();
  const spendable = BigInt(info.amount) - BigInt(KEEP_MICROALGO);
  if (spendable <= 0n) {
    throw new Error(
      `Balance too low to swap after reserves; send more ALGO to ${account.addr} and rerun with --resume.`,
    );
  }

  log(`Quoting swap: ${Number(spendable) / MICRO} ALGO → USDCa via Vestige aggregator…`);
  const quote = await getQuote(spendable);
  log(
    `  quote: ${(quote.amount_out / MICRO).toFixed(6)} USDCa (price impact ${(quote.price_impact * 100).toFixed(2)}%, network fee ${quote.network_fee / MICRO} ALGO)`,
  );

  const unsigned = await getSwapTransactions(quote, account.addr, slippage);
  const decoded = unsigned.map((u) =>
    algosdk.decodeUnsignedTransaction(Buffer.from(u.txn, "base64")),
  );
  const verdict = verifySwapGroup(decoded, account.addr);
  if (!verdict.ok) {
    throw new Error(`REFUSING TO SIGN: ${verdict.reason}. No transactions were submitted.`);
  }
  log(`  received ${decoded.length} transactions; safety checks passed.`);

  if (dryRun) {
    log("\n--dry-run: stopping before signing/submitting. Wallet remains funded with ALGO only.");
    if (jsonMode) {
      console.log(
        JSON.stringify({
          status: "dry_run",
          address: account.addr,
          algo_balance: Number(info.amount) / MICRO,
          quote_usdca_out: quote.amount_out / MICRO,
          txn_count: decoded.length,
        }),
      );
    }
    return;
  }

  // In this flow every transaction is sent by us and needs our signature. If the
  // aggregator ever returns one we can't sign, stop rather than submit a group
  // that will fail on-chain for opaque reasons.
  const signed = unsigned.map((u, i) => {
    if (!u.signers.includes(account.addr)) {
      throw new Error(
        `transaction ${i} expects a signature from ${u.signers.join(", ") || "an unknown signer"}, ` +
          "not this wallet — aborting without submitting.",
      );
    }
    return Buffer.from(decoded[i].signTxn(account.sk));
  });
  const { txid } = await algod.sendRawTransaction(signed).do();
  log(`Submitted swap: ${txid} — waiting for confirmation…`);
  await algosdk.waitForConfirmation(algod, txid, 10);

  const finalInfo = await algod.accountInformation(account.addr).do();
  const usdca = (finalInfo.assets ?? []).find((a) => Number(a.assetId) === ASA_ID);
  const result = {
    status: "ready",
    address: account.addr,
    mnemonic,
    algo_balance: Number(finalInfo.amount) / MICRO,
    usdca_balance: Number(usdca?.amount ?? 0) / MICRO,
    network,
    example_x402_call:
      "https://algorand-inteligence-api-production.up.railway.app/token/analyze",
  };
  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else {
    log("\n✅ Agent wallet is ready to pay x402 services on Algorand:");
    log(`   address: ${result.address}`);
    log(`   ALGO:    ${result.algo_balance}`);
    log(`   USDCa:   ${result.usdca_balance}`);
    log("   Keys stayed local. Fund it more anytime by sending ALGO/USDCa to the address.");
  }
}

main().catch((err) => {
  console.error(jsonMode ? JSON.stringify({ status: "error", message: String(err?.message ?? err) }) : `Error: ${err?.message ?? err}`);
  process.exit(1);
});
