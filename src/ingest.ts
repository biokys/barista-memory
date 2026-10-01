import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { openDatabase, type ShotContextRow } from "./db/db.js";
import { fetchIndex, fetchSlog, getNotes, parseSlog } from "./device/client.js";
import type { IndexEntry } from "./device/parsers/binaryIndex.js";
import { stableWeight } from "./stableWeight.js";
import { recomputeAnalysis } from "./anomaly.js";
import { powerSessions, machineContextForShot, allStateSamples, coldBaseline } from "./machineState.js";
import { syncNotes } from "./notesSync.js";
import { classifyShots, utilityProfileIds } from "./maintenance.js";
import { captureProfileSnapshots } from "./profileSnapshots.js";


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
    const machine = machineContextForShot(sessions, row.started_at, samples, coldBaseline(db, row.started_at));
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

/** Notes typed on the machine after this long are still picked up for recent shots. */
const NOTES_REFRESH_S = 3600;
const NOTES_RECENT_S = 3 * 86400;
/** One WebSocket per read; a full device on the first pass is spread over several. */
const NOTES_PER_PASS = 10;

/**
 * Copy the device's own notes for each shot it still holds.
 *
 * What is typed into the machine's web UI (rating, taste note, doseOut) lives
 * only there and is gone after a wipe. Read once per shot, again when the
 * index shows the rating changed, and hourly for the last few days, since a
 * text-only edit leaves no trace in the index. Also captures what notes sync
 * wrote, which is the device's state too.
 */
async function captureDeviceNotes(
  db: DatabaseSync,
  onDevice: Map<number, IndexEntry>,
  rerated: Set<number>,
  lastCapture: Map<number, number | null>
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const store = db.prepare("UPDATE shots SET device_notes = ?, device_notes_at = ? WHERE id = ?");
  let captured = 0;
  for (const [archiveId, entry] of onDevice) {
    if (captured >= NOTES_PER_PASS) break;
    if (!entry.hasNotes) continue;
    const at = lastCapture.get(archiveId) ?? null;
    const due =
      at == null || rerated.has(archiveId) || (entry.timestamp > now - NOTES_RECENT_S && now - at > NOTES_REFRESH_S);
    if (!due) continue;
    const notes = await getNotes(entry.id);
    if (!notes) continue; // Unreachable or no answer; the next pass tries again.
    store.run(JSON.stringify(notes), now, archiveId);
    captured++;
  }
  return captured;
}

export interface IngestResult {
  onDevice: number;
  archived: number;
  skipped: number;
  notesSynced: number;
  classified: number;
  /** Ids archived in this pass that turned out to be coffees, not flushes. */
  newCoffeeIds: number[];
  /** Shots whose notes were copied from the device in this pass. */
  notesCaptured: number;
  /** Shots that got the profile version they were pulled with. */
  profilesCaptured: number;
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
 *
 * A shot is the same shot only if both its device id and its start time match.
 * The id alone is not enough: a firmware update that wipes history restarts
 * the device's numbering, and its new shot 1 would have been skipped as
 * "already archived" — and had the old shot 1's bean written into its notes.
 * A new shot whose device id is taken in the archive gets the next free id.
 */
export async function ingestOnce(db: DatabaseSync): Promise<IngestResult> {
  const entries = await fetchIndex();
  const live = entries.filter((entry) => !entry.deleted);

  const archivedRows = db
    .prepare(
      `SELECT id, device_id, started_at, incomplete, length(raw_slog) > 0 AS has_log,
              device_rating, device_notes_at FROM shots`
    )
    .all() as Array<{
      id: number; device_id: number | null; started_at: number; incomplete: number; has_log: number;
      device_rating: number | null; device_notes_at: number | null;
    }>;
  const sameShot = (deviceId: number, startedAt: number) => `${deviceId}@${startedAt}`;
  const known = new Map(
    archivedRows.filter((row) => row.device_id != null).map((row) => [sameShot(row.device_id!, row.started_at), row])
  );
  const usedIds = new Set(archivedRows.map((row) => row.id));
  let maxId = archivedRows.reduce((max, row) => Math.max(max, row.id), 0);
  // Archive id -> index entry, for every archived shot the device still holds;
  // notes are pushed to and read from only these, under the device's id.
  const onDevice = new Map<number, IndexEntry>();
  // Archive ids whose rating changed on the machine since the last pass.
  const rerated = new Set<number>();
  // The index lists a shot as soon as recording starts, flagged incomplete and
  // with an empty .slog until it ends. Shot 33 was archived 16 s into the pull
  // with no curve at all. The newest incomplete entry is taken to be still
  // recording and waits for a later pass; an older one was cut short (power
  // lost mid-shot) and is archived as it is. Clock-independent on purpose:
  // the device's timestamps read 1970 until it has synced its time.
  const newestId = live.reduce((max, entry) => Math.max(max, entry.id), -1);

  const result: IngestResult = {
    onDevice: live.length,
    archived: 0,
    skipped: 0,
    notesSynced: 0,
    classified: 0,
    newCoffeeIds: [],
    notesCaptured: 0,
    profilesCaptured: 0,
    failures: [],
  };

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shots
       (id, device_id, started_at, profile_id, profile_name, duration_ms, final_weight_g,
        stable_weight_g, stable_weight_source,
        machine_powered_for_s, machine_heating_for_s, machine_heatup_s, machine_settled,
        machine_settledness,
        device_rating, incomplete, raw_slog, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Sessions are reconstructed once per pass, not once per shot: the state
  // table only grows, and every shot in this pass reads the same history.
  const sessions = powerSessions(db);
  const samples = allStateSamples(db);

  const fresh: number[] = [];
  let sawNew = false;

  const setRating = db.prepare("UPDATE shots SET device_rating = ? WHERE id = ?");
  const heal = db.prepare(
    `UPDATE shots SET duration_ms = ?, final_weight_g = ?, stable_weight_g = ?, stable_weight_source = ?,
       device_rating = ?, incomplete = 0, raw_slog = ?, water_ml = NULL WHERE id = ?`
  );

  for (const entry of live) {
    const match = known.get(sameShot(entry.id, entry.timestamp));
    if (match) {
      onDevice.set(match.id, entry);
      if ((entry.rating || null) !== match.device_rating) {
        setRating.run(entry.rating || null, match.id);
        rerated.add(match.id);
      }
      // Archived while incomplete, or with an empty log, and complete on the
      // device now: fetch the log again. The device has served a completed
      // shot's .slog as 0 bytes (shots 6 and 22, whose data was then lost to
      // a wipe), so an empty answer is retried on every pass while the device
      // still holds the shot. UPDATE, not REPLACE — a replaced row would
      // cascade away its notes, analysis and sync state. water_ml = NULL
      // re-runs classification; the analysis never ran on a row without a log.
      if ((match.incomplete || !match.has_log) && !entry.incomplete) {
        try {
          const slog = await fetchSlog(entry.id);
          if (slog && slog.length > 0) {
            const derived = deriveWeight(slog, entry.id, entry.volume);
            heal.run(entry.duration, entry.volume, derived.weight, derived.source, entry.rating || null, slog, match.id);
            // The row was analysed on its header-only log; recomputeAnalysis()
            // skips a current-version row, so the stale result must go.
            db.prepare("DELETE FROM shot_analysis WHERE shot_id = ?").run(match.id);
            db.prepare("DELETE FROM shot_profiles WHERE shot_id = ?").run(match.id);
            result.archived++;
            fresh.push(match.id);
            sawNew = true;
            continue;
          }
        } catch (error) {
          result.failures.push({ shotId: entry.id, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      result.skipped++;
      continue;
    }
    if (entry.incomplete && entry.id === newestId) continue;

    try {
      const slog = await fetchSlog(entry.id);
      if (!slog) {
        // The index can list a shot whose sample log is still being written.
        // Leaving it unarchived means the next pass picks it up complete.
        result.failures.push({ shotId: entry.id, reason: "slog not available yet" });
        continue;
      }

      const derived = deriveWeight(slog, entry.id, entry.volume);
      const machine = machineContextForShot(sessions, entry.timestamp, samples, coldBaseline(db, entry.timestamp));
      const archiveId = usedIds.has(entry.id) ? maxId + 1 : entry.id;

      insert.run(
        archiveId,
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
        slog.length > 0 ? slog : null,
        Math.floor(Date.now() / 1000)
      );
      usedIds.add(archiveId);
      maxId = Math.max(maxId, archiveId);
      onDevice.set(archiveId, entry);
      result.archived++;
      fresh.push(archiveId);
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
  // A row without a log is never classified, so it must not count as pending
  // or every quiet pass would open a WebSocket for the profile list.
  if (sawNew || db.prepare("SELECT 1 FROM shots WHERE water_ml IS NULL AND raw_slog IS NOT NULL LIMIT 1").get()) {
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
    const candidates = db
      .prepare("SELECT * FROM shot_context WHERE id IN (SELECT id FROM shots) ORDER BY started_at DESC LIMIT 100")
      .all() as unknown as ShotContextRow[];

    for (const context of candidates) {
      const deviceId = onDevice.get(context.id)?.id;
      if (deviceId == null) continue;
      try {
        if (await syncNotes(db, context, deviceId)) result.notesSynced++;
      } catch (error) {
        result.failures.push({
          shotId: context.id,
          reason: `notes sync: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  result.notesCaptured = await captureDeviceNotes(db, onDevice, rerated, new Map(archivedRows.map((r) => [r.id, r.device_notes_at])));

  // Before the analysis, which reads phase types from the snapshot. Runs every
  // pass, not only when something is new: a shot archived while the machine
  // stopped answering is retried until its capture window closes. A shot
  // that was analysed on an earlier pass without its snapshot is analysed
  // again, or its stored flags would keep the name-based preinfusion.
  const captured = await captureProfileSnapshots(db);
  result.profilesCaptured = captured.length;
  if (captured.length) {
    db.prepare("DELETE FROM shot_analysis WHERE shot_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(captured));
  }

  // Curves are judged once the kind is known, so a flush is never analysed.
  if (sawNew || captured.length) recomputeAnalysis(db);

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
