/**
 * Portfolio tracker: values an Algorand address and reports what moved since
 * the last run.
 *
 *   node tracker.mjs PV3QMHIOZ6X7246YBAI66XUALSTT6UCSLJQE4YVQS6TQWG33N4BIBAZANM
 *   node tracker.mjs <address> --watch 60      # re-check every 60 seconds
 *
 * Set ALGORAND_PRIVATE_KEY to a 25-word mnemonic to enable the paid calls.
 */
import { VerdictClient, PaymentNotConfiguredError } from "verdict-sdk";

const address = process.argv[2];
const watchIndex = process.argv.indexOf("--watch");
const intervalSeconds = watchIndex === -1 ? null : Number(process.argv[watchIndex + 1] ?? 60);

if (!address) {
  console.error("Usage: node tracker.mjs <algorand-address> [--watch <seconds>]");
  process.exit(1);
}

const verdict = new VerdictClient({
  privateKey: process.env.ALGORAND_PRIVATE_KEY,
  baseUrl: process.env.VERDICT_URL,
});

const money = (value) =>
  value === null ? "     —" : "$" + value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Previous values per asset, so each run can report the delta. */
const previous = new Map();

async function report() {
  const portfolio = await verdict.portfolio({ address });

  console.log(`\n${new Date().toLocaleTimeString()}  ${address.slice(0, 12)}…`);
  console.log(
    `total ${money(portfolio.total_value_usd)}` +
      `  (${portfolio.priced_holdings} priced, ${portfolio.unpriced_holdings} unpriced)`,
  );
  console.log("-".repeat(72));

  for (const holding of portfolio.holdings) {
    const label = (holding.ticker ?? String(holding.asset_id)).padEnd(10);
    const amount = holding.amount.toLocaleString("en-US", { maximumFractionDigits: 4 }).padStart(18);
    const value = money(holding.value_usd).padStart(12);
    const share =
      holding.allocation === null ? "    —" : (holding.allocation * 100).toFixed(1).padStart(5) + "%";

    let delta = "";
    const before = previous.get(holding.asset_id);
    if (before !== undefined && holding.value_usd !== null) {
      const change = holding.value_usd - before;
      if (Math.abs(change) >= 0.01) {
        delta = `  ${change > 0 ? "+" : ""}${change.toFixed(2)}`;
      }
    }
    if (holding.value_usd !== null) previous.set(holding.asset_id, holding.value_usd);

    console.log(`${label}${amount}${value}  ${share}${delta}`);
  }

  if (portfolio.lp_positions.length > 0) {
    console.log(`\nLP positions: ${portfolio.lp_positions.length}`);
  }
  if (portfolio.realized_flows_30d) {
    const flows = portfolio.realized_flows_30d;
    console.log(
      `\n30-day flows: bought ${money(flows.bought_usd)}, sold ${money(flows.sold_usd)}, ` +
        `net ${money(flows.net_usd)}`,
    );
    console.log(`  ${flows.basis}`);
  }
  for (const note of portfolio.notes) console.log(`  note: ${note}`);
}

try {
  await report();
  if (intervalSeconds !== null) {
    console.log(`\nWatching every ${intervalSeconds}s. Each refresh is a paid call. Ctrl-C to stop.`);
    setInterval(() => {
      report().catch((err) => console.error(`Refresh failed: ${err.message}`));
    }, intervalSeconds * 1000);
  }
} catch (err) {
  if (err instanceof PaymentNotConfiguredError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
