import { SUPPORTED_CHAINS, type Chain } from "./config.js";

export class ValidationError extends Error {}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`"${field}" is required and must be a non-empty string`);
  }
  return value;
}

export function requireChain(body: Record<string, unknown>): Chain {
  const value = requireString(body, "chain");
  if (!SUPPORTED_CHAINS.includes(value as Chain)) {
    throw new ValidationError(
      `"chain" must be one of: ${SUPPORTED_CHAINS.join(", ")}`,
    );
  }
  return value as Chain;
}

export async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Same, but an absent or empty body is valid and means "no options". For routes
 * where every parameter is optional, requiring `{}` would be a pointless hurdle
 * for an agent calling the endpoint for the first time.
 */
export async function parseOptionalJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = (await req.text()).trim();
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
