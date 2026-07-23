/**
 * Generates a fresh Algorand account for receiving USDCa payments and writes
 * SELLER_ADDRESS / SELLER_MNEMONIC to .env (refuses to overwrite existing values).
 *
 * The mnemonic never leaves this machine. Back it up before funding the address.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import algosdk from "algosdk";

const ENV_PATH = ".env";

const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
if (/^SELLER_ADDRESS=.+$/m.test(existing)) {
  console.error(".env already contains a SELLER_ADDRESS — refusing to overwrite it.");
  console.error("Delete or rename the line manually if you really want a new wallet.");
  process.exit(1);
}

const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
const address = account.addr.toString();

let env = existing;
if (env.length > 0 && !env.endsWith("\n")) env += "\n";
env = env.replace(/^SELLER_ADDRESS=$/m, "").replace(/^SELLER_MNEMONIC=$/m, "");
env += `SELLER_ADDRESS=${address}\nSELLER_MNEMONIC=${mnemonic}\n`;
writeFileSync(ENV_PATH, env, { mode: 0o600 });

console.log("Seller wallet created and saved to .env (gitignored).");
console.log(`\n  Address: ${address}\n`);
console.log("Next steps:");
console.log("  1. BACK UP the SELLER_MNEMONIC line from .env somewhere safe.");
console.log("  2. Fund the address with ~0.3 ALGO (covers min balance + the USDCa opt-in fee).");
console.log("  3. Run: npm run optin-usdca");
