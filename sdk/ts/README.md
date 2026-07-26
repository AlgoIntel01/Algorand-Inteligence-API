# verdict-sdk

TypeScript client for
[Algo Verdict API](https://github.com/AlgoIntel01/Algorand-Inteligence-API) — the blockchain
intelligence layer for AI agents, wallets and DeFi. Calls are paid per request in USDC
on Algorand over [x402](https://algorand.co/agentic-commerce/x402/developers). No API key, no
account, no subscription.

```bash
npm install verdict-sdk
```

## Use

```ts
import { VerdictClient } from "verdict-sdk";

const verdict = new VerdictClient({
  privateKey: process.env.ALGORAND_PRIVATE_KEY, // 25-word mnemonic or base64 secret key
});

const token = await verdict.analyzeToken({ asset: "31566704", chain: "algorand" });
console.log(token.rug_probability, token.rug_signals, token.verdict);

const answer = await verdict.ask({ question: "Who has been buying ASA 31566704 this week?" });
console.log(answer.answer);   // prose
console.log(answer.data);     // the structured results it is built from
```

Payment is **gasless** — the facilitator covers Algorand transaction fees, so the wallet needs
USDC but no ALGO beyond the one-time opt-in.

## Methods

| Method | Price | Returns |
|---|---|---|
| `analyzeToken` | $0.05 | Rug probability with named signals, liquidity, holders, verdict |
| `analyzeWallet` | $0.08 / $0.50 deep | Funding ancestry, labels, risk score, clusters |
| `explainTransaction` | $0.02 | What a committed Algorand transaction did, in prose |
| `simulateTransaction` | $0.02 | Whether a group would succeed, and the exact failure |
| `discover` | $0.03 | New launches, trending, volume growth, liquidity moves, fresh LPs |
| `portfolio` | $0.04 | Holdings, valuation, allocation, LP positions, 30-day flows |
| `smartMoney` | $0.10 | Wallets moving an asset, with stated methodology |
| `analyzeContract` | $0.05 | Creator, privileged addresses, TEAL analysis, app TVL |
| `reputation` | $0.02 | Standing score with every component named |
| `ask` | $0.12 | Natural-language question answered from live capability output |
| `watchPoll` | $0.01 | Everything that changed since your cursor |
| `serviceCard`, `fundingGuide`, `health` | free | No payment required |

## Without a wallet

Construct the client with no `privateKey` and the free methods still work. Any paid call throws
`PaymentNotConfiguredError` with instructions rather than failing obscurely:

```ts
const verdict = new VerdictClient();
await verdict.serviceCard();   // fine
await verdict.analyzeToken(…); // throws PaymentNotConfiguredError
```

To get a wallet that can pay, run `npm run fund-agent` from the
[main repository](https://github.com/AlgoIntel01/Algorand-Inteligence-API) — keys are generated
locally and never leave your machine.

## Notes

- Every field a data source cannot provide comes back `null`, never a guess. Check for `null`
  rather than treating a missing value as zero or as an absence of risk.
- `smartMoney` and `reputation` return a `methodology` / `components` block. Read it before
  quoting the numbers — both are explicitly heuristics with stated windows.
- `network` defaults to `"mainnet"`. The client pins the matching algod node automatically; an
  unpinned node would stamp the wrong genesis hash and payments would be rejected.

MIT licensed.
