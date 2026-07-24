# Verdict — Agent Intelligence API

[![npm](https://img.shields.io/npm/v/verdict-mcp?label=verdict-mcp)](https://www.npmjs.com/package/verdict-mcp)

**Cross-chain wallet and token intelligence your AI agent can buy for itself.** No API key,
no account, no subscription — your agent pays per call in USDC on Algorand using the
[x402 protocol](https://algorand.co/agentic-commerce/x402/developers).

Analytics tells you a wallet made 42 trades. Verdict tells you that wallet was funded
through three throwaway addresses last week, moves in lockstep with eleven others, and
has never held a token longer than an hour.

## What you can ask

**Is this token a rug?** Liquidity depth and lock status, holder concentration, deployer
history, and a `rug_probability` with the specific signals behind it — not a black-box
score. Works on Ethereum, Base, BSC, Solana and Algorand.

**Can I trust this wallet?** Who funded it, walked back hop by hop toward an exchange or a
mixer. Which wallets were funded by the same source in the same minutes. Whether it behaves
like a bot, an accumulator, or a wallet that just woke up after a year. Works on Ethereum,
Base and Algorand.

**What changed since I last looked?** Cursor-based deltas across everything you're
watching — wallet activity, liquidity moves, holder shifts — priced so that polling on a
schedule is actually viable.

Every field a data source can't provide comes back `null`. Nothing is invented to make a
response look complete.

## Quickstart — from an AI agent

Add this to your MCP client's config (Claude Desktop: `claude_desktop_config.json`;
Claude Code: `.mcp.json`), then restart it:

```json
{
  "mcpServers": {
    "verdict": {
      "command": "npx",
      "args": ["-y", "verdict-mcp"],
      "env": { "ALGORAND_PRIVATE_KEY": "your 25 word mnemonic" }
    }
  }
}
```

Your agent gains `analyze_token`, `analyze_wallet` and `watch_poll` as tools it can call
and pay for on its own, plus free tools for checking its wallet balance and learning how to
fund one.

**No wallet yet?** Install it without the `env` block — the free tools work immediately, and
any paid tool will tell your agent exactly how to get funded. See
[`mcp/`](mcp/README.md) for full MCP documentation.

## Quickstart — from HTTP

Any x402-capable client works. Request without payment and you get `HTTP 402` plus the
payment terms in the `payment-required` header:

```bash
curl -X POST https://algorand-inteligence-api-production.up.railway.app/token/analyze \
  -H "Content-Type: application/json" \
  -d '{"asset": "31566704", "chain": "algorand"}'
```

Your client signs a USDC payment, retries, and gets the analysis. Payment is **gasless** —
the [GoPlausible facilitator](https://facilitator.goplausible.xyz) covers Algorand
transaction fees, so you only need USDC to spend.

## Endpoints and pricing

| Route | Price | What you get |
|---|---|---|
| `POST /token/analyze` | $0.05 | Liquidity and lock status, holder concentration, deployer history, rug probability with named signals, verdict |
| `POST /wallet/analyze` | $0.08 | Funding ancestry, behavioral labels, risk score with confidence, verdict |
| `POST /wallet/analyze?depth=deep` | $0.50 | Adds multi-hop funding ancestry and co-funded wallet clusters |
| `POST /watch/poll` | $0.01 | Everything that changed across your watched wallets and tokens since your cursor |
| `GET /` | free | Service card: endpoints, prices, payment terms |
| `GET /fund` | free | How to get a wallet that can pay, as JSON |
| `GET /health` | free | Liveness |

An empty `/watch/poll` result still costs $0.01 — the query ran, and that's the honest
model for polling.

### Request shapes

```jsonc
// POST /token/analyze
{ "asset": "31566704", "chain": "algorand" }   // contract address, or ASA id on Algorand

// POST /wallet/analyze   (add ?depth=deep for the $0.50 tier)
{ "address": "0x28C6...", "chain": "base" }

// POST /watch/poll  — omit cursor on the first call to establish baselines
{ "cursor": "eyJ2IjoxLCJ0Ijo...", "watch": [
    { "type": "wallet", "address": "0xabc...", "chain": "base" },
    { "type": "token", "asset": "31566704", "chain": "algorand" }
] }
```

## Getting a wallet that can pay

Most agents live on Base or Solana and **can't pay on Algorand** — it needs an Algorand
account, a USDC opt-in, and a small ALGO reserve. Circle's CCTP doesn't bridge to Algorand
either, so there's no obvious on-ramp.

This repo ships a free one that works with **any** x402 service on Algorand, not just this
one:

```bash
git clone https://github.com/AlgoIntel01/Algorand-Inteligence-API
cd Algorand-Inteligence-API && npm install
npm run fund-agent                # add --json for machine-readable output
```

It generates a keypair locally, waits while you send native ALGO from any exchange or
wallet, opts into USDC, swaps the spare ALGO into USDC through the Vestige aggregator, and
prints a wallet ready to pay.

**Your keys never leave your machine.** Every swap transaction is decoded and checked
locally before signing — the CLI refuses to sign anything containing a rekey, a close-out,
an unreasonable fee, or an unexpected asset. Use `--dry-run` to see the quote and safety
check without submitting anything.

## Self-hosting

You don't need to host anything to use Verdict — but the source is here if you want your
own deployment.

```bash
npm install
npm run create-wallet    # generates a receiving wallet into .env (gitignored)
# fund the printed address with ~0.3 ALGO, then:
npm run optin-usdca      # opt it into USDC so it can receive payments
npm run dev              # http://localhost:3402
```

Configure via `.env` (see `.env.example`):

| Variable | | Purpose |
|---|---|---|
| `SELLER_ADDRESS` | required | Algorand address that receives payments |
| `NETWORK` | required | `mainnet` or `testnet` |
| `PUBLIC_BASE_URL` | required | Your public URL — agents discover you at this address |
| `FACILITATOR_URL`, `PORT` | | Default to GoPlausible and 3402 |
| `ANTHROPIC_API_KEY` | optional | LLM-written verdicts; without it a deterministic template is used |
| `ETHERSCAN_API_KEY` | optional | Enables BSC wallet analysis (free key) |

### How it fits together

```
Agent → x402 middleware (402 challenge → verify → settle)
      → GoPlausible facilitator (Algorand mainnet, fee abstraction)
      → route handler → cache → chain adapters → heuristics → verdict synthesis
```

| Path | Purpose |
|---|---|
| `src/index.ts` | Hono app, paywalled routes, Bazaar discovery metadata |
| `src/routes/` | Endpoint handlers |
| `src/adapters/` | Chain data: GoPlus (EVM/Solana), Nodely + Vestige (Algorand), Blockscout (EVM wallets) |
| `src/analysis/` | Rug scoring and wallet heuristics |
| `src/watch/` | Snapshots, event log and change detection |
| `src/verdict.ts` | Verdict synthesis, cached by signals hash |
| `mcp/` | The published MCP server |
| `scripts/` | Wallet tooling and the funding rail |

Data comes from GoPlus, the Nodely Algorand indexer, Vestige and Blockscout. Analyses are
cached (10 minutes for tokens, 2 for wallets) and verdicts regenerate only when the
underlying signals change.

## Support and license

Issues and pull requests welcome at
[the repo](https://github.com/AlgoIntel01/Algorand-Inteligence-API/issues). MIT licensed —
the funding rail in particular is meant to be reused by anyone building on Algorand x402.
