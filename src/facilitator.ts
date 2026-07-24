import { HTTPFacilitatorClient } from "@x402-avm/core/server";
import type { FacilitatorClient } from "@x402-avm/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "@x402-avm/core/types";

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
