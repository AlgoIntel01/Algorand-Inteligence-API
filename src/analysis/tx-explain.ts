import type { TxExplainResponse, TxFlow } from "../types.js";
import { getCached, setCached } from "../cache.js";
import {
  fetchAssetParams,
  fetchGroupTransactions,
  fetchTransaction,
  type RawTxn,
} from "../adapters/algorand-tx.js";
import {
  fetchAssets,
  priceAt,
  type HistoricPrice,
  type VestigeAsset,
} from "../adapters/vestige.js";
import { lookupApp } from "../data/known-apps.js";

/**
 * A committed Algorand transaction can never change, so an explanation of one is
 * valid forever. This is the cheapest endpoint we serve: the second caller for a
 * given txid costs nothing upstream.
 */
const EXPLAIN_TTL_SECONDS = 365 * 24 * 60 * 60;

const ALGO = 0;
const MICROALGO = 1_000_000;
/** Anything above this suggests a large fee pool for inner transactions. */
const HIGH_FEE_MICROALGO = 100_000;
/**
 * Below this, Vestige's price is too uncertain to benchmark an executed rate
 * against. Matches the confidence floor token analysis already uses for its
 * low_price_confidence flag.
 */
const MIN_RATE_CONFIDENCE = 0.5;

const CHECKS_RUN = [
  "rekey_to_present",
  "close_remainder_present",
  "asset_close_out_present",
  "unusually_high_fee",
  "unattributed_application",
];

interface Flow {
  from: string;
  to: string;
  assetId: number;
  amount: bigint;
}

/**
 * Collect every value movement in a transaction and everything it spawned.
 * Inner transactions nest arbitrarily deep, and a swap's real economics live
 * entirely inside them — an app call by itself moves nothing.
 */
function collectFlows(txn: RawTxn, flows: Flow[], apps: Set<number>, flags: Set<string>): void {
  if (typeof txn["rekey-to"] === "string" && txn["rekey-to"].length > 0) {
    flags.add("rekey_to_present");
  }

  const sender = txn.sender ?? "";
  const pay = txn["payment-transaction"];
  if (pay) {
    const amount = BigInt(pay.amount ?? 0);
    if (amount > 0n && pay.receiver) {
      flows.push({ from: sender, to: pay.receiver, assetId: ALGO, amount });
    }
    const closeAmount = BigInt(pay["close-amount"] ?? 0);
    if (closeAmount > 0n && pay["close-remainder-to"]) {
      flows.push({ from: sender, to: pay["close-remainder-to"], assetId: ALGO, amount: closeAmount });
      flags.add("close_remainder_present");
    }
  }

  const axfer = txn["asset-transfer-transaction"];
  if (axfer) {
    const assetId = Number(axfer["asset-id"] ?? 0);
    const amount = BigInt(axfer.amount ?? 0);
    if (amount > 0n && axfer.receiver) {
      flows.push({ from: sender, to: axfer.receiver, assetId, amount });
    }
    const closeAmount = BigInt(axfer["close-amount"] ?? 0);
    if (closeAmount > 0n && axfer["close-to"]) {
      flows.push({ from: sender, to: axfer["close-to"], assetId, amount: closeAmount });
      flags.add("asset_close_out_present");
    }
  }

  const appl = txn["application-transaction"];
  if (appl && typeof appl["application-id"] === "number" && appl["application-id"] > 0) {
    apps.add(appl["application-id"]);
  }

  for (const inner of txn["inner-txns"] ?? []) {
    collectFlows(inner, flows, apps, flags);
  }
}

/** Signed net movement per asset for one account. Fees are excluded — they are reported separately. */
function netFor(address: string, flows: Flow[]): Map<number, bigint> {
  const net = new Map<number, bigint>();
  for (const flow of flows) {
    if (flow.from === address) net.set(flow.assetId, (net.get(flow.assetId) ?? 0n) - flow.amount);
    if (flow.to === address) net.set(flow.assetId, (net.get(flow.assetId) ?? 0n) + flow.amount);
  }
  for (const [assetId, amount] of net) {
    if (amount === 0n) net.delete(assetId);
  }
  return net;
}

/** Base units → whole units as an exact decimal string. Never rounds through a float. */
function formatUnits(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const sign = negative ? "-" : "";
  if (decimals === 0 || frac === 0n) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fracStr}`;
}

/** Same value as a float, for arithmetic where exactness no longer matters. */
function toNumber(base: bigint, decimals: number): number {
  return Number(formatUnits(base, decimals));
}

function humanAmount(value: string): string {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return value;
  const abs = Math.abs(asNumber);
  const maximumFractionDigits = abs >= 1 ? 4 : 8;
  return asNumber.toLocaleString("en-US", { maximumFractionDigits });
}

export async function explainTransaction(txid: string): Promise<TxExplainResponse | null> {
  const cacheKey = `tx:explain:algorand:${txid}`;
  const cached = getCached<TxExplainResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const txn = await fetchTransaction(txid);
  if (txn === null) return null;

  const round = typeof txn["confirmed-round"] === "number" ? txn["confirmed-round"] : null;
  const roundTime = typeof txn["round-time"] === "number" ? txn["round-time"] : null;
  const groupId = typeof txn.group === "string" ? txn.group : null;

  // A swap is an atomic group: explaining only the transaction the caller pasted
  // would describe one leg of it and miss what they actually paid or received.
  let groupTxns: RawTxn[] = [txn];
  if (groupId && round !== null) {
    try {
      const fetched = await fetchGroupTransactions(groupId, round);
      if (fetched.length > 0) groupTxns = fetched;
    } catch (err) {
      console.error(`[tx/explain] group fetch failed for ${txid}: ${String(err)}`);
    }
  }

  const initiator = txn.sender ?? null;
  const flows: Flow[] = [];
  const apps = new Set<number>();
  const directApps = new Set<number>();
  const safetyFlags = new Set<string>();
  let feeMicroAlgo = 0;
  for (const groupTxn of groupTxns) {
    collectFlows(groupTxn, flows, apps, safetyFlags);
    feeMicroAlgo += Number(groupTxn.fee ?? 0);
    // Attribution follows what the sender actually called. An aggregator routes
    // through whatever pools it likes, and naming one of those as "the protocol
    // you used" would misreport a multi-protocol route as a single-venue trade.
    const appId = groupTxn["application-transaction"]?.["application-id"];
    if (groupTxn.sender === initiator && typeof appId === "number" && appId > 0) {
      directApps.add(appId);
    }
  }
  if (feeMicroAlgo > HIGH_FEE_MICROALGO) safetyFlags.add("unusually_high_fee");

  const net = initiator ? netFor(initiator, flows) : new Map<number, bigint>();

  // Asset metadata: Vestige for anything it tracks (it carries the ticker and a
  // price), the chain itself for everything else. Without decimals we cannot
  // render an amount honestly, so an asset we can resolve neither way is skipped.
  const assetIds = [...net.keys()];
  const vestigeAssets = await fetchAssets(assetIds);
  const decimalsFor = new Map<number, number>();
  const metaFor = new Map<number, { name: string | null; unit: string | null }>();
  // Assets are independent of one another; resolving them one at a time turns a
  // two-asset swap into two round trips of waiting for no reason.
  const resolved = await Promise.all(
    assetIds.map(async (assetId) => {
      const tracked: VestigeAsset | undefined = vestigeAssets.get(assetId);
      if (tracked && tracked.decimals !== null) {
        return { assetId, decimals: tracked.decimals, name: tracked.name, unit: tracked.ticker };
      }
      const params = await fetchAssetParams(assetId);
      return params === null
        ? null
        : { assetId, decimals: params.decimals, name: params.name, unit: params.unitName };
    }),
  );
  for (const entry of resolved) {
    if (entry === null) continue;
    decimalsFor.set(entry.assetId, entry.decimals);
    metaFor.set(entry.assetId, { name: entry.name, unit: entry.unit });
  }

  // Price at the block, not price today. A transaction from last year valued at
  // this morning's rate would be worse than no number at all.
  const priceFor = new Map<number, HistoricPrice>();
  let pricingBasis: TxExplainResponse["pricing"]["basis"] = "unavailable";
  if (roundTime !== null) {
    const historic = await Promise.all(
      assetIds.map(async (assetId) => ({ assetId, price: await priceAt(assetId, roundTime) })),
    );
    for (const entry of historic) {
      if (entry.price !== null) {
        priceFor.set(entry.assetId, entry.price);
        pricingBasis = "candle_at_block_time";
      }
    }
  }
  if (priceFor.size === 0) {
    for (const assetId of assetIds) {
      const spot = vestigeAssets.get(assetId)?.price;
      if (typeof spot === "number") {
        priceFor.set(assetId, { price: spot, confidence: null });
        pricingBasis = "spot";
      }
    }
  }

  const netFlows: TxFlow[] = [];
  for (const [assetId, amount] of net) {
    const decimals = decimalsFor.get(assetId) ?? null;
    const meta = metaFor.get(assetId) ?? { name: null, unit: null };
    const price = priceFor.get(assetId);
    const whole = decimals === null ? null : toNumber(amount, decimals);
    netFlows.push({
      asset_id: assetId,
      name: meta.name,
      unit: assetId === ALGO ? "ALGO" : meta.unit,
      decimals,
      amount: decimals === null ? "unknown" : formatUnits(amount, decimals),
      amount_base_units: amount.toString(),
      usd_value: whole !== null && price !== undefined ? whole * price.price : null,
    });
  }
  netFlows.sort((a, b) => Number(a.amount_base_units) - Number(b.amount_base_units));

  const sent = netFlows.filter((f) => f.amount_base_units.startsWith("-"));
  const received = netFlows.filter((f) => !f.amount_base_units.startsWith("-"));

  let kind: TxExplainResponse["kind"];
  if (sent.length === 1 && received.length === 1) kind = "swap";
  else if (sent.length > 0 && received.length === 0) kind = "send";
  else if (received.length > 0 && sent.length === 0) kind = "receive";
  else if (netFlows.length === 0) kind = "app_interaction";
  else kind = "multi_asset";

  const appIds = [...apps];
  const labelled = [...directApps].map((id) => ({ id, app: lookupApp(id) })).find((e) => e.app);
  const application = labelled?.app
    ? { id: labelled.id, name: labelled.app.name, url: labelled.app.url }
    : null;
  if (directApps.size > 0 && application === null) safetyFlags.add("unattributed_application");

  // Realised rate vs. the market rate for that hour. This is not the pool's
  // quoted slippage — the chain records what moved, not what was quoted — and it
  // necessarily includes protocol fees and price impact together.
  let rate: TxExplainResponse["rate"] = null;
  if (kind === "swap") {
    const out = sent[0];
    const into = received[0];
    const outAmount = Math.abs(Number(out.amount));
    const intoAmount = Number(into.amount);
    if (Number.isFinite(outAmount) && Number.isFinite(intoAmount) && outAmount > 0) {
      const effective = intoAmount / outAmount;
      // Benchmark against the hour BEFORE the trade. A trade large relative to
      // pool depth moves the price it is being measured against, so the candle
      // covering the block already contains this trade's own impact — measuring
      // against it makes every large buy look like it beat the market.
      const [outPrice, intoPrice] =
        roundTime === null
          ? [null, null]
          : await Promise.all([
              priceAt(out.asset_id, roundTime, 1),
              priceAt(into.asset_id, roundTime, 1),
            ]);
      // A thinly traded asset's quote is not a usable benchmark either. When
      // confidence is low the realised rate still stands; the comparison drops.
      const benchmarkable =
        outPrice !== null &&
        intoPrice !== null &&
        intoPrice.price > 0 &&
        (outPrice.confidence ?? 0) >= MIN_RATE_CONFIDENCE &&
        (intoPrice.confidence ?? 0) >= MIN_RATE_CONFIDENCE;
      const market = benchmarkable ? outPrice.price / intoPrice.price : null;
      rate = {
        effective,
        market,
        deviation: market !== null && market > 0 ? (effective - market) / market : null,
        note: benchmarkable
          ? "Realised rate compared with the market rate in the hour before the trade, which is " +
            "the last benchmark this trade could not itself move. The gap covers protocol fees " +
            "and price impact together and is not a pool-quoted slippage figure; for a trade " +
            "large relative to pool depth, most of it is the trade's own impact."
          : "Realised rate only. No usable pre-trade benchmark: one side of this pair is either " +
            "too thinly traded for its quoted price to mean anything, or has no candle covering " +
            "the hour before the trade.",
      };
    }
  }

  // Name the venue only when the sender's own call is attributable. Otherwise
  // say how wide the route was, which is a fact, instead of picking a hop.
  const via = application
    ? ` via ${application.name}`
    : appIds.length > 1
      ? ` routed across ${appIds.length} applications`
      : directApps.size === 1
        ? ` via application ${[...directApps][0]}`
        : "";
  const feeAlgo = feeMicroAlgo / MICROALGO;
  const sentence: string[] = [];
  if (kind === "swap") {
    sentence.push(
      `Swapped ${humanAmount(sent[0].amount.replace("-", ""))} ${sent[0].unit ?? `asset ${sent[0].asset_id}`} ` +
        `for ${humanAmount(received[0].amount)} ${received[0].unit ?? `asset ${received[0].asset_id}`}${via}.`,
    );
  } else if (kind === "send") {
    sentence.push(
      `Sent ${sent.map((f) => `${humanAmount(f.amount.replace("-", ""))} ${f.unit ?? `asset ${f.asset_id}`}`).join(", ")}${via}.`,
    );
  } else if (kind === "receive") {
    sentence.push(
      `Received ${received.map((f) => `${humanAmount(f.amount)} ${f.unit ?? `asset ${f.asset_id}`}`).join(", ")}${via}.`,
    );
  } else if (kind === "app_interaction") {
    sentence.push(
      `Called ${application ? application.name : `application ${appIds[0] ?? "unknown"}`} with no net asset movement for the sender.`,
    );
  } else {
    sentence.push(
      `Moved ${sent.length} asset${sent.length === 1 ? "" : "s"} out and ${received.length} in${via}.`,
    );
  }
  sentence.push(
    `Network fee ${feeAlgo.toLocaleString("en-US", { maximumFractionDigits: 6 })} ALGO across ` +
      `${groupTxns.length} transaction${groupTxns.length === 1 ? "" : "s"}.`,
  );
  if (rate?.deviation !== null && rate?.deviation !== undefined) {
    const pct = Math.abs(rate.deviation * 100).toFixed(2);
    sentence.push(
      `Realised rate sat ${pct}% ${rate.deviation < 0 ? "below" : "above"} the pre-trade market rate, fees and price impact included.`,
    );
  }
  sentence.push(
    safetyFlags.size > 0
      ? `Flagged: ${[...safetyFlags].join(", ")}.`
      : "Checks for rekeys, close-outs and abnormal fees found nothing to flag.",
  );

  const response: TxExplainResponse = {
    status: "ok",
    txid,
    chain: "algorand",
    confirmed_round: round,
    timestamp: roundTime !== null ? new Date(roundTime * 1000).toISOString() : null,
    group_id: groupId,
    group_size: groupTxns.length,
    kind,
    summary: sentence.join(" "),
    initiator,
    net_flows: netFlows,
    applications: appIds,
    application,
    rate,
    fees: { total_algo: feeAlgo, transactions: groupTxns.length },
    pricing: {
      basis: pricingBasis,
      note:
        pricingBasis === "candle_at_block_time"
          ? "Assets priced from the hourly candle covering the block. A trade that moved a thin " +
            "market is valued at the price it created, so the two legs of such a swap will not " +
            "carry equal USD values."
          : pricingBasis === "spot"
            ? "No candle covered this block; prices are current spot, not the price at the time."
            : "No price source covered these assets; USD values are null.",
    },
    safety_flags: [...safetyFlags],
    checks_run: CHECKS_RUN,
    data_source: "nodely+vestige",
    cached: false,
  };

  setCached(cacheKey, response, EXPLAIN_TTL_SECONDS);
  return response;
}
