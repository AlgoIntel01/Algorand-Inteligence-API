# verdict-mcp

MCP server for **Verdict** — cross-chain wallet and token intelligence for AI agents, paid
per call in USDC on Algorand via the [x402](https://x402.org) protocol.

Give your agent the ability to check whether a token is a rug and whether a wallet is
trustworthy, and to pay for those answers itself — no API keys, no accounts, no
subscriptions. Just a wallet.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `analyze_token` | $0.05 | Liquidity + lock status, holder concentration, deployer history, `rug_probability` with the signals behind it, verdict |
| `analyze_wallet` | $0.08 | Funding ancestry, behavioral labels, risk score with confidence, verdict |
| `analyze_wallet` (`depth: "deep"`) | $0.50 | Adds multi-hop funding ancestry and co-funded wallet clusters |
| `watch_poll` | $0.01 | Everything that changed across watched wallets/tokens since your cursor |
| `check_payment_wallet` | free | Wallet address, balances, opt-in status, approximate calls remaining |
| `get_funding_instructions` | free | How to get a wallet that can pay |
| `get_service_info` | free | Endpoints, prices, supported chains |

Chains: tokens on Ethereum, Base, BSC, Solana and Algorand; wallets on Ethereum, Base and
Algorand. Payment always settles in USDC on Algorand.

## Install

```json
{
  "mcpServers": {
    "verdict": {
      "command": "npx",
      "args": ["-y", "verdict-mcp"],
      "env": { "ALGORAND_PRIVATE_KEY": "your 25 word mnemonic here" }
    }
  }
}
```

Add that to your MCP client's config (Claude Desktop: `claude_desktop_config.json`;
Claude Code: `.mcp.json`), then restart the client. Nothing to clone or build.

**No wallet yet?** Install it without the `env` block first — the free tools work
immediately, and any paid tool will tell you exactly how to get funded. Or jump straight
to the funding rail:

```bash
git clone https://github.com/AlgoIntel01/Algorand-Inteligence-API
cd Algorand-Inteligence-API && npm install
npm run fund-agent
```

That generates a wallet locally, waits for you to send native ALGO from any exchange, opts
into USDC and swaps into USDC. Keys never leave your machine. Set the printed mnemonic as
`ALGORAND_PRIVATE_KEY` and you're paying.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ALGORAND_PRIVATE_KEY` | — | 25-word mnemonic or base64 secret key. Without it, paid tools explain how to fund a wallet. |
| `VERDICT_API_URL` | the hosted API | Point at your own deployment |
| `VERDICT_NETWORK` | `mainnet` | `testnet` for testing |

## How payment works

Each paid tool call hits an endpoint that answers `HTTP 402 Payment Required` with payment
terms. This server signs a USDC payment locally, retries, and returns the result — usually
in under two seconds. Your key never leaves the process.

Payments are **gasless**: the [GoPlausible](https://facilitator.goplausible.xyz)
facilitator covers Algorand transaction fees. Your wallet needs USDC to spend, plus a small
one-time ALGO reserve for the USDC opt-in.

## Security

- Your private key is read from the environment and used only to sign payment transactions
  locally. It is never transmitted.
- The server only ever pays the exact amount quoted in the 402 challenge, to the address in
  that challenge.
- Use a **dedicated agent wallet** funded with what you're willing to spend — not your main
  wallet.

## License

MIT. The funding rail is free to use with any x402 service on Algorand, not just this one.
