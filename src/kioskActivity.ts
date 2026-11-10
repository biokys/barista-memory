import type { DatabaseSync } from "node:sqlite";
import { liveTelemetry, type LiveEvent } from "./liveTelemetry.js";
import { machineActivity, type MachineActivity } from "./machineState.js";

/**
 * machineActivity() sharpened by the live status stream, for the kiosk's
 * screen sleep. The record alone is a daemon pass behind (30 s), and the
 * kiosk's own poll adds to that: a machine woken for half a minute was never
 * seen (2026-11-10). The stream says a mode change at once.
 *
 * It listens as one more client of liveTelemetry, so it shares the process's
 * one socket to the machine — in the container the daemon's flush watch keeps
 * that socket open anyway, so the machine gets nothing extra. It attaches on
 * the first question and lets go a while after the last, like a viewer of
 * api/live, so a web-only process opens no socket without a kiosk.
 */

/** No question for this long and the stream is let go. */
export const KIOSK_DETACH_MS = 2 * 60_000;

type Attach = (send: (e: LiveEvent) => void) => () => void;

export function createKioskActivity(attachTo: Attach = (send) => liveTelemetry().attach(send), now = Date.now) {
  let detach: (() => void) | null = null;
  let lastAsked = 0;
  /** What the stream last said: idle (standby or off) or not; null before it said anything. */
  let idle: boolean | null = null;
  let offline = false;
  /** When the stream's `idle` last changed, seconds since the epoch. */
  let changedAt = 0;
  /**
   * The stream saw the machine on, so it knows where the idle stretch began.
   * The record may not: a wake shorter than a daemon pass leaves no row, and
   * its standby stretch would then reach back past the wake.
   */
  let sawOn = false;

  const set = (nextIdle: boolean, nextOffline: boolean, atMs: number) => {
    if (!nextIdle) sawOn = true;
    if (nextIdle !== idle) changedAt = Math.floor(atMs / 1000);
    idle = nextIdle;
    offline = nextOffline;
  };

  const onEvent = (e: LiveEvent) => {
    if (e.event === "offline") set(true, true, e.data.since);
    else if (e.event === "status" && e.data.mode != null) {
      set(e.data.mode === "standby" && e.data.process?.active !== true, false, now());
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const letGo = () => {
    if (timer) { clearInterval(timer); timer = null; }
    detach?.(); detach = null; idle = null; offline = false; sawOn = false;
  };

  return (db: DatabaseSync): MachineActivity => {
    // A kiosk that stopped asking: what the stream said since is not kept
    // current for anyone, so it is dropped, not handed out later.
    if (detach && now() - lastAsked > KIOSK_DETACH_MS) letGo();
    lastAsked = now();
    if (!detach) {
      detach = attachTo(onEvent);
      timer = setInterval(() => { if (now() - lastAsked > KIOSK_DETACH_MS) letGo(); }, KIOSK_DETACH_MS / 4);
      timer.unref?.();
    }

    const stored = machineActivity(db, Math.floor(now() / 1000));
    if (idle === null) return stored;
    if (!idle) return { state: "on", idle_since: null };
    // Attached to a machine already idle for an hour, the stream only knows
    // "since now"; the record knows when the stretch began.
    const since = sawOn || stored.idle_since == null ? changedAt : Math.min(stored.idle_since, changedAt);
    return { state: offline ? "off" : "standby", idle_since: since };
  };
}

let shared: ReturnType<typeof createKioskActivity> | null = null;

/** The process-wide instance the kiosk routes use. */
export function kioskActivity(db: DatabaseSync): MachineActivity {
  return (shared ??= createKioskActivity())(db);
}
