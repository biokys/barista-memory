import type { DatabaseSync } from "node:sqlite";
import { getNotes, saveNotes, type DeviceNotes } from "./device/client.js";
import type { ShotContextRow } from "./db/db.js";

/**
 * Build the notes object to push to the device for one shot.
 *
 * Two firmware behaviours shape this (ShotHistoryPlugin::updateIndexMetadata):
 *
 *  - `entry.rating = rating` is unconditional, so a save that omits the rating
 *    silently clears whatever rating the shot had. The existing notes are read
 *    first and merged, rather than composing a fresh object.
 *  - `doseOut` is copied into the index as the shot's volume. That volume is a
 *    measurement, so this function never sends doseOut — it writes context the
 *    machine could not know, and leaves everything it measured untouched.
 */
export function buildNotes(existing: DeviceNotes | null, context: ShotContextRow): DeviceNotes {
  const merged: DeviceNotes = { ...(existing ?? {}) };

  // These four fields are derived from the archive, so they are written
  // authoritatively: a value that has gone from the context is removed here
  // too, rather than leaving a stale bean on the machine forever. Everything
  // else the device holds is left alone.
  const owned: Array<[keyof DeviceNotes, string | null]> = [
    ["beanType", context.bean],
    ["doseIn", context.dose_g != null ? String(context.dose_g) : null],
    ["grindSetting", context.grind_setting],
    ["ratio", context.ratio != null ? String(context.ratio) : null],
  ];
  for (const [field, value] of owned) {
    if (value === null || value === "") {
      delete merged[field];
    } else {
      merged[field] = value;
    }
  }

  // The rating is ours only once the shot has been tasted; otherwise whatever
  // the device holds is kept. It must be present either way, because the
  // firmware reads it unconditionally and would reset it to 0.
  if (context.rating != null) merged.rating = context.rating;
  merged.rating = merged.rating ?? 0;

  delete merged.doseOut;
  return merged;
}

/**
 * The archive-side inputs a shot's notes are built from.
 *
 * Only these can change what gets written, so if they match what was last
 * pushed there is nothing to do — and, more to the point, no reason to open a
 * WebSocket to the machine to find that out. Without this check every pass
 * cost one connection per shot on the device, forever.
 */
function fingerprintOf(context: ShotContextRow): string {
  return JSON.stringify([
    context.bean ?? null,
    context.dose_g ?? null,
    context.grind_setting ?? null,
    context.ratio ?? null,
    context.rating ?? null,
  ]);
}

function lastSync(db: DatabaseSync, shotId: number): { payload: string; fingerprint: string | null } | undefined {
  return db.prepare("SELECT payload, fingerprint FROM notes_sync WHERE shot_id = ?").get(shotId) as
    | { payload: string; fingerprint: string | null }
    | undefined;
}

/**
 * Push a shot's derived context into the device's own notes.
 *
 * Returns true when the device was written to, false when the push was skipped
 * (nothing changed, or there is no context worth writing) or the device did not
 * confirm. A failed push is not an error: the archive is the durable record and
 * the next pass will retry.
 */
export async function syncNotes(db: DatabaseSync, context: ShotContextRow): Promise<boolean> {
  if (!context.bean && context.dose_g == null && !context.grind_setting) {
    return false; // No setup covers this shot yet; nothing to say.
  }

  const fingerprint = fingerprintOf(context);
  const previous = lastSync(db, context.id);
  if (previous?.fingerprint === fingerprint) return false;

  const existing = await getNotes(context.id);
  const notes = buildNotes(existing, context);
  const payload = JSON.stringify(notes);

  if (previous?.payload === payload) {
    // Same bytes on the machine already; just remember the inputs so the next
    // pass does not come back here.
    db.prepare("UPDATE notes_sync SET fingerprint = ? WHERE shot_id = ?").run(fingerprint, context.id);
    return false;
  }

  const ok = await saveNotes(context.id, notes);
  if (!ok) return false;

  db.prepare(
    "INSERT INTO notes_sync (shot_id, synced_at, payload, fingerprint) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(shot_id) DO UPDATE SET synced_at = excluded.synced_at, payload = excluded.payload, " +
      "fingerprint = excluded.fingerprint"
  ).run(context.id, Math.floor(Date.now() / 1000), payload, fingerprint);

  return true;
}
