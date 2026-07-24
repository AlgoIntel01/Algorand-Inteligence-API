import { Hono } from "hono";
import { parseJsonBody, requireChain, requireString, ValidationError } from "../validate.js";
import type { WatchPollResponse, WatchTarget } from "../types.js";
import { processPoll } from "../watch/engine.js";

export const watch = new Hono();

const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BASELINE_NOTE =
  "First poll: baselines established for your targets; deltas begin from this cursor.";
const STALE_CURSOR_NOTE =
  "Cursor older than 24h — token events beyond retention were truncated; wallet activity still covers the full window.";

interface CursorPayload {
  v: 1;
  t: number; // ms epoch of the previous poll
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.v === 1 && typeof parsed.t === "number") return parsed as CursorPayload;
    return null;
  } catch {
    return null;
  }
}

function parseWatchTargets(raw: unknown): WatchTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('"watch" must be a non-empty array of targets');
  }
  if (raw.length > 100) {
    throw new ValidationError('"watch" may contain at most 100 targets per poll');
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ValidationError(`watch[${i}] must be an object`);
    }
    const target = entry as Record<string, unknown>;
    const chain = requireChain(target);
    if (target.type === "wallet") {
      return { type: "wallet", address: requireString(target, "address"), chain };
    }
    if (target.type === "token") {
      return { type: "token", asset: requireString(target, "asset"), chain };
    }
    throw new ValidationError(`watch[${i}].type must be "wallet" or "token"`);
  });
}

watch.post("/poll", async (c) => {
  let targets: WatchTarget[];
  let cursor: CursorPayload | null = null;
  try {
    const body = await parseJsonBody(c.req.raw);
    targets = parseWatchTargets(body.watch);
    if (body.cursor !== undefined) {
      if (typeof body.cursor !== "string") {
        throw new ValidationError('"cursor" must be a string when provided');
      }
      cursor = decodeCursor(body.cursor);
      if (cursor === null) {
        throw new ValidationError('"cursor" is not a cursor issued by this API');
      }
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    throw err;
  }

  const now = Date.now();
  const sinceMs = cursor?.t ?? null;
  const { changes, warnings } = await processPoll(targets, sinceMs);

  const response: WatchPollResponse = {
    status: "ok",
    cursor: encodeCursor({ v: 1, t: now }),
    since: sinceMs !== null ? new Date(sinceMs).toISOString() : null,
    now: new Date(now).toISOString(),
    watched: targets.length,
    changes,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(sinceMs === null
      ? { note: BASELINE_NOTE }
      : now - sinceMs > CURSOR_MAX_AGE_MS
        ? { note: STALE_CURSOR_NOTE }
        : {}),
  };
  return c.json(response);
});
