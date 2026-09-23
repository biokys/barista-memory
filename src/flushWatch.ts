import type { DatabaseSync } from "node:sqlite";
import type { StatusEvent } from "./device/statusStream.js";
import { logMaintenance } from "./maintenance.js";
import { listProfiles } from "./device/client.js";

/** A cycle shorter than this was aborted, not a backflush. */
const MIN_FLUSH_S = 20;
/** Two detections closer than this are the same cycle seen twice. */
const DEDUPE_S = 10 * 60;
/** How long to trust the profile list before asking the machine again. */
const PROFILE_CACHE_S = 10 * 60;
/** An unknown profile id triggers a refresh, but not more often than this. */
const PROFILE_REFRESH_MIN_S = 60;
/** Without a status message for this long the run is over, whatever it was doing. */
const STALE_S = 30;

interface Run {
  startedAt: number;
  lastSeen: number;
  label: string;
}

/**
 * Turns the status stream into backflush log entries.
 *
 * A run counts when a process is active on a utility profile: the process
 * block's own `u` flag where the firmware sends one, otherwise the selected
 * profile's id checked against the machine's profile list. The firmware
 * records nothing for such runs, so this live observation is the only record.
 *
 * Status arrives in two halves on newer firmware (see StatusEvent), so the
 * halves are merged into one state before anything is decided — evaluating
 * each message alone saw the profile in one and the process in the other and
 * never both, which is how the first watched backflush went unlogged.
 * Logs only run start and end; the per-second trace that found the split
 * message shape is gone, it filled the journal whenever the utility profile
 * stayed selected.
 */
export function createFlushWatcher(db: DatabaseSync, log: (line: string) => void = console.log) {
  let known = new Set<string>();
  let utility = new Set<string>();
  let fetchedAt = 0;
  let refreshing = false;
  let run: Run | null = null;
  let state: StatusEvent = {};

  const refreshProfiles = () => {
    if (refreshing) return;
    refreshing = true;
    listProfiles()
      .then((profiles) => {
        if (!profiles) return;
        known = new Set(profiles.map((p) => p.id));
        utility = new Set(profiles.filter((p) => p.utility).map((p) => p.id));
        fetchedAt = Date.now() / 1000;
      })
      .finally(() => { refreshing = false; });
  };

  const finish = (now: number) => {
    if (!run) return;
    const { startedAt, label } = run;
    run = null;
    const duration = now - startedAt;
    if (duration < MIN_FLUSH_S) { log(`flush watch: ${label} ran ${duration.toFixed(0)} s, too short to count`); return; }
    const dup = db
      .prepare("SELECT id FROM maintenance_log WHERE type_key IN ('backflush', 'cafiza') AND ABS(at - ?) < ?")
      .get(startedAt, DEDUPE_S);
    if (dup) { log(`flush watch: ${label} already logged`); return; }
    logMaintenance(db, "backflush", { at: Math.floor(startedAt), auto: true, note: label });
    log(`flush watch: ${label} ran ${duration.toFixed(0)} s, logged as backflush`);
  };

  return {
    onStatus(half: StatusEvent) {
      state = { ...state, ...half };
      const ev = state;
      const now = Date.now() / 1000;
      const stale = now - fetchedAt > PROFILE_CACHE_S;
      const unknown = !!ev.puid && !known.has(ev.puid) && now - fetchedAt > PROFILE_REFRESH_MIN_S;
      if (stale || unknown) refreshProfiles();
      const isUtility = !!ev.puid && utility.has(ev.puid);

      const onUtility = ev.process?.u != null ? ev.process.u === 1 : isUtility;
      const active = ev.process?.a === 1 && onUtility;

      if (active) {
        if (!run) {
          run = { startedAt: now - (ev.process?.e ?? 0) / 1000, lastSeen: now, label: ev.p ?? "utility profile" };
          log(`flush watch: ${run.label} started`);
        } else run.lastSeen = now;
      } else if (run) {
        finish(now);
      }
    },
    onGap() {
      if (run && Date.now() / 1000 - run.lastSeen > STALE_S) finish(run.lastSeen);
    },
  };
}
