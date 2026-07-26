const NFD = "https://api.nf.domains";
const TIMEOUT_MS = 10_000;

export interface NfdIdentity {
  name: string;
  /** Social handles the owner has verified through NFD, if any. */
  verified: string[];
}

/**
 * NFDomains name for an address, if it owns one.
 *
 * Coverage is limited to addresses that hold a .algo name, so an absent name is
 * the common case and means nothing on its own — this is an identity signal
 * where one exists, never a general social graph. A 404 is a normal answer, not
 * an error.
 */
export async function fetchNfd(address: string): Promise<NfdIdentity | null> {
  let res: Response;
  try {
    res = await fetch(
      `${NFD}/nfd/lookup?address=${encodeURIComponent(address)}&view=full`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  // The lookup returns a map keyed by address when a name exists.
  const record = (body as Record<string, unknown>)?.[address] ?? body;
  if (!record || typeof record !== "object") return null;
  const entry = record as Record<string, unknown>;
  const name = typeof entry.name === "string" ? entry.name : null;
  if (name === null) return null;

  const properties = (entry.properties ?? {}) as Record<string, unknown>;
  const verified = (properties.verified ?? {}) as Record<string, unknown>;
  return { name, verified: Object.keys(verified) };
}
