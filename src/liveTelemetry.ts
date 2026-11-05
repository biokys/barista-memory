import { subscribeStatus, type StatusEvent, type StatusListener } from "./device/statusStream.js";
import { machineReachable } from "./liveStatus.js";

/**
 * Live machine telemetry for `api/live`: the status stream's two halves merged
 * into one readable object per telemetry tick (~500 ms), fanned out to any
 * number of clients. Read-only — nothing is ever sent to the machine — and
 * nothing is stored but the latest state and the current (or last) coffee,
 * in memory.
 *
 * Field meanings and units come from a recording on firmware 1.9.0; see the
 * comments on StatusEvent.
 */

export type LiveMode = "standby" | "brew" | "steam" | "water" | "grind" | "unknown";

export interface LiveProcess {
  active: boolean;
  stage: string | null;
  phase: string | null;
  utility: boolean | null;
  elapsedMs: number | null;
  target: { type: string; value: number | null; progress: number | null } | null;
}

export interface LiveStatus {
  /** When the telemetry arrived here, ms since the epoch. */
  t: number;
  mode: LiveMode | null;
  profile: { id: string | null; label: string | null; targetWeight: number | null } | null;
  temperature: { current: number | null; target: number | null };
  pressure: { current: number | null; target: number | null };
  flow: { pump: number | null; puck: number | null; target: number | null };
  weight: number | null;
  scale: { connected: boolean | null; battery: number | null };
  heaterPct: number | null;
  pumpPct: number | null;
  process: LiveProcess | null;
}

export type LiveEvent =
  | { event: "status"; data: LiveStatus }
  | { event: "run"; data: { samples: LiveStatus[] } }
  | { event: "shot-saved"; data: { deviceId: number } }
  | { event: "offline"; data: { since: number } }
  | { event: "online"; data: Record<string, never> };

const MODES: LiveMode[] = ["standby", "brew", "steam", "water", "grind"];
/** 5 minutes at 2 Hz. A coffee is under a minute; this only bounds a run that never ends. */
export const MAX_RUN_SAMPLES = 600;

/**
 * Whether a status belongs to a coffee. A profile run names its phase; steam
 * and hot water send a bare `{a: 1}` process block (firmware 1.9.0), and a
 * backflush, a descale or a group flush runs flagged utility. The mode is no
 * guide: the state half lags, and steam's first samples still read "brew".
 */
export function isCoffee(s: LiveStatus): boolean {
  return s.process?.phase != null && s.process.utility !== true;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One readable status from the latest state half and the latest telemetry half. */
export function normalise(state: StatusEvent, telemetry: StatusEvent, t: number): LiveStatus {
  const s = { ...state, ...telemetry };
  const proc = s.process;
  return {
    t,
    mode: s.m == null ? null : MODES[s.m] ?? "unknown",
    profile: s.puid != null || s.p != null ? { id: str(s.puid), label: str(s.p), targetWeight: num(s.tw) } : null,
    temperature: { current: num(s.ct), target: num(s.tt) },
    pressure: { current: num(s.pr), target: num(s.pt) },
    flow: { pump: num(s.fl), puck: num(s.pf), target: num(s.tf) },
    weight: num(s.bw) ?? num(s.cw),
    scale: { connected: typeof s.bc === "boolean" ? s.bc : null, battery: num(s.sbat) },
    heaterPct: num(s.hp),
    pumpPct: num(s.pw),
    process: proc
      ? {
          active: proc.a === 1,
          stage: str(proc.s),
          phase: str(proc.l),
          utility: proc.u == null ? null : proc.u === 1,
          elapsedMs: num(proc.e),
          target: proc.tt ? { type: proc.tt, value: num(proc.pt), progress: num(proc.pp) } : null,
        }
      : null,
  };
}

export interface LiveTelemetryOptions {
  subscribe?: (listener: StatusListener) => () => void;
  /** Quick reachability check for a first client before any data arrived. */
  probe?: () => Promise<boolean>;
  now?: () => number;
  maxRunSamples?: number;
  /** How long the stream is kept after the last client leaves. */
  lingerMs?: number;
}

/** Longer than an EventSource reconnect (retry 5 s) plus a Wi-Fi rejoin. */
export const LINGER_MS = 2 * 60_000;

export function createLiveTelemetry(options: LiveTelemetryOptions = {}) {
  const subscribe = options.subscribe ?? subscribeStatus;
  const probe = options.probe ?? machineReachable;
  const now = options.now ?? Date.now;
  const maxRun = options.maxRunSamples ?? MAX_RUN_SAMPLES;

  const clients = new Set<(e: LiveEvent) => void>();
  const lingerMs = options.lingerMs ?? LINGER_MS;
  let unsubscribe: (() => void) | null = null;
  let linger: NodeJS.Timeout | null = null;

  // The halves are kept apart: a telemetry half replaces the previous one
  // whole, so a field the firmware leaves out when idle (older firmware drops
  // pr, fl and process) reads as absent, not as the last shot's value.
  let state: StatusEvent = {};
  let latest: LiveStatus | null = null;
  let online: boolean | null = null;
  let offlineSince = 0;
  /** The current or last coffee. */
  let run: LiveStatus[] = [];
  /** The run in progress, coffee or not; it becomes `run` once it shows it is one. */
  let current: LiveStatus[] | null = null;
  let wasActive = false;

  const broadcast = (e: LiveEvent) => {
    for (const send of [...clients]) {
      try { send(e); } catch { /* a broken client is dropped by its route */ }
    }
  };

  const reset = () => {
    state = {}; latest = null; online = null; run = []; current = null; wasActive = false;
  };

  const goOffline = () => {
    if (online === false) return;
    online = false;
    offlineSince = now();
    broadcast({ event: "offline", data: { since: offlineSince } });
  };

  const onTelemetry = (half: StatusEvent) => {
    if (online === false) broadcast({ event: "online", data: {} });
    online = true;
    const status = normalise(state, half, now());
    latest = status;

    // The run buffer holds the last coffee, kept after the run so a client
    // that (re)connects later still gets its whole curve. Only the next
    // coffee replaces it: steaming the milk right after a shot must not.
    const active = status.process?.active === true;
    if (active && !wasActive) current = [];
    if (current) {
      current.push(status);
      if (current.length > maxRun) current.shift();
      if (run !== current && isCoffee(status)) run = current;
      // The first sample after the run (phase "Finished") is the last kept.
      if (!active) current = null;
    }
    wasActive = active;
    broadcast({ event: "status", data: status });
  };

  const listener: StatusListener = {
    onStatus(half) {
      // Telemetry carries the boiler temperature; the state half never does.
      if ("ct" in half) onTelemetry(half);
      else state = { ...state, ...half };
    },
    onGap: goOffline,
    onMessage(msg) {
      if (msg.tp === "evt:history-shot-saved" && typeof msg.id === "number") {
        broadcast({ event: "shot-saved", data: { deviceId: msg.id } });
      }
    },
  };

  return {
    /** Attach a client; it gets the latest status, the run buffer, then the live events. */
    attach(send: (e: LiveEvent) => void): () => void {
      clients.add(send);
      if (linger) { clearTimeout(linger); linger = null; }
      if (!unsubscribe) unsubscribe = subscribe(listener);
      // A cached status of a machine known off would draw it hot and busy.
      if (latest && online !== false) send({ event: "status", data: latest });
      send({ event: "run", data: { samples: [...run] } });
      if (online === false) send({ event: "offline", data: { since: offlineSince } });
      else if (online === null) {
        // No data yet: a powered-off machine would leave the client waiting
        // for the stream's handshake timeout before it learns anything.
        probe().then((up) => { if (!up && online === null && clients.has(send)) goOffline(); }).catch(() => {});
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        clients.delete(send);
        if (clients.size === 0 && unsubscribe && !linger) {
          // The kiosk is usually the only client, and a Wi-Fi drop mid-shot
          // detaches it: letting go at once would wipe the run it reconnects
          // for. Without a subscription nothing keeps this state current, so
          // after the grace period it is dropped, not handed out as live.
          linger = setTimeout(() => {
            linger = null;
            if (clients.size > 0 || !unsubscribe) return;
            unsubscribe(); unsubscribe = null; reset();
          }, lingerMs);
          linger.unref?.();
        }
      };
    },
    clientCount: () => clients.size,
  };
}

let shared: ReturnType<typeof createLiveTelemetry> | null = null;

/** The process-wide instance the web route uses. */
export function liveTelemetry(): ReturnType<typeof createLiveTelemetry> {
  return (shared ??= createLiveTelemetry());
}
