import type { Chain } from "../config.js";

/**
 * Best-effort curated labels for well-known addresses, used to classify funding
 * sources. This is a heuristic aid, NOT an exhaustive registry — absence of a
 * label never means an address is clean, and entries should be treated as
 * "widely attributed to" rather than authoritative. EVM addresses lowercase.
 */
export interface KnownAddress {
  label: "cex" | "mixer" | "bridge" | "burn";
  name: string;
}

const EVM: Record<string, KnownAddress> = {
  // Binance hot wallets (used across ethereum and bsc)
  "0x28c6c06298d514db089934071355e5743bf21d60": { label: "cex", name: "Binance" },
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": { label: "cex", name: "Binance" },
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": { label: "cex", name: "Binance" },
  "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be": { label: "cex", name: "Binance" },
  "0x9696f59e4d72e237be84ffd425dcad154bf96976": { label: "cex", name: "Binance" },
  // Coinbase
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": { label: "cex", name: "Coinbase" },
  "0x503828976d22510aad0201ac7ec88293211d23da": { label: "cex", name: "Coinbase" },
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": { label: "cex", name: "Coinbase" },
  "0x3cd751e6b0078be393132286c442345e5dc49699": { label: "cex", name: "Coinbase" },
  // Kraken
  "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": { label: "cex", name: "Kraken" },
  "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13": { label: "cex", name: "Kraken" },
  // OKX
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": { label: "cex", name: "OKX" },
  "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": { label: "cex", name: "OKX" },
  // Bybit
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": { label: "cex", name: "Bybit" },
  // Tornado Cash (ethereum) — router, proxy, and common pools
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b": { label: "mixer", name: "Tornado Cash Router" },
  "0x722122df12d4e14e13ac3b6895a86e84145b6967": { label: "mixer", name: "Tornado Cash Proxy" },
  "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc": { label: "mixer", name: "Tornado Cash 0.1 ETH" },
  "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936": { label: "mixer", name: "Tornado Cash 1 ETH" },
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf": { label: "mixer", name: "Tornado Cash 10 ETH" },
  "0xa160cdab225685da1d56aa342ad8841c3b53f291": { label: "mixer", name: "Tornado Cash 100 ETH" },
};

const ALGORAND: Record<string, KnownAddress> = {
  // The all-zero public key. No private key exists for it, so anything sent here
  // is unrecoverable — Algorand's de facto burn address.
  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ: {
    label: "burn",
    name: "Zero address (unspendable)",
  },
  // Widely attributed Binance hot address on Algorand (verified to exist on-chain
  // since 2020; attribution is community consensus, not an official statement).
  ZW3ISEHZUHPO7OZGMKLKIIMKVICOUDRCERI454I3DB2BH52HGLSO67W754: { label: "cex", name: "Binance" },
};

/** Look up a known label for an address on a chain. */
export function lookupKnownAddress(address: string, chain: Chain): KnownAddress | null {
  if (chain === "algorand") return ALGORAND[address] ?? null;
  return EVM[address.toLowerCase()] ?? null;
}
