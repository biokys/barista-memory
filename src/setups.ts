import type { DatabaseSync } from "node:sqlite";
import { currentSetup, type SetupRow } from "./db/db.js";

export interface SetupChange {
  bean?: string;
  roaster?: string;
  roast_date?: string;
  grind_setting?: string;
  dose_g?: number;
  basket?: string;
  note?: string;
  /** When the change took effect; defaults to now. */
  valid_from?: number;
}

const INHERITED = ["bean", "roaster", "roast_date", "grind_setting", "dose_g", "basket"] as const;

/**
 * Open a new setup period, carrying forward everything the caller did not name.
 *
 * This is what makes the whole scheme worth using: changing the grind is one
 * field, and the beans, dose and basket stay as they were. Passing a field
 * explicitly as null clears it.
 */
export function recordSetup(db: DatabaseSync, change: SetupChange): SetupRow {
  const previous = currentSetup(db);
  const now = Math.floor(Date.now() / 1000);
  // Recorded as-is. An earlier version nudged a colliding valid_from forward by
  // a second, which put the new setup one second into the future and made it
  // invisible to "what is current" until that second passed — two quick changes
  // in a row showed the older one. Ties are broken by id instead, so the setup
  // recorded later wins without touching the clock.
  const validFrom = change.valid_from ?? now;

  const merged: Record<string, unknown> = {};
  for (const field of INHERITED) {
    const value = field in change ? (change as any)[field] : previous?.[field] ?? null;
    // Bean and roaster arrive from text fields, where a trailing space is easy
    // to leave behind and would split one coffee into two when grouping shots.
    merged[field] = typeof value === "string" ? value.trim() || null : value;
  }

  // A change that changes nothing opens no period. The controls panel always
  // sends its current grind, so pressing the button twice — or pressing it for
  // a bean edit — must not litter the history with identical periods that a
  // later correction would then have to be applied to one by one.
  if (previous && change.note === undefined) {
    const unchanged = INHERITED.every((field) => merged[field] === previous[field]);
    if (unchanged) return previous;
  }

  db.prepare(
    `INSERT INTO setups (valid_from, bean, roaster, roast_date, grind_setting, dose_g, basket, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    validFrom,
    merged.bean as string | null,
    merged.roaster as string | null,
    merged.roast_date as string | null,
    merged.grind_setting as string | null,
    merged.dose_g as number | null,
    merged.basket as string | null,
    change.note ?? null,
    now
  );

  return db.prepare("SELECT * FROM setups ORDER BY id DESC LIMIT 1").get() as unknown as SetupRow;
}

/** Move an existing setup's start, for correcting when a change really happened. */
export function moveSetup(db: DatabaseSync, setupId: number, validFrom: number): SetupRow | null {
  const exists = db.prepare("SELECT 1 FROM setups WHERE id = ?").get(setupId);
  if (!exists) return null;
  db.prepare("UPDATE setups SET valid_from = ? WHERE id = ?").run(validFrom, setupId);
  return db.prepare("SELECT * FROM setups WHERE id = ?").get(setupId) as unknown as SetupRow;
}

const EDITABLE = ["bean", "roaster", "roast_date", "grind_setting", "dose_g", "basket", "note"] as const;

/**
 * Correct the values of an existing setup period.
 *
 * Distinct from recordSetup: that opens a new period because something actually
 * changed at the grinder, whereas this fixes a period that was recorded wrong —
 * a typo, or a value entered on the wrong scale. Every shot in the period
 * re-derives, which is the point.
 */
export function updateSetup(db: DatabaseSync, setupId: number, change: SetupChange): SetupRow | null {
  const existing = db.prepare("SELECT * FROM setups WHERE id = ?").get(setupId) as unknown as SetupRow | undefined;
  if (!existing) return null;

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  for (const field of EDITABLE) {
    if (!(field in change)) continue;
    const raw = (change as any)[field];
    assignments.push(`${field} = ?`);
    values.push(typeof raw === "string" ? raw.trim() || null : (raw ?? null));
  }
  if (change.valid_from !== undefined) {
    assignments.push("valid_from = ?");
    values.push(change.valid_from);
  }
  if (assignments.length === 0) return existing;

  db.prepare(`UPDATE setups SET ${assignments.join(", ")} WHERE id = ?`).run(...values, setupId);
  return db.prepare("SELECT * FROM setups WHERE id = ?").get(setupId) as unknown as SetupRow;
}
