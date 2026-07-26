import { getCached, setCached } from "../cache.js";
import {
  applicationAccount,
  disassembleProgram,
  fetchApplication,
  type GlobalStateEntry,
} from "../adapters/algorand-app.js";
import { fetchAccountHoldings } from "../adapters/algorand-account.js";
import { fetchAssets } from "../adapters/vestige.js";

const CONTRACT_TTL_SECONDS = 10 * 60;
/** Priced positions per analysis; some routers hold thousands of dust assets. */
const MAX_PRICED_ASSETS = 200;

/** OnCompletion values as defined by the protocol. */
const ON_COMPLETION = {
  0: "noop",
  1: "opt_in",
  2: "close_out",
  4: "update_application",
  5: "delete_application",
} as const;

export interface ContractAnalysis {
  status: "ok";
  chain: "algorand";
  app_id: number;
  app_account: string;
  creator: string | null;
  created_at_round: number | null;
  deleted: boolean;
  privileged_addresses: Array<{ key: string; address: string }>;
  global_state: GlobalStateEntry[];
  schema: {
    global: { uints: number | null; byte_slices: number | null };
    local: { uints: number | null; byte_slices: number | null };
  };
  program: {
    teal_version: number | null;
    instruction_lines: number | null;
    /** Which completion types the approval program explicitly tests for. */
    on_completion_tested: Record<string, boolean> | null;
    update_analysis: string;
  };
  holdings: {
    algo: number | null;
    assets_held: number | null;
    tvl_usd: number | null;
  };
  audit_status: null;
  methods: null;
  risk_flags: string[];
  notes: string[];
  data_source: string;
  cached: boolean;
}

/**
 * Which OnCompletion types the approval program branches on.
 *
 * Programs compile this as `txn OnCompletion; pushint N; ==`, so the tested
 * values can be read straight out of the disassembly. What the branch then does
 * is deliberately not inferred: following it would mean reconstructing control
 * flow, and a wrong answer here would be a safety claim we cannot stand behind.
 */
function parseOnCompletionTests(teal: string): Record<string, boolean> {
  const lines = teal.split("\n").map((line) => line.trim());
  const tested = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!/\bOnCompletion\b/.test(lines[i])) continue;
    // The comparison constant sits within the next few instructions.
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const match = /^(?:pushint|int)\s+(\d+)$/.exec(lines[j]);
      if (match) {
        tested.add(Number(match[1]));
        break;
      }
    }
  }
  const result: Record<string, boolean> = {};
  for (const [value, name] of Object.entries(ON_COMPLETION)) {
    result[name] = tested.has(Number(value));
  }
  return result;
}

function parseTealVersion(teal: string): number | null {
  const match = /^#pragma version (\d+)/m.exec(teal);
  return match ? Number(match[1]) : null;
}

export async function analyzeContract(appId: number): Promise<ContractAnalysis | null> {
  const cacheKey = `contract:algorand:${appId}`;
  const cached = getCached<ContractAnalysis>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const application = await fetchApplication(appId);
  if (application === null) return null;

  const account = applicationAccount(appId);
  // A null result means the application account was never funded — a real fact
  // worth reporting as zero. A rejection means we could not read it at all,
  // which is a different answer and must not be reported as an empty balance.
  const [teal, holdingsOutcome] = await Promise.all([
    application.approvalProgram ? disassembleProgram(application.approvalProgram) : null,
    fetchAccountHoldings(account).then(
      (result) => ({ readable: true, result }) as const,
      () => ({ readable: false, result: null }) as const,
    ),
  ]);
  const holdings = holdingsOutcome.result;
  const holdingsUnreadable = !holdingsOutcome.readable;

  const riskFlags: string[] = [];
  const notes: string[] = [];

  const privileged = application.globalState
    .filter((entry): entry is GlobalStateEntry & { address: string } => entry.address !== null)
    .map((entry) => ({ key: entry.key, address: entry.address }));
  if (privileged.length > 0) riskFlags.push("privileged_addresses_in_global_state");
  if (application.deleted) riskFlags.push("application_deleted");

  let onCompletionTested: Record<string, boolean> | null = null;
  let updateAnalysis: string;
  if (teal === null) {
    updateAnalysis =
      "The approval program could not be disassembled, so nothing is claimed about how it " +
      "handles update or delete calls.";
    notes.push("Program disassembly was unavailable; program fields are null.");
  } else {
    onCompletionTested = parseOnCompletionTests(teal);
    if (onCompletionTested.update_application) {
      updateAnalysis =
        "The approval program explicitly tests for UpdateApplication calls. Whether it approves " +
        "or rejects them is not determined here — that requires following the branch, and this " +
        "reports only what the bytecode demonstrably checks.";
    } else {
      updateAnalysis =
        "The approval program never tests for UpdateApplication. Update calls therefore fall " +
        "through to its main path, so whether an update can succeed depends on that path rather " +
        "than on an explicit guard. This is an observation, not a verdict that the app is " +
        "upgradeable.";
      riskFlags.push("update_calls_not_explicitly_guarded");
    }
    if (!onCompletionTested.delete_application) {
      riskFlags.push("delete_calls_not_explicitly_guarded");
    }
  }

  // TVL is what the application's own account holds. Value what can be priced
  // and say how much could not be, rather than quietly undercounting.
  let tvlUsd: number | null = null;
  let assetsHeld: number | null = null;
  let algoBalance: number | null = null;
  if (holdings !== null) {
    algoBalance = holdings.microAlgos / 1_000_000;
    assetsHeld = holdings.assets.length;
    const positions = holdings.assets.slice(0, MAX_PRICED_ASSETS);
    if (holdings.assets.length > MAX_PRICED_ASSETS) {
      notes.push(
        `The application holds ${holdings.assets.length} assets; the first ${MAX_PRICED_ASSETS} ` +
          "were priced and the remainder are excluded from tvl_usd.",
      );
    }
    const ids = [0, ...positions.map((entry) => entry.assetId)];
    const meta = await fetchAssets(ids);
    let total = 0;
    let priced = 0;
    let unpriced = 0;
    const algoPrice = meta.get(0)?.price ?? null;
    if (algoPrice !== null) {
      total += algoBalance * algoPrice;
      priced += 1;
    }
    for (const asset of positions) {
      const entry = meta.get(asset.assetId);
      if (entry?.price != null && entry.decimals != null) {
        total += (Number(asset.amount) / 10 ** entry.decimals) * entry.price;
        priced += 1;
      } else {
        unpriced += 1;
      }
    }
    tvlUsd = priced > 0 ? Number(total.toFixed(2)) : null;
    if (unpriced > 0) {
      notes.push(
        `${unpriced} of the ${positions.length} asset positions checked could not be priced and ` +
          "are excluded from tvl_usd.",
      );
    }
  } else if (holdingsUnreadable) {
    notes.push("The application account could not be read, so holdings and TVL are null.");
  } else {
    algoBalance = 0;
    assetsHeld = 0;
    tvlUsd = 0;
    notes.push(
      "The application account holds nothing on-chain. Protocols that custody funds in separate " +
        "pool accounts rather than the application account itself will show no TVL here.",
    );
  }

  notes.push(
    "audit_status is always null: no audit registry exists for Algorand applications to query, " +
      "and inferring one would be a guess.",
  );
  notes.push(
    "methods is always null: Algorand applications carry no on-chain ABI. Method descriptions " +
      "(ARC-32/ARC-56) are off-chain artifacts the chain does not hold.",
  );

  const analysis: ContractAnalysis = {
    status: "ok",
    chain: "algorand",
    app_id: appId,
    app_account: account,
    creator: application.creator,
    created_at_round: application.createdAtRound,
    deleted: application.deleted,
    privileged_addresses: privileged,
    global_state: application.globalState,
    schema: {
      global: {
        uints: application.globalSchema.uints,
        byte_slices: application.globalSchema.byteSlices,
      },
      local: {
        uints: application.localSchema.uints,
        byte_slices: application.localSchema.byteSlices,
      },
    },
    program: {
      teal_version: teal === null ? null : parseTealVersion(teal),
      instruction_lines: teal === null ? null : teal.split("\n").length,
      on_completion_tested: onCompletionTested,
      update_analysis: updateAnalysis,
    },
    holdings: { algo: algoBalance, assets_held: assetsHeld, tvl_usd: tvlUsd },
    audit_status: null,
    methods: null,
    risk_flags: riskFlags,
    notes,
    data_source: "nodely+algod+vestige",
    cached: false,
  };

  setCached(cacheKey, analysis, CONTRACT_TTL_SECONDS);
  return analysis;
}
