/**
 * Opts the buyer account into the USDC ASA. Reads BUYER_PRIVATE_KEY_B64 from
 * .env (a 25-word mnemonic or a base64 secret key). Requires ~0.2 ALGO first.
 */
import { accountFromKey, optInToUsdca } from "./algo.js";

const key = process.env.BUYER_PRIVATE_KEY_B64;
if (!key) {
  console.error("BUYER_PRIVATE_KEY_B64 is not set in .env.");
  console.error("Run `npm run create-buyer`, or paste an existing wallet's mnemonic into that line.");
  process.exit(1);
}

try {
  await optInToUsdca(accountFromKey(key));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
