/**
 * A trading agent that vets a token before it buys, and pays for the answer itself.
 *
 *   node agent.mjs 31566704
 *
 * Set ALGORAND_PRIVATE_KEY to a 25-word mnemonic to enable the paid calls. Without
 * it the agent prints how to get a wallet and exits, rather than failing obscurely.
 */
import { VerdictClient, PaymentNotConfiguredError } from "verdict-sdk";

const asset = process.argv[2] ?? "31566704";
const verdict = new VerdictClient({
  privateKey: process.env.ALGORAND_PRIVATE_KEY,
  baseUrl: process.env.VERDICT_URL,
});

/** What this agent refuses to trade, expressed as rules rather than vibes. */
const RULES = {
  maxRugProbability: 0.3,
  minLiquidityUsd: 10_000,
  bannedSignals: ["honeypot", "clawback_key_set"],
};

async function main() {
  console.log(`Vetting asset ${asset} on Algorand`);
  console.log(`Paying from: ${verdict.payerAddress ?? "(no wallet configured)"}\n`);

  const token = await verdict.analyzeToken({ asset, chain: "algorand" });

  console.log(`${token.symbol ?? token.name ?? asset}`);
  console.log(`  rug probability : ${token.rug_probability ?? "unknown"}`);
  console.log(`  risk signals    : ${token.rug_signals.join(", ") || "none"}`);
  console.log(`  positives       : ${token.positive_signals.join(", ") || "none"}`);
  console.log(
    `  liquidity       : ${
      token.liquidity.depth_usd === null
        ? "unknown"
        : "$" + token.liquidity.depth_usd.toLocaleString("en-US")
    }`,
  );
  console.log(`\n  verdict: ${token.verdict}\n`);

  // A null is not a pass. The agent refuses to trade what it could not measure.
  const reasons = [];
  if (token.rug_probability === null) reasons.push("rug probability could not be computed");
  else if (token.rug_probability > RULES.maxRugProbability) {
    reasons.push(`rug probability ${token.rug_probability} exceeds ${RULES.maxRugProbability}`);
  }
  if (token.liquidity.depth_usd === null) reasons.push("liquidity depth unknown");
  else if (token.liquidity.depth_usd < RULES.minLiquidityUsd) {
    reasons.push(`liquidity below $${RULES.minLiquidityUsd.toLocaleString("en-US")}`);
  }
  for (const signal of RULES.bannedSignals) {
    if (token.rug_signals.includes(signal)) reasons.push(`blocked signal: ${signal}`);
  }

  if (reasons.length > 0) {
    console.log("DECISION: do not trade");
    for (const reason of reasons) console.log(`  - ${reason}`);
    return;
  }

  // Only worth spending more when the cheap check passed.
  const who = await verdict.smartMoney({ asset, window_days: 7, limit: 5 });
  console.log("DECISION: passes the risk rules. Who else is trading it:");
  for (const trader of who.traders) {
    console.log(
      `  ${trader.address.slice(0, 12)}…  bought $${(trader.bought_usd ?? 0).toFixed(0)}` +
        `  sold $${(trader.sold_usd ?? 0).toFixed(0)}` +
        `  roi ${trader.round_trip_roi === null ? "n/a" : (trader.round_trip_roi * 100).toFixed(1) + "%"}`,
    );
  }
  console.log(`\n  ${who.methodology[0]}`);
}

try {
  await main();
} catch (err) {
  if (err instanceof PaymentNotConfiguredError) {
    console.error(`\n${err.message}\n`);
    const guide = await new VerdictClient({ baseUrl: process.env.VERDICT_URL }).fundingGuide();
    console.error(`${guide.title}: ${guide.cli.command}`);
    process.exit(1);
  }
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
