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
 * A run counts when the selected profile is one the machine flags as
 * utility and a process is active. The firmware records nothing for such
 * runs, so this live observation is the only record. While a utility
 * profile is selected in brew mode one status line per few seconds goes to
 * the log: the message shape differs between firmware versions and the
 * next unexpected one should be diagnosable from the journal.
 */
export function createFlushWatcher(db: DatabaseSync, log: (line: string) => void = console.log) {
  let known = new Set<string>();
  let utility = new Set<string>();
  let fetchedAt = 0;
  let refreshing = false;
  let run: Run | null = null;
  let lastTrace = 0;

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
    onStatus(ev: StatusEvent) {
      const now = Date.now() / 1000;
      const stale = now - fetchedAt > PROFILE_CACHE_S;
      const unknown = !!ev.puid && !known.has(ev.puid) && now - fetchedAt > PROFILE_REFRESH_MIN_S;
      if (stale || unknown) refreshProfiles();
      const isUtility = !!ev.puid && utility.has(ev.puid);

      if (isUtility && ev.m === 1 && now - lastTrace >= 5) {
        lastTrace = now;
        log(`flush watch: ${JSON.stringify({ m: ev.m, p: ev.p, pr: ev.pr, fl: ev.fl, process: ev.process })}`);
      }

      // The process block is the firmware's own word; pressure or flow with a
      // utility profile selected is the fallback for a firmware that omits it.
      const active = isUtility && (ev.process?.a === 1 || (ev.process == null && ((ev.pr ?? 0) > 0.5 || (ev.fl ?? 0) > 0)));

      if (active) {
        if (!run) run = { startedAt: now - (ev.process?.e ?? 0) / 1000, lastSeen: now, label: ev.p ?? "utility profile" };
        else run.lastSeen = now;
      } else if (run) {
        finish(now);
      }
    },
    onGap() {
      if (run && Date.now() / 1000 - run.lastSeen > STALE_S) finish(run.lastSeen);
    },
  };
}
