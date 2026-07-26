import algosdk from "algosdk";
import { AdapterError } from "./goplus.js";

const INDEXER = "https://mainnet-idx.algonode.cloud";
const ALGOD = "https://mainnet-api.algonode.cloud";
const TIMEOUT_MS = 20_000;

export interface GlobalStateEntry {
  key: string;
  type: "bytes" | "uint";
  value: string | number;
  /** Set when a 32-byte value decodes to a valid Algorand address. */
  address: string | null;
}

export interface ApplicationInfo {
  appId: number;
  creator: string | null;
  createdAtRound: number | null;
  deleted: boolean;
  approvalProgram: string | null;
  globalState: GlobalStateEntry[];
  globalSchema: { uints: number | null; byteSlices: number | null };
  localSchema: { uints: number | null; byteSlices: number | null };
  extraProgramPages: number | null;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AdapterError(`nodely request failed: ${String(err)}`, "nodely");
  }
  if (res.status === 404) throw new AdapterError("application not found", "nodely");
  if (!res.ok) throw new AdapterError(`nodely HTTP ${res.status}`, "nodely");
  return (await res.json()) as Record<string, unknown>;
}

const decodeKey = (b64: string): string => {
  const raw = Buffer.from(b64, "base64");
  // Most contracts use readable ASCII keys; anything else stays as hex so the
  // caller sees the real key rather than mojibake.
  return /^[\x20-\x7e]+$/.test(raw.toString("utf8")) ? raw.toString("utf8") : `0x${raw.toString("hex")}`;
};

/**
 * A 32-byte global-state value is very often an admin address — Algorand
 * contracts keep their privileged keys in global state. Anything else is left
 * as-is rather than forced into an address shape.
 */
function asAddress(b64: string): string | null {
  try {
    const raw = Buffer.from(b64, "base64");
    if (raw.length !== 32) return null;
    return algosdk.encodeAddress(new Uint8Array(raw));
  } catch {
    return null;
  }
}

export async function fetchApplication(appId: number): Promise<ApplicationInfo | null> {
  let body: Record<string, unknown>;
  try {
    body = await getJson(`${INDEXER}/v2/applications/${appId}`);
  } catch (err) {
    if (err instanceof AdapterError && err.message.includes("not found")) return null;
    throw err;
  }

  const application = (body.application ?? {}) as Record<string, unknown>;
  if (Object.keys(application).length === 0) return null;
  const params = (application.params ?? {}) as Record<string, unknown>;

  const globalState: GlobalStateEntry[] = [];
  for (const raw of (params["global-state"] ?? []) as Array<Record<string, unknown>>) {
    const value = (raw.value ?? {}) as Record<string, unknown>;
    const isBytes = Number(value.type) === 1;
    const bytes = typeof value.bytes === "string" ? value.bytes : "";
    globalState.push({
      key: decodeKey(String(raw.key ?? "")),
      type: isBytes ? "bytes" : "uint",
      value: isBytes ? bytes : Number(value.uint ?? 0),
      address: isBytes ? asAddress(bytes) : null,
    });
  }

  const schema = (source: unknown): { uints: number | null; byteSlices: number | null } => {
    const record = (source ?? {}) as Record<string, unknown>;
    return {
      uints: typeof record["num-uint"] === "number" ? record["num-uint"] : null,
      byteSlices: typeof record["num-byte-slice"] === "number" ? record["num-byte-slice"] : null,
    };
  };

  return {
    appId,
    creator: typeof params.creator === "string" ? params.creator : null,
    createdAtRound:
      typeof application["created-at-round"] === "number" ? application["created-at-round"] : null,
    deleted: application.deleted === true,
    approvalProgram: typeof params["approval-program"] === "string" ? params["approval-program"] : null,
    globalState,
    globalSchema: schema(params["global-state-schema"]),
    localSchema: schema(params["local-state-schema"]),
    extraProgramPages:
      typeof params["extra-program-pages"] === "number" ? params["extra-program-pages"] : null,
  };
}

/** The account an application controls, which is where its TVL sits. */
export function applicationAccount(appId: number): string {
  return algosdk.getApplicationAddress(appId).toString();
}

/**
 * Disassemble an approval program into TEAL. Public nodes expose this only when
 * the developer API is enabled, so a null return means "could not read", never
 * "the contract does nothing".
 */
export async function disassembleProgram(programBase64: string): Promise<string | null> {
  try {
    const res = await fetch(`${ALGOD}/v2/teal/disassemble`, {
      method: "POST",
      headers: { "Content-Type": "application/x-binary" },
      body: new Uint8Array(Buffer.from(programBase64, "base64")),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: string };
    return typeof body.result === "string" ? body.result : null;
  } catch {
    return null;
  }
}
