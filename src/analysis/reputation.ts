import { getCached, setCached } from "../cache.js";
import {
  fetchAccountProfile,
  fetchRecentActivity,
  fetchRoundTime,
} from "../adapters/algorand-account.js";
import { fetchNfd, type NfdIdentity } from "../adapters/nfd.js";
import { lookupKnownAddress } from "../data/known-addresses.js";

/** Reputation moves slowly; an hour-old answer is still a good answer. */
const REPUTATION_TTL_SECONDS = 60 * 60;
const DAY_SECONDS = 86_400;

/**
 * Component weights. They are published in the response so an integrator can
 * see exactly how a score was reached rather than trusting a number — the same
 * rule the token and wallet scores follow.
 */
const WEIGHTS = {
  age: 0.3,
  activity: 0.2,
  counterparties: 0.15,
  identity: 0.15,
  holdings: 0.1,
  recency: 0.1,
} as const;

const REKEY_PENALTY = 0.2;
const AGE_FULL_CREDIT_DAYS = 365;
const ACTIVITY_FULL_CREDIT_TXS = 100;
const COUNTERPARTY_FULL_CREDIT = 25;
const HOLDINGS_FULL_CREDIT = 10;
const RECENT_ACTIVITY_DAYS = 30;

export interface ReputationResponse {
  status: "ok";
  chain: "algorand";
  address: string;
  /** The published score, after any override below. */
  trust_score: number;
  /** What the weighted components alone produced, before overrides. Always the
   * sum of components minus penalties, so the two can be reconciled. */
  computed_score: number;
  tier: "established" | "developing" | "new" | "flagged";
  /** Set when the address is a known entity rather than an ordinary wallet. */
  known_entity: { label: string; name: string } | null;
  confidence: number;
  components: Record<string, { weight: number; earned: number; basis: string }>;
  positive_signals: string[];
  negative_signals: string[];
  identity: { nfd_name: string; verified_socials: string[] } | null;
  account: {
    age_days: number | null;
    created_at_round: number | null;
    algo_balance: number;
    assets_opted_in: number | null;
    apps_opted_in: number | null;
    created_assets: number | null;
    rekeyed_to: string | null;
  };
  activity: {
    txs_sampled: number | null;
    sample_truncated: boolean | null;
    distinct_counterparties: number | null;
    last_active: string | null;
  };
  notes: string[];
  data_source: string;
  cached: boolean;
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * A cheap, cacheable standing score for an address, meant to be embedded by
 * wallets and explorers next to an address.
 *
 * It is deliberately lighter than /wallet/analyze: no funding ancestry, no
 * cluster expansion. Everything here comes from one account read, one bounded
 * transaction page, and an optional name lookup.
 */
export async function analyzeReputation(address: string): Promise<ReputationResponse | null> {
  const cacheKey = `reputation:algorand:${address}`;
  const cached = getCached<ReputationResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const profile = await fetchAccountProfile(address);
  if (profile === null) return null;

  const [activity, identity, createdAt] = await Promise.all([
    fetchRecentActivity(address),
    fetchNfd(address),
    profile.createdAtRound !== null ? fetchRoundTime(profile.createdAtRound) : Promise.resolve(null),
  ]);

  const notes: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageDays =
    createdAt !== null ? Math.max(0, Math.floor((nowSeconds - createdAt) / DAY_SECONDS)) : null;
  if (ageDays === null) {
    notes.push(
      "Account creation time could not be read, so the age component earned nothing rather than " +
        "being estimated.",
    );
  }

  const components: ReputationResponse["components"] = {};
  const award = (name: keyof typeof WEIGHTS, fraction: number, basis: string): number => {
    const earned = Number((WEIGHTS[name] * clamp01(fraction)).toFixed(4));
    components[name] = { weight: WEIGHTS[name], earned, basis };
    return earned;
  };

  let score = 0;
  score += award(
    "age",
    ageDays === null ? 0 : ageDays / AGE_FULL_CREDIT_DAYS,
    ageDays === null ? "creation time unavailable" : `${ageDays} days old, full credit at ${AGE_FULL_CREDIT_DAYS}`,
  );
  score += award(
    "activity",
    (activity?.sampled ?? 0) / ACTIVITY_FULL_CREDIT_TXS,
    `${activity?.sampled ?? 0} transactions in the sampled page, full credit at ${ACTIVITY_FULL_CREDIT_TXS}`,
  );
  score += award(
    "counterparties",
    (activity?.distinctCounterparties ?? 0) / COUNTERPARTY_FULL_CREDIT,
    `${activity?.distinctCounterparties ?? 0} distinct counterparties in the sample, full credit at ${COUNTERPARTY_FULL_CREDIT}`,
  );
  score += award(
    "identity",
    identity === null ? 0 : identity.verified.length > 0 ? 1 : 0.6,
    identity === null
      ? "no NFDomains name found for this address"
      : `holds ${identity.name}${identity.verified.length > 0 ? ` with ${identity.verified.length} verified social(s)` : " with no verified socials"}`,
  );
  score += award(
    "holdings",
    (profile.assetsOptedIn ?? 0) / HOLDINGS_FULL_CREDIT,
    `opted into ${profile.assetsOptedIn ?? 0} assets, full credit at ${HOLDINGS_FULL_CREDIT}`,
  );

  const daysSinceActive =
    activity?.lastActiveAt != null ? (nowSeconds - activity.lastActiveAt) / DAY_SECONDS : null;
  score += award(
    "recency",
    daysSinceActive === null ? 0 : daysSinceActive <= RECENT_ACTIVITY_DAYS ? 1 : 0,
    daysSinceActive === null
      ? "no recent activity found"
      : `last active ${Math.floor(daysSinceActive)} days ago, credit within ${RECENT_ACTIVITY_DAYS}`,
  );

  // A rekeyed account is signed for by a different key than its address implies.
  // That is not inherently malicious, but the party in control is not the party
  // the address names, which anyone leaning on this score should know.
  if (profile.authAddr !== null) {
    score -= REKEY_PENALTY;
    negative.push("rekeyed_to_another_account");
    notes.push(
      `This account is rekeyed to ${profile.authAddr}: transactions are authorised by that key, ` +
        `not by ${address}. The score carries a ${REKEY_PENALTY} penalty for it.`,
    );
  }

  if (ageDays !== null && ageDays >= AGE_FULL_CREDIT_DAYS) positive.push("account_over_one_year_old");
  if (ageDays !== null && ageDays < 7) negative.push("account_less_than_a_week_old");
  if (identity !== null) positive.push("holds_nfdomains_name");
  if (identity !== null && identity.verified.length > 0) positive.push("verified_socials_on_name");
  if ((profile.createdAssets ?? 0) > 0) positive.push("has_created_assets");
  if (daysSinceActive !== null && daysSinceActive > 180) negative.push("dormant_over_six_months");
  if ((activity?.sampled ?? 0) === 0) negative.push("no_transactions_found");

  // A burn or mixer address is not a counterparty whose standing can be scored.
  // Left alone the heuristic rates the burn address highly — it is old, busy and
  // has many counterparties — which would vouch for an address that destroys
  // anything sent to it. Naming the entity and zeroing the score is the honest
  // answer; the components stay visible so the override is auditable.
  const known = lookupKnownAddress(address, "algorand");
  const unspendable = known?.label === "burn" || known?.label === "mixer";

  const computedScore = Number(clamp01(score).toFixed(4));
  let trustScore = computedScore;
  let tier: ReputationResponse["tier"] =
    trustScore >= 0.7 ? "established" : trustScore >= 0.4 ? "developing" : "new";

  if (known !== null) {
    positive.length = 0;
    negative.push(`known_${known.label}_address`);
    notes.push(
      `This address is ${known.name}, a known ${known.label} address. Component scores below ` +
        "describe its on-chain footprint, not the trustworthiness of a counterparty.",
    );
  }
  if (unspendable) {
    trustScore = 0;
    tier = "flagged";
    notes.push(
      known?.label === "burn"
        ? "Funds sent to this address cannot be recovered by anyone. Its activity and age would " +
            "otherwise score well, which is exactly why the score is overridden to zero."
        : "Mixer addresses are flagged regardless of their on-chain footprint.",
    );
  }

  // Confidence reflects how much we could actually read, not how good the
  // address looks. A score built on partial data says so.
  let confidence = 1;
  if (activity === null) confidence -= 0.4;
  if (ageDays === null) confidence -= 0.3;
  if (activity?.truncated === true) {
    notes.push(
      "The activity sample filled its page, so this account has more history than was counted. " +
        "Activity and counterparty components are floors, not totals.",
    );
  }

  notes.push(
    "Identity comes from NFDomains and only exists for addresses holding a .algo name. Its " +
      "absence says nothing about the address — there is no general social graph for Algorand.",
  );
  notes.push(
    "This is a heuristic built from the named components above, not a measure of honesty. Use it " +
      "to rank and triage, not as a verdict on a counterparty.",
  );

  const response: ReputationResponse = {
    status: "ok",
    chain: "algorand",
    address,
    trust_score: trustScore,
    computed_score: computedScore,
    tier,
    known_entity: known ? { label: known.label, name: known.name } : null,
    confidence: Number(clamp01(confidence).toFixed(2)),
    components,
    positive_signals: positive,
    negative_signals: negative,
    identity: identity ? { nfd_name: identity.name, verified_socials: identity.verified } : null,
    account: {
      age_days: ageDays,
      created_at_round: profile.createdAtRound,
      algo_balance: profile.microAlgos / 1_000_000,
      assets_opted_in: profile.assetsOptedIn,
      apps_opted_in: profile.appsOptedIn,
      created_assets: profile.createdAssets,
      rekeyed_to: profile.authAddr,
    },
    activity: {
      txs_sampled: activity?.sampled ?? null,
      sample_truncated: activity?.truncated ?? null,
      distinct_counterparties: activity?.distinctCounterparties ?? null,
      last_active:
        activity?.lastActiveAt != null
          ? new Date(activity.lastActiveAt * 1000).toISOString()
          : null,
    },
    notes,
    data_source: "nodely+nfdomains",
    cached: false,
  };

  setCached(cacheKey, response, REPUTATION_TTL_SECONDS);
  return response;
}

export type { NfdIdentity };
