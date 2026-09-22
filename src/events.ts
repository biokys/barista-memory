import type { DatabaseSync } from "node:sqlite";

export const EVENT_KINDS = ["equipment", "technique", "maintenance", "beans", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventRow {
  id: number;
  at: number;
  kind: EventKind;
  title: string;
  note: string | null;
  created_at: number;
}

export interface EventInput {
  title: string;
  kind?: string;
  note?: string;
  /** Unix seconds; defaults to now. Backdate for "I actually started last week". */
  at?: number;
}

/** Record a turning point. Title is trimmed; a blank one is refused. */
export function recordEvent(db: DatabaseSync, input: EventInput): EventRow {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("An event needs a title");
  const kind = (EVENT_KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as EventKind) : "other";
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO events (at, kind, title, note, created_at) VALUES (?, ?, ?, ?, ?)").run(
    input.at ?? now, kind, title, input.note?.trim() || null, now
  );
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1").get() as unknown as EventRow;
}

export function updateEvent(db: DatabaseSync, id: number, change: Partial<EventInput>): EventRow | null {
  const existing = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as unknown as EventRow | undefined;
  if (!existing) return null;
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  if (change.title !== undefined) { sets.push("title = ?"); vals.push(change.title.trim() || existing.title); }
  if (change.kind !== undefined) { sets.push("kind = ?"); vals.push((EVENT_KINDS as readonly string[]).includes(change.kind) ? change.kind : "other"); }
  if (change.note !== undefined) { sets.push("note = ?"); vals.push(change.note.trim() || null); }
  if (change.at !== undefined) { sets.push("at = ?"); vals.push(change.at); }
  if (sets.length) db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as unknown as EventRow;
}

export function deleteEvent(db: DatabaseSync, id: number): boolean {
  return db.prepare("DELETE FROM events WHERE id = ?").run(id).changes > 0;
}

export function listEvents(db: DatabaseSync, sinceS?: number, untilS?: number): EventRow[] {
  return db
    .prepare("SELECT * FROM events WHERE at >= ? AND at <= ? ORDER BY at DESC, id DESC")
    .all(sinceS ?? 0, untilS ?? Number.MAX_SAFE_INTEGER) as unknown as EventRow[];
}

/** The event that opened a shot's era, with how many shots have been pulled since it. */
export function eraOf(db: DatabaseSync, startedAt: number): (EventRow & { shots_since: number }) | null {
  const ev = db
    .prepare("SELECT * FROM events WHERE at <= ? ORDER BY at DESC, id DESC LIMIT 1")
    .get(startedAt) as unknown as EventRow | undefined;
  if (!ev) return null;
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM shots WHERE started_at >= ? AND started_at <= ?").get(ev.at, startedAt) as { n: number };
  return { ...ev, shots_since: n };
}
