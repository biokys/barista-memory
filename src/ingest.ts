import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { openDatabase, type ShotContextRow } from "./db/db.js";
import { fetchIndex, fetchSlog, parseSlog } from "./device/client.js";
import { stableWeight } from "./stableWeight.js";
import { powerSessions, machineContextForShot, allStateSamples } from "./machineState.js";
import { syncNotes } from "./notesSync.js";
import { classifyShots, utilityProfileIds } from "./maintenance.js";


/** The stable weight for one shot, or the raw figure if the log cannot be read. */
function deriveWeight(slog: Buffer, shotId: number, recorded: number | null) {
  try {
    return stableWeight(parseSlog(slog, shotId).samples, recorded);
  } catch {
    // A log this parser cannot read must not stop the shot being archived: the
    // bytes are kept and recomputeStableWeights() can derive it later.
    return recorded != null && recorded > 0
      ? { weight: recorded, source: "recorded" as const, rejected: 0 }
      : { weight: null, source: "none" as const, rejected: 0 };
  }
}

/**
 * Derive the stable weight for shots that have none yet.
 *
 * Kept separate from ingest so the whole archive can be re-derived when the
 * rules change — which is the point of storing the raw log rather than only the
 * numbers read out of it once.
 */
export function recomputeStableWeights(db: DatabaseSync, all = false): number {
  const rows = db
    .prepare(
      "SELECT id, final_weight_g, raw_slog FROM shots" +
        (all ? "" : " WHERE stable_weight_g IS NULL AND stable_weight_source IS NULL")
    )
    .all() as unknown as Array<{ id: number; final_weight_g: number | null; raw_slog: Uint8Array | null }>;

  const update = db.prepare(
    "UPDATE shots SET stable_weight_g = ?, stable_weight_source = ? WHERE id = ?"
  );

  let changed = 0;
  for (const row of rows) {
    if (!row.raw_slog) continue;
    const derived = deriveWeight(Buffer.from(row.raw_slog), row.id, row.final_weight_g);
    update.run(derived.weight, derived.source, row.id);
    changed++;
  }
  return changed;
}

/**
 * Fill in the machine's thermal context for shots that lack it.
 *
 * Only shots whose start time is covered by a session get values; the rest stay
 * NULL, because the sampling started after them and nothing is known. Runs at
 * daemon start so a shot archived while the state table was thin — or before
 * these columns existed — is completed once the history is there.
 */
export function recomputeMachineContext(db: DatabaseSync, all = false): number {
  const sessions = powerSessions(db);
  const samples = allStateSamples(db);
  const rows = db
    .prepare(
      "SELECT id, started_at FROM shots" + (all ? "" : " WHERE machine_powered_for_s IS NULL")
    )
    .all() as unknown as Array<{ id: number; started_at: number }>;

  const update = db.prepare(
    "UPDATE shots SET machine_powered_for_s = ?, machine_heating_for_s = ?, machine_heatup_s = ?, machine_settled = ?, machine_settledness = ? WHERE id = ?"
  );

  let changed = 0;
  for (const row of rows) {
    const machine = machineContextForShot(sessions, row.started_at, samples);
    if (machine.powered_for_s == null && !all) continue;
    update.run(
      machine.powered_for_s,
      machine.heating_for_s,
      machine.heatup_s,
      machine.settled == null ? null : machine.settled ? 1 : 0,
      machine.settledness,
      row.id
    );
    changed++;
  }
  return changed;
}

export interface IngestResult {
  onDevice: number;
  archived: number;
  skipped: number;
  notesSynced: number;
  classified: number;
  /** Ids archived in this pass that turned out to be coffees, not flushes. */
  newCoffeeIds: number[];
  failures: Array<{ shotId: number; reason: string }>;
}

/**
 * Copy every shot the device holds but the archive does not.
 *
 * The set of missing ids is computed by difference against the archive rather
 * than from a high-water mark. That matters twice: a gap left by the archiver
 * being down is filled on the next pass rather than skipped forever, and a
 * device whose shot ids restarted (a reset, a replaced controller) does not
 * silently stop being archived.
 */
export async function ingestOnce(db: DatabaseSync): Promise<IngestResult> {
  const entries = await fetchIndex();
  const live = entries.filter((entry) => !entry.deleted);

  const known = new Set(
    (db.prepare("SELECT id FROM shots").all() as Array<{ id: number }>).map((row) => row.id)
  );

  const result: IngestResult = {
    onDevice: live.length,
    archived: 0,
    skipped: 0,
    notesSynced: 0,
    classified: 0,
    newCoffeeIds: [],
    failures: [],
  };

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shots
       (id, started_at, profile_id, profile_name, duration_ms, final_weight_g,
        stable_weight_g, stable_weight_source,
        machine_powered_for_s, machine_heating_for_s, machine_heatup_s, machine_settled,
        machine_settledness,
        device_rating, incomplete, raw_slog, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Sessions are reconstructed once per pass, not once per shot: the state
  // table only grows, and every shot in this pass reads the same history.
  const sessions = powerSessions(db);
  const samples = allStateSamples(db);

  const fresh: number[] = [];
  let sawNew = false;

  for (const entry of live) {
    if (known.has(entry.id)) {
      result.skipped++;
      continue;
    }

    try {
      const slog = await fetchSlog(entry.id);
      if (!slog) {
        // The index can list a shot whose sample log is still being written.
        // Leaving it unarchived means the next pass picks it up complete.
        result.failures.push({ shotId: entry.id, reason: "slog not available yet" });
        continue;
      }

      const derived = deriveWeight(slog, entry.id, entry.volume);
      const machine = machineContextForShot(sessions, entry.timestamp, samples);

      insert.run(
        entry.id,
        entry.timestamp,
        entry.profileId || null,
        entry.profileName || null,
        entry.duration,
        entry.volume,
        derived.weight,
        derived.source,
        machine.powered_for_s,
        machine.heating_for_s,
        machine.heatup_s,
        machine.settled == null ? null : machine.settled ? 1 : 0,
        machine.settledness,
        entry.rating || null,
        entry.incomplete ? 1 : 0,
        slog,
        Math.floor(Date.now() / 1000)
      );
      result.archived++;
      fresh.push(entry.id);
      sawNew = true;
    } catch (error) {
      result.failures.push({
        shotId: entry.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Flush or coffee, and how much water: asked of the machine's profile list
  // only when there is something new to classify, so a quiet pass costs no
  // extra request.
  if (sawNew || db.prepare("SELECT 1 FROM shots WHERE water_ml IS NULL LIMIT 1").get()) {
    const utility = await utilityProfileIds();
    result.classified = classifyShots(db, utility, (slog, id) => parseSlog(slog, id).samples);
  }
  if (fresh.length) {
    const coffees = db.prepare(`SELECT id FROM shots WHERE kind = 'shot' AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(fresh)) as Array<{ id: number }>;
    result.newCoffeeIds = coffees.map((r) => r.id);
  }

  if (config.syncNotesToDevice) {
    // Sync newly archived shots, plus any still on the device whose context has
    // since changed — editing a setup's valid_from retroactively changes what
    // those shots should say.
    const onDeviceIds = new Set(live.map((entry) => entry.id));
    const candidates = db
      .prepare("SELECT * FROM shot_context WHERE id IN (SELECT id FROM shots) ORDER BY started_at DESC LIMIT 100")
      .all() as unknown as ShotContextRow[];

    for (const context of candidates) {
      if (!onDeviceIds.has(context.id) && !fresh.includes(context.id)) continue;
      try {
        if (await syncNotes(db, context)) result.notesSynced++;
      } catch (error) {
        result.failures.push({
          shotId: context.id,
          reason: `notes sync: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return result;
}

// Running this file directly performs a single pass and reports what it did.
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDatabase(config.databasePath);
  try {
    const result = await ingestOnce(db);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.failures.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`Ingest failed: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  } finally {
    db.close();
  }
}
