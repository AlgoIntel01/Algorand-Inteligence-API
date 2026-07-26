# Examples

Three programs that use Verdict for real. Each one pays per call in USDC on Algorand, and each
degrades to funding instructions rather than a stack trace when no wallet is configured.

| Example | What it shows |
|---|---|
| [`ai-agent/`](ai-agent) | An agent applying its own risk rules before it trades, refusing anything it could not measure |
| [`portfolio-tracker/`](portfolio-tracker) | Valuation, allocation and per-asset deltas across repeated polls |
| [`telegram-bot/`](telegram-bot) | A chat bot that answers token, wallet, transaction and free-form questions |

## Running any of them

```bash
cd examples/ai-agent          # or portfolio-tracker, telegram-bot
npm install                   # pulls verdict-sdk from npm
export ALGORAND_PRIVATE_KEY="your 25 word mnemonic"
node agent.mjs 31566704
```

No wallet yet? Run `npm run fund-agent` from the repository root — it generates one locally, and
your keys never leave your machine. Without a key these examples tell you that and exit cleanly,
so you can run them before funding anything.

Point them at a local server with `VERDICT_URL=http://localhost:3402`.
