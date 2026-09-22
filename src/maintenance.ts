import type { DatabaseSync } from "node:sqlite";
import type { ShotSample } from "./device/parsers/binaryShot.js";

export const MAINTENANCE_KEYS = ["backflush", "cafiza", "descale", "water_filter", "gasket"] as const;
export type MaintenanceKey = (typeof MAINTENANCE_KEYS)[number];

export interface MaintenanceType {
  key: MaintenanceKey;
  sort: number;
  enabled: number;
  interval_shots: number | null;
  interval_water_l: number | null;
  interval_days: number | null;
}

export interface MaintenanceLogRow {
  id: number;
  type_key: MaintenanceKey;
  at: number;
  note: string | null;
  auto: number;
  shot_id: number | null;
  created_at: number;
}

/**
 * Which log entries satisfy which routine. A Cafiza run is a backflush with
 * chemistry, so it resets the plain backflush too; nothing else overlaps.
 */
const SATISFIED_BY: Record<MaintenanceKey, MaintenanceKey[]> = {
  backflush: ["backflush", "cafiza"],
  cafiza: ["cafiza"],
  descale: ["descale"],
  water_filter: ["water_filter"],
  gasket: ["gasket"],
};

export interface MaintenanceStatus {
  key: MaintenanceKey;
  enabled: boolean;
  last_at: number | null;
  last_auto: boolean;
  /** Since the last time: what has been used up, per applicable dimension. */
  shots_since: number | null;
  water_l_since: number | null;
  days_since: number | null;
  interval_shots: number | null;
  interval_water_l: number | null;
  interval_days: number | null;
  /** Worst-case fraction of the interval used, 0–∞; null when never logged. */
  fraction: number | null;
  state: "never" | "ok" | "soon" | "due";
}

/** At what fraction of the interval a routine is flagged as coming up. */
const SOON_AT = 0.8;

/**
 * Where every routine stands, computed from the archive: the last log entry
 * that satisfies it, and how much coffee, water or time has gone by since.
 * Nothing here is stored, so a corrected interval or a backdated entry is
 * reflected at once.
 */
export function maintenanceStatus(db: DatabaseSync, now = Math.floor(Date.now() / 1000)): MaintenanceStatus[] {
  const types = db.prepare("SELECT * FROM maintenance_types ORDER BY sort").all() as unknown as MaintenanceType[];
  const lastOf = db.prepare(
    "SELECT at, auto FROM maintenance_log WHERE type_key IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id DESC LIMIT 1"
  );
  const shotsSince = db.prepare("SELECT COUNT(*) AS n FROM shots WHERE kind = 'shot' AND started_at > ?");
  const waterSince = db.prepare("SELECT COALESCE(SUM(water_ml), 0) AS ml FROM shots WHERE started_at > ?");

  return types.map((type) => {
    const last = lastOf.get(JSON.stringify(SATISFIED_BY[type.key])) as { at: number; auto: number } | undefined;
    const since = last?.at ?? 0;
    const shots = type.interval_shots != null ? (shotsSince.get(since) as { n: number }).n : null;
    const water = type.interval_water_l != null ? (waterSince.get(since) as { ml: number }).ml / 1000 : null;
    const days = type.interval_days != null && last ? (now - last.at) / 86400 : null;

    const fractions = [
      shots != null && type.interval_shots ? shots / type.interval_shots : null,
      water != null && type.interval_water_l ? water / type.interval_water_l : null,
      days != null && type.interval_days ? days / type.interval_days : null,
    ].filter((f): f is number => f != null);
    const fraction = last ? (fractions.length ? Math.max(...fractions) : 0) : null;

    return {
      key: type.key,
      enabled: type.enabled === 1,
      last_at: last?.at ?? null,
      last_auto: last?.auto === 1,
      shots_since: last ? shots : null,
      water_l_since: last && water != null ? Math.round(water * 10) / 10 : null,
      days_since: days != null ? Math.floor(days) : null,
      interval_shots: type.interval_shots,
      interval_water_l: type.interval_water_l,
      interval_days: type.interval_days,
      fraction: fraction != null ? Math.round(fraction * 100) / 100 : null,
      state: fraction == null ? "never" : fraction >= 1 ? "due" : fraction >= SOON_AT ? "soon" : "ok",
    };
  });
}

export function logMaintenance(
  db: DatabaseSync,
  key: string,
  opts: { at?: number; note?: string; auto?: boolean; shot_id?: number } = {}
): MaintenanceLogRow {
  if (!(MAINTENANCE_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown maintenance type "${key}"`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO maintenance_log (type_key, at, note, auto, shot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, opts.at ?? now, opts.note?.trim() || null, opts.auto ? 1 : 0, opts.shot_id ?? null, now);
  return db.prepare("SELECT * FROM maintenance_log ORDER BY id DESC LIMIT 1").get() as unknown as MaintenanceLogRow;
}

export function listMaintenanceLog(db: DatabaseSync, limit = 50): MaintenanceLogRow[] {
  return db.prepare("SELECT * FROM maintenance_log ORDER BY at DESC, id DESC LIMIT ?").all(limit) as unknown as MaintenanceLogRow[];
}

export function deleteMaintenanceLog(db: DatabaseSync, id: number): boolean {
  return db.prepare("DELETE FROM maintenance_log WHERE id = ?").run(id).changes > 0;
}

/** Re-label the most recent automatic flush as a Cafiza run: same run, chemistry added. */
export function markLastFlushAsCafiza(db: DatabaseSync): MaintenanceLogRow | null {
  const last = db
    .prepare("SELECT * FROM maintenance_log WHERE type_key = 'backflush' AND auto = 1 ORDER BY at DESC, id DESC LIMIT 1")
    .get() as unknown as MaintenanceLogRow | undefined;
  if (!last) return null;
  db.prepare("UPDATE maintenance_log SET type_key = 'cafiza' WHERE id = ?").run(last.id);
  return db.prepare("SELECT * FROM maintenance_log WHERE id = ?").get(last.id) as unknown as MaintenanceLogRow;
}

export function updateMaintenanceType(
  db: DatabaseSync,
  key: string,
  change: Partial<Pick<MaintenanceType, "enabled" | "interval_shots" | "interval_water_l" | "interval_days">>
): MaintenanceType | null {
  if (!(MAINTENANCE_KEYS as readonly string[]).includes(key)) return null;
  const sets: string[] = []; const vals: Array<number | null> = [];
  for (const field of ["enabled", "interval_shots", "interval_water_l", "interval_days"] as const) {
    if (change[field] !== undefined) { sets.push(`${field} = ?`); vals.push(change[field] as number | null); }
  }
  if (sets.length) db.prepare(`UPDATE maintenance_types SET ${sets.join(", ")} WHERE key = ?`).run(...vals, key);
  return db.prepare("SELECT * FROM maintenance_types WHERE key = ?").get(key) as unknown as MaintenanceType;
}

/**
 * Is a run on this profile a flush rather than a coffee? The machine's own
 * utility flag decides; the name is the fallback for when the machine could
 * not be asked.
 */
export function isFlushProfile(profileName: string | null, utilityProfileIds: Set<string> | null, profileId: string | null): boolean {
  if (utilityProfileIds && profileId) return utilityProfileIds.has(profileId);
  return /backflush|flush|proplach|clean/i.test(profileName ?? "");
}

/**
 * Water pumped during a run, integrated from the pump-flow trace (ml/s). This
 * is what wears the boiler, so descaling counts it rather than shots: a long
 * pre-infusion profile moves more water than a short ristretto.
 */
export function pumpedWaterMl(samples: ShotSample[]): number | null {
  let ml = 0;
  let last: { t: number; fl: number } | null = null;
  let seen = false;
  for (const sample of samples) {
    if (typeof sample.t !== "number" || typeof sample.fl !== "number") continue;
    seen = true;
    const t = sample.t / 1000;
    if (last) ml += Math.max(0, last.fl) * Math.max(0, t - last.t);
    last = { t, fl: sample.fl };
  }
  return seen ? Math.round(ml) : null;
}

/** Ids of the machine's utility profiles, or null when it could not be asked. */
export async function utilityProfileIds(): Promise<Set<string> | null> {
  const { listProfiles } = await import("./device/client.js");
  const profiles = await listProfiles();
  return profiles ? new Set(profiles.filter((p) => p.utility).map((p) => p.id)) : null;
}

/** An automatic log entry for a flush run, unless that run is already logged. */
export function logDetectedFlush(db: DatabaseSync, shotId: number, at: number): boolean {
  const exists = db.prepare("SELECT 1 FROM maintenance_log WHERE shot_id = ?").get(shotId);
  if (exists) return false;
  logMaintenance(db, "backflush", { at, auto: true, shot_id: shotId });
  return true;
}

/**
 * Classify archived runs that were never classified (water_ml is NULL): tell
 * flushes from coffees and integrate the water. Runs once over the backlog
 * after the schema gained the columns, then only over new rows.
 */
export function classifyShots(db: DatabaseSync, utilityIds: Set<string> | null, parse: (slog: Buffer, id: number) => ShotSample[]): number {
  const rows = db
    .prepare("SELECT id, started_at, profile_id, profile_name, raw_slog FROM shots WHERE water_ml IS NULL AND raw_slog IS NOT NULL")
    .all() as Array<{ id: number; started_at: number; profile_id: string | null; profile_name: string | null; raw_slog: Uint8Array }>;
  const update = db.prepare("UPDATE shots SET kind = ?, water_ml = ? WHERE id = ?");
  let n = 0;
  for (const row of rows) {
    let water: number | null = null;
    try { water = pumpedWaterMl(parse(Buffer.from(row.raw_slog), row.id)); } catch { water = null; }
    const flush = isFlushProfile(row.profile_name, utilityIds, row.profile_id);
    update.run(flush ? "flush" : "shot", water ?? 0, row.id);
    if (flush) logDetectedFlush(db, row.id, row.started_at);
    n++;
  }
  return n;
}
