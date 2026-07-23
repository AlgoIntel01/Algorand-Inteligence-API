# Verdict — Agent Intelligence API

The intelligence endpoint AI agents pay for, settled in USDCa on Algorand via the
[x402 protocol](https://algorand.co/agentic-commerce/x402/developers).

Cross-chain wallet and token intelligence (Ethereum, Base, BSC, Solana, Algorand),
priced per call, paid in USDCa (ASA `31566704`) on Algorand mainnet. Payment
verification and settlement is handled by the
[GoPlausible facilitator](https://facilitator.goplausible.xyz) with fee abstraction —
payers need USDCa, not ALGO.

**Status: beta.** Payments, metering and API shapes are live. The heuristics engine is
not yet wired up; analysis responses return `status: "beta"` with null scores rather
than fabricated signals.

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

`scripts/test-client.ts` wraps `fetch` with `@x402-avm/fetch` and pays `/watch/poll`
with real USDCa. Set `BUYER_PRIVATE_KEY_B64` (base64 secret key or 25-word mnemonic)
for a wallet that holds USDCa on the configured network, then:

```bash
npm run test-client
```

## Architecture

```
Agent → x402 middleware (@x402-avm/hono: 402 challenge → verify → settle)
      → GoPlausible facilitator (Algorand mainnet, fee abstraction)
      → route handler (src/routes/*)
      → [v2: cache → chain adapters → heuristics → LLM synthesis]
```

- `src/index.ts` — Hono app, paywall routes with prices and discovery metadata
- `src/config.ts` — network constants (mainnet/testnet CAIP-2, USDC ASA IDs)
- `src/routes/` — `/wallet/analyze`, `/token/analyze`, `/watch/poll`
- `scripts/` — seller wallet creation, USDCa opt-in, paying test client

## Roadmap

Per the build spec: heuristics engine (cluster/precursor detection), chain adapters
(Nodely, viem, Solana RPC), cache layer, LLM verdict synthesis, CCTP funding-rail CLI,
MCP server + agent-framework plugins.
