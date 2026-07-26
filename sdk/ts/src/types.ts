/** Chains with token analysis support. */
export type TokenChain = "ethereum" | "base" | "bsc" | "solana" | "algorand";
/** Chains with wallet analysis support. */
export type WalletChain = "algorand" | "ethereum" | "base";

export interface TokenAnalysis {
  status: "ok";
  asset: string;
  chain: TokenChain;
  name: string | null;
  symbol: string | null;
  liquidity: {
    depth_usd: number | null;
    lock_status: "locked" | "unlocked" | "unknown";
    lock_expiry: string | null;
  };
  holders: {
    count: number | null;
    top_10_concentration: number | null;
    insider_overlap: number | null;
  };
  deployer: { address: string | null; prior_launches: number | null; prior_outcomes: string[] };
  rug_probability: number | null;
  rug_signals: string[];
  positive_signals: string[];
  verdict: string;
  verdict_source: "llm" | "template";
  data_source: string;
  cached: boolean;
}

export interface WalletAnalysis {
  status: "ok";
  address: string;
  chain: WalletChain;
  depth: "standard" | "deep";
  risk_score: number | null;
  confidence: number | null;
  labels: string[];
  cluster: {
    members: string[];
    funding_ancestry: Array<{
      address: string;
      kind: string;
      name: string | null;
      funded_at: string | null;
    }>;
    timing_correlation: Record<string, unknown>;
    note?: string;
  };
  verdict: string;
  cached: boolean;
}

export interface TxFlow {
  asset_id: number;
  name: string | null;
  unit: string | null;
  decimals: number | null;
  /** Signed decimal string. Negative means it left the account. */
  amount: string;
  amount_base_units: string;
  usd_value: number | null;
}

export interface TxExplanation {
  status: "ok";
  txid: string;
  chain: "algorand";
  confirmed_round: number | null;
  timestamp: string | null;
  group_id: string | null;
  group_size: number;
  kind: "swap" | "send" | "receive" | "app_interaction" | "multi_asset";
  summary: string;
  initiator: string | null;
  net_flows: TxFlow[];
  applications: number[];
  application: { id: number; name: string; url: string } | null;
  rate: {
    effective: number;
    market: number | null;
    deviation: number | null;
    note: string;
  } | null;
  fees: { total_algo: number; transactions: number };
  pricing: { basis: string; note: string };
  safety_flags: string[];
  checks_run: string[];
  cached: boolean;
}

export interface TxSimulation {
  status: "ok";
  chain: "algorand";
  would_succeed: boolean;
  failure_summary: string | null;
  failure_reason: string | null;
  failed_at: number | null;
  group_size: number;
  transactions: Array<{
    index: number;
    type: string;
    sender: string;
    failure: string | null;
    budget_consumed: number | null;
  }>;
  fees: { total_algo: number };
  simulated_against_round: number | null;
  note: string;
}

export type DiscoverSignal =
  | "new_launches"
  | "trending"
  | "volume_growth"
  | "liquidity_moves"
  | "fresh_lps"
  | "trending_protocols";

export interface DiscoveredAsset {
  asset_id: number;
  name: string | null;
  ticker: string | null;
  price_usd: number | null;
  tvl_usd: number | null;
  volume_1d_usd: number | null;
  created_at: string | null;
  age_days: number | null;
  measure: { label: string; value: number } | null;
}

export interface DiscoverResult {
  status: "ok";
  chain: "algorand";
  generated_at: string;
  signals: {
    new_launches?: DiscoveredAsset[];
    trending?: DiscoveredAsset[];
    volume_growth?: DiscoveredAsset[];
    liquidity_moves?: DiscoveredAsset[];
    fresh_lps?: Array<{
      protocol: string | null;
      protocol_id: number;
      application_id: number | null;
      assets: [string | null, string | null];
      asset_ids: [number, number];
      created_at: string | null;
      age_hours: number | null;
    }>;
    trending_protocols?: Array<{
      protocol_id: number;
      name: string | null;
      url: string | null;
      swaps_1d: number | null;
      volume_1d_usd: number | null;
    }>;
  };
  notes: string[];
  cached: boolean;
}

export interface Holding {
  asset_id: number;
  name: string | null;
  ticker: string | null;
  amount: number;
  price_usd: number | null;
  value_usd: number | null;
  allocation: number | null;
  flows_30d: { bought_usd: number | null; sold_usd: number | null; net_usd: number | null } | null;
}

export interface Portfolio {
  status: "ok";
  chain: "algorand";
  address: string;
  total_value_usd: number | null;
  priced_holdings: number;
  unpriced_holdings: number;
  holdings: Holding[];
  lp_positions: Array<{ pool_id: string; detail: unknown }>;
  realized_flows_30d: {
    bought_usd: number;
    sold_usd: number;
    net_usd: number;
    basis: string;
  } | null;
  notes: string[];
  cached: boolean;
}

export interface SmartMoneyTrader {
  address: string;
  routed: boolean;
  swaps_sampled: number;
  amount_bought: number | null;
  bought_usd: number | null;
  amount_sold: number | null;
  sold_usd: number | null;
  avg_buy_price_usd: number | null;
  avg_sell_price_usd: number | null;
  round_trip_roi: number | null;
  holding_period_hours: number | null;
  current_position: number | null;
  current_position_usd: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface SmartMoney {
  status: "ok";
  chain: "algorand";
  asset_id: number;
  asset_ticker: string | null;
  window_days: number;
  traders: SmartMoneyTrader[];
  cohort: {
    traders_ranked: number;
    with_computable_roi: number;
    win_rate: number | null;
    median_roi: number | null;
  };
  /** Read this before quoting any number above. */
  methodology: string[];
  cached: boolean;
}

export interface ContractAnalysis {
  status: "ok";
  chain: "algorand";
  app_id: number;
  app_account: string;
  creator: string | null;
  created_at_round: number | null;
  deleted: boolean;
  privileged_addresses: Array<{ key: string; address: string }>;
  global_state: Array<{
    key: string;
    type: "bytes" | "uint";
    value: string | number;
    address: string | null;
  }>;
  schema: {
    global: { uints: number | null; byte_slices: number | null };
    local: { uints: number | null; byte_slices: number | null };
  };
  program: {
    teal_version: number | null;
    instruction_lines: number | null;
    on_completion_tested: Record<string, boolean> | null;
    update_analysis: string;
  };
  holdings: { algo: number | null; assets_held: number | null; tvl_usd: number | null };
  /** Always null: no Algorand audit registry exists to query. */
  audit_status: null;
  /** Always null: Algorand applications carry no on-chain ABI. */
  methods: null;
  risk_flags: string[];
  notes: string[];
  cached: boolean;
}

export interface Reputation {
  status: "ok";
  chain: "algorand";
  address: string;
  /** Published score, after any override. */
  trust_score: number;
  /** What the components alone produced, before overrides. */
  computed_score: number;
  tier: "established" | "developing" | "new" | "flagged";
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
  cached: boolean;
}

export interface AskResult {
  status: "ok";
  question: string;
  answer: string;
  tools_used: Array<{ tool: string; input: Record<string, unknown> }>;
  /** The structured data every figure in `answer` rests on. Check it here. */
  data: Record<string, unknown>;
  steps: number;
  truncated: boolean;
  model: string;
  notes: string[];
}

export type WatchTarget =
  | { type: "wallet"; address: string; chain: TokenChain }
  | { type: "token"; asset: string; chain: TokenChain };

export interface WatchPollResult {
  status: "ok";
  cursor: string;
  since: string | null;
  now: string;
  watched: number;
  changes: Array<{
    type: string;
    target: WatchTarget;
    observed_at: string;
    detail: Record<string, unknown>;
  }>;
  warnings?: Array<{ target: WatchTarget; message: string }>;
  note?: string;
}

export interface ServiceCard {
  name: string;
  tagline: string;
  status: string;
  payment: Record<string, unknown>;
  endpoints: Array<{ route: string; price: string; note?: string }>;
  chains: string[];
}
