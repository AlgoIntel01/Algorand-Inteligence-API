import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

mkdirSync("data", { recursive: true });
/** Shared SQLite handle — cache here; watch snapshots/events in src/watch/store.ts. */
export const db = new Database("data/cache.db");
db.pragma("journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)",
);

const getStmt = db.prepare("SELECT value, expires_at FROM cache WHERE key = ?");
const setStmt = db.prepare(
  "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
);
const delStmt = db.prepare("DELETE FROM cache WHERE key = ?");

export function getCached<T>(key: string): T | null {
  const row = getStmt.get(key) as { value: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    delStmt.run(key);
    return null;
  }
  return JSON.parse(row.value) as T;
}

export function setCached(key: string, value: unknown, ttlSeconds: number): void {
  setStmt.run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
}
