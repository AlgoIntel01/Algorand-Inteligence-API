/**
 * Generates a fresh, throwaway buyer account for paying the API in tests and
 * writes BUYER_PRIVATE_KEY_B64 (as a mnemonic) to .env. Refuses to overwrite an
 * existing buyer key. This account is separate from the seller — never pay your
 * own endpoint from the seller wallet (the contest voids self-payments).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import algosdk from "algosdk";

const ENV_PATH = ".env";
const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";

if (/^BUYER_PRIVATE_KEY_B64=.+$/m.test(existing)) {
  console.error(".env already contains a BUYER_PRIVATE_KEY_B64 — refusing to overwrite it.");
  console.error("Delete or blank that line manually if you want a new buyer wallet.");
  process.exit(1);
}

const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
const address = account.addr.toString();

let env = existing;
if (/^BUYER_PRIVATE_KEY_B64=\s*$/m.test(env)) {
  env = env.replace(/^BUYER_PRIVATE_KEY_B64=\s*$/m, `BUYER_PRIVATE_KEY_B64=${mnemonic}`);
} else {
  if (env.length > 0 && !env.endsWith("\n")) env += "\n";
  env += `BUYER_PRIVATE_KEY_B64=${mnemonic}\n`;
}
writeFileSync(ENV_PATH, env, { mode: 0o600 });

console.log("Buyer wallet created and saved to .env (gitignored).");
console.log(`\n  Address: ${address}\n`);
console.log("Next steps:");
console.log("  1. BACK UP the BUYER_PRIVATE_KEY_B64 line from .env if you care about the funds.");
console.log("  2. Fund the address with ~0.2 ALGO (for the opt-in) plus some USDCa (to spend).");
console.log("  3. Run: npm run optin-buyer");
console.log("  4. Run: npm run test-client   (pays a real $0.01 call to your API)");
