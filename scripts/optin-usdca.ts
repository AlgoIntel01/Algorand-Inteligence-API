/**
 * Opts the seller account into the USDC ASA so it can receive payments.
 * Reads SELLER_MNEMONIC from .env. Requires the account to hold ~0.2 ALGO first.
 */
import { accountFromKey, optInToUsdca } from "./algo.js";

const mnemonic = process.env.SELLER_MNEMONIC;
if (!mnemonic) {
  console.error("SELLER_MNEMONIC is not set in .env — run `npm run create-wallet` first.");
  process.exit(1);
}

try {
  await optInToUsdca(accountFromKey(mnemonic));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
