import { db } from "../cache.js";

/**
 * Watch state: global snapshots (last-known state per target) and an event log.
 * Both are shared across all subscribers — the world's state is computed once;
 * each subscriber reads events newer than its own cursor.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS watch_snapshots (
    target TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS watch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_watch_events_target_ts ON watch_events (target, ts);
`);

const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

const getSnapshotStmt = db.prepare("SELECT value FROM watch_snapshots WHERE target = ?");
const setSnapshotStmt = db.prepare(
  "INSERT INTO watch_snapshots (target, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(target) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
);
const insertEventStmt = db.prepare(
  "INSERT INTO watch_events (target, ts, type, detail) VALUES (?, ?, ?, ?)",
);
const eventsSinceStmt = db.prepare(
  "SELECT ts, type, detail FROM watch_events WHERE target = ? AND ts > ? ORDER BY ts ASC",
);
const pruneStmt = db.prepare("DELETE FROM watch_events WHERE ts < ?");

export function getSnapshot<T>(target: string): T | null {
  const row = getSnapshotStmt.get(target) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setSnapshot(target: string, value: unknown): void {
  setSnapshotStmt.run(target, JSON.stringify(value), Date.now());
}

export function appendEvent(target: string, type: string, detail: unknown): void {
  insertEventStmt.run(target, Date.now(), type, JSON.stringify(detail));
}

export function eventsSince(
  target: string,
  sinceMs: number,
): Array<{ ts: number; type: string; detail: unknown }> {
  const rows = eventsSinceStmt.all(target, sinceMs) as Array<{
    ts: number;
    type: string;
    detail: string;
  }>;
  return rows.map((r) => ({ ts: r.ts, type: r.type, detail: JSON.parse(r.detail) }));
}

export function pruneOldEvents(): void {
  pruneStmt.run(Date.now() - EVENT_RETENTION_MS);
}
