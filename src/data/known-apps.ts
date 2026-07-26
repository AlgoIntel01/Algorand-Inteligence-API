/**
 * Curated labels for Algorand applications, used to name the protocol a
 * transaction interacted with. Like the address registry, this is a heuristic
 * aid and NOT exhaustive: an unlabelled app id means "we cannot attribute this
 * confidently", never "this is unknown to everyone" or "this is unsafe".
 *
 * Entries here are limited to protocols that route every pool through a single
 * validator application, verified against Vestige's own pool records. Protocols
 * that deploy one application per pool (Pact, HumbleSwap, Algofi) cannot be
 * covered by a static registry, so transactions touching them report the raw
 * application id and a null protocol rather than a guess.
 */
export interface KnownApp {
  name: string;
  kind: "amm";
  url: string;
}

const APPS: Record<number, KnownApp> = {
  552635992: { name: "Tinyman v1.1", kind: "amm", url: "https://tinyman.org" },
  1002541853: { name: "Tinyman v2.0", kind: "amm", url: "https://tinyman.org" },
};

export function lookupApp(appId: number): KnownApp | null {
  return APPS[appId] ?? null;
}
