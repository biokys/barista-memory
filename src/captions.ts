import type { DatabaseSync } from "node:sqlite";

/**
 * A line of free text printed on a shot's receipt. The user writes it on the
 * shot page or asks the assistant to; the daemon can also ask the assistant
 * for one before the automatic print, when that setting is on.
 */

/** Three centred lines at 16 px on the 384 px strip; longer runs off the point of a receipt. */
export const CAPTION_MAX_CHARS = 160;

export type CaptionSource = "user" | "assistant";

export interface Caption {
  shot_id: number;
  text: string;
  source: CaptionSource;
  created_at: number;
}

export function getCaption(db: DatabaseSync, shotId: number): Caption | null {
  return (db.prepare("SELECT shot_id, text, source, created_at FROM shot_captions WHERE shot_id = ?").get(shotId) as Caption | undefined) ?? null;
}

/** Collapse line breaks and runs of spaces: the receipt wraps the text itself. */
export function normaliseCaption(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Store a caption, replacing any earlier one; an empty text removes it.
 * Throws with a code-like message on an unknown shot or an over-long text,
 * so the web route and the tool can report it verbatim.
 */
export function setCaption(db: DatabaseSync, shotId: number, text: string, source: CaptionSource): Caption | null {
  if (!db.prepare("SELECT 1 FROM shots WHERE id = ?").get(shotId)) throw new Error(`Shot ${shotId} is not in the archive`);
  const clean = normaliseCaption(text);
  if (!clean) {
    db.prepare("DELETE FROM shot_captions WHERE shot_id = ?").run(shotId);
    return null;
  }
  if (clean.length > CAPTION_MAX_CHARS) throw new Error(`Caption is ${clean.length} characters; the receipt takes ${CAPTION_MAX_CHARS}`);
  db.prepare(
    "INSERT INTO shot_captions (shot_id, text, source, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(shot_id) DO UPDATE SET text = excluded.text, source = excluded.source, created_at = excluded.created_at"
  ).run(shotId, clean, source, Math.floor(Date.now() / 1000));
  return getCaption(db, shotId);
}
