# Verdict — Agent Intelligence API

The intelligence endpoint AI agents pay for, settled in USDCa on Algorand via the
[x402 protocol](https://algorand.co/agentic-commerce/x402/developers).

Cross-chain wallet and token intelligence (Ethereum, Base, BSC, Solana, Algorand),
priced per call, paid in USDCa (ASA `31566704`) on Algorand mainnet. Payment
verification and settlement is handled by the
[GoPlausible facilitator](https://facilitator.goplausible.xyz) with fee abstraction —
payers need USDCa, not ALGO.

**Status: `/token/analyze` is live with real data** (GoPlus for EVM/Solana, Nodely +
Vestige for Algorand): holder concentration, liquidity, deployer, structural rug signals,
a deterministic `rug_probability`, and a verdict paragraph (LLM-written when
`ANTHROPIC_API_KEY` is set, honest template otherwise — see `verdict_source`). Analyses
are cached (10 min TTL); verdicts regenerate only when the underlying signals change.
Fields a source can't provide are `null`, never fabricated. `/wallet/analyze` and
`/watch/poll` remain beta stubs (payments and metering live, heuristics next).

## Endpoints

| Route | Price | What it is |
|---|---|---|
| `POST /wallet/analyze` | $0.08 | Risk score, behavioral labels, cluster membership, funding ancestry, verdict |
| `POST /wallet/analyze?depth=deep` | $0.50 | Full graph traversal + long-form synthesis |
| `POST /token/analyze` | $0.05 | Liquidity/locks, holder concentration, deployer history, rug probability, smart money |
| `POST /watch/poll` | $0.01 | Cursor-based deltas across watched wallets/tokens; every poll is a paid query |
| `GET /` | free | Service card: endpoints, prices, payment terms |
| `GET /health` | free | Liveness |

Unpaid requests receive `HTTP 402` with the full x402 payment requirements in the
`payment-required` header (base64 JSON: scheme, network, amount, asset, payTo, feePayer).

### Example

```bash
curl -X POST https://<host>/watch/poll \
  -H "Content-Type: application/json" \
  -d '{"cursor": null, "watch": [{"type":"token","asset":"31566704","chain":"algorand"}]}'
# → 402 with payment-required header; pay via any x402 client (see scripts/test-client.ts)
```

## Running it

```bash
npm install
npm run create-wallet   # generates the seller keypair into .env (gitignored)
# fund the printed address with ~0.3 ALGO, then:
npm run optin-usdca     # opt the seller account into USDCa
npm run dev             # http://localhost:3402
```

Config lives in `.env` (see `.env.example`): `NETWORK` (mainnet/testnet),
`SELLER_ADDRESS`, `FACILITATOR_URL`, `PUBLIC_BASE_URL`, `PORT`.

### Paying a call end-to-end

You need a **buyer** wallet, separate from the seller — never pay your own endpoint
from the seller account (the contest voids self-payments). Either generate a throwaway
one or reuse an existing wallet:

```bash
npm run create-buyer    # generates a buyer keypair into .env (BUYER_PRIVATE_KEY_B64)
# fund the printed address with ~0.2 ALGO (for the opt-in) + some USDCa (to spend), then:
npm run optin-buyer     # opt the buyer into USDCa
npm run test-client     # wraps fetch with @x402-avm/fetch, pays a real $0.01 /watch/poll
```

`BUYER_PRIVATE_KEY_B64` accepts either a 25-word mnemonic or a base64-encoded 64-byte
secret key, so you can paste an existing wallet's recovery phrase instead of generating
one. The buyer needs ALGO only for the one-time USDCa opt-in; the x402 payment itself is
gasless via the facilitator's fee abstraction.

## Architecture

```
Agent → x402 middleware (@x402-avm/hono: 402 challenge → verify → settle)
      → GoPlausible facilitator (Algorand mainnet, fee abstraction)
      → route handler (src/routes/*)
      → [v2: cache → chain adapters → heuristics → LLM synthesis]
```

- `src/index.ts` — Hono app, paywall routes with prices and Bazaar discovery metadata
  (`@x402-avm/extensions/bazaar`, indexed by the facilitator from 402 responses)
- `src/config.ts` — network constants (mainnet/testnet CAIP-2, USDC ASA IDs)
- `src/routes/` — `/wallet/analyze`, `/token/analyze`, `/watch/poll`
- `src/adapters/` — GoPlus (EVM + Solana) and Nodely/Vestige (Algorand) token data
- `src/analysis/token.ts` — deterministic weighted rug scoring over normalized signals
- `src/verdict.ts` — verdict synthesis (Anthropic API or template), cached by signals hash
- `src/cache.ts` — SQLite cache (`data/cache.db`), per-endpoint TTLs
- `scripts/` — wallet creation (seller + buyer), USDCa opt-in, paying test client;
  shared Algorand helpers in `scripts/algo.ts`

## Roadmap

Delivered in phases:

- **Phase 1 — ✅ Payments live.** Repo, x402 middleware on Algorand mainnet, all three
  routes behind the paywall, one proven end-to-end paid call in USDCa.
- **Phase 2 — ✅ Real `/token/analyze`.** Cross-chain token data (GoPlus for EVM/Solana,
  Nodely + Vestige for Algorand), deterministic rug scoring, LLM/template verdict, SQLite
  cache, Bazaar discovery metadata on every route.
- **Phase 3 — `/wallet/analyze`.** Port the cluster / precursor-detection heuristics —
  the product's real edge.
- **Phase 4 — `/watch/poll` deltas + funding rail.** Real change detection over watched
  wallets/tokens; ship the CCTP funding-rail CLI (Base/Solana → ready-to-pay Algorand
  wallet) and open-source it.
- **Phase 5 — Distribution.** MCP server and ElizaOS / OpenClaw plugins; get agents
  integrating and paying.
- **Phase 6 — Harden & submit.** Monitoring, buffer, competition submission.
