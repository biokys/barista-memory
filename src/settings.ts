import type { DatabaseSync } from "node:sqlite";

/** Key/value settings the UI can change; the environment supplies defaults. */
export function getSetting(db: DatabaseSync, key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: DatabaseSync, key: string, value: string | null): void {
  if (value == null || value === "") db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
