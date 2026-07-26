import { HTTPFacilitatorClient } from "@x402-avm/core/server";
import type { FacilitatorClient } from "@x402-avm/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "@x402-avm/core/types";
import { config } from "./config.js";

/**
 * Facilitator reachability, cached so a monitor polling every few seconds does
 * not turn into load on someone else's server.
 */
const PROBE_TTL_MS = 30_000;
/** Short: this runs inside a health request that must answer promptly. */
const PROBE_TIMEOUT_MS = 4_000;

export interface FacilitatorHealth {
  url: string;
  reachable: boolean;
  checked_at: string;
  /** Why it is unreachable, when it is. */
  detail: string | null;
  /** True when the answer came from cache rather than a fresh probe. */
  cached: boolean;
}

let probe: { health: FacilitatorHealth; at: number } | null = null;

/**
 * Is the facilitator answering?
 *
 * This matters more than it looks. The payment middleware loads its supported
 * payment kinds from the facilitator on first use, and if that fetch fails every
 * paid route returns an opaque 500 — while a naive health check that only reports
 * process liveness keeps saying everything is fine. Observed in practice.
 *
 * The probe hits `/supported`, the same path the middleware depends on, so a pass
 * here means the middleware's own dependency is answering rather than merely that
 * the host resolves.
 */
export async function checkFacilitator(): Promise<FacilitatorHealth> {
  const now = Date.now();
  if (probe !== null && now - probe.at < PROBE_TTL_MS) {
    return { ...probe.health, cached: true };
  }

  let health: FacilitatorHealth;
  try {
    const res = await fetch(`${config.facilitatorUrl}/supported`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    health = {
      url: config.facilitatorUrl,
      reachable: res.ok,
      checked_at: new Date(now).toISOString(),
      detail: res.ok ? null : `HTTP ${res.status}`,
      cached: false,
    };
  } catch (err) {
    health = {
      url: config.facilitatorUrl,
      reachable: false,
      checked_at: new Date(now).toISOString(),
      detail: err instanceof Error ? err.message : String(err),
      cached: false,
    };
  }

  probe = { health, at: now };
  return health;
}

/**
 * Wraps a facilitator client so verify/settle outcomes are logged server-side.
 * A 402 with an empty body on the client tells you nothing; the facilitator's
 * invalidReason / errorReason tells you exactly why a payment was rejected.
 */
export function loggingFacilitator(inner: HTTPFacilitatorClient): FacilitatorClient {
  return {
    async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
      const res = await inner.verify(payload, requirements);
      if (res.isValid) {
        console.log(`[facilitator.verify] ok (payer ${res.payer ?? "?"})`);
      } else {
        console.error(
          `[facilitator.verify] REJECTED: ${res.invalidReason ?? "?"} — ${res.invalidMessage ?? ""}`,
        );
      }
      return res;
    },
    async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
      const res = await inner.settle(payload, requirements);
      if (res.success) {
        console.log(`[facilitator.settle] ok: txid ${res.transaction} (payer ${res.payer ?? "?"})`);
      } else {
        console.error(
          `[facilitator.settle] FAILED: ${res.errorReason ?? "?"} — ${res.errorMessage ?? ""}`,
        );
      }
      return res;
    },
    getSupported() {
      return inner.getSupported();
    },
  };
}
