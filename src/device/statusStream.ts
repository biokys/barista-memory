import WebSocket from "ws";
import { wsUrl } from "../config.js";

/**
 * One `evt:status` message from the machine. Newer firmware splits the event
 * in two: a slow "state" half (mode, selected profile, capabilities) sent on
 * change, and a fast "telemetry" half (temperatures, pressure, flow, the
 * process block) every 500 ms. Neither half is complete on its own, so
 * consumers merge them; `process: null` in the fast half means no process.
 * Older firmware omits `pr`, `fl` and `process` from the idle telemetry.
 *
 * Only the fields this code reads are typed. Units and meanings are from a
 * recording on firmware 1.9.0 (2026-11-04): the state half also repeats every
 * ~10 s, not only on change; `pf`'s meaning is inferred from its behaviour.
 */
export interface StatusEvent {
  // State half.
  /** Mode: 0 standby, 1 brew, 2 steam, 3 water, 4 grind. */
  m?: number;
  /** Selected profile label and id. */
  p?: string;
  puid?: string;
  /** Target weight of the selected profile, g. */
  tw?: number;
  /** A scale is connected; its battery in %, null without one. */
  bc?: boolean;
  sbat?: number | null;
  // Telemetry half.
  /** Boiler temperature (raw sensor minus the user's offset) and its target, °C. */
  ct?: number;
  tt?: number;
  /** Pressure and target pressure, bar. */
  pr?: number;
  pt?: number;
  /** Pump flow, puck flow (inferred) and target flow, ml/s. */
  fl?: number;
  pf?: number;
  tf?: number;
  /** Scale weight, g; `bw` and `cw` carried the same value in every sample. */
  bw?: number;
  cw?: number;
  /** Heater and pump power, %. */
  hp?: number;
  pw?: number;
  /**
   * a = active (0 once finished: the block stays as "Finished" for a while),
   * s = stage (infusion, brew), l = phase label, e = elapsed ms,
   * u = utility profile, tt = phase target type (time | volumetric),
   * pt = phase target (ms or g), pp = progress towards it. Steam sends {a} only.
   */
  process?: { a?: number; s?: string; l?: string; e?: number; u?: number; tt?: string; pt?: number; pp?: number } | null;
}

/** Any other message on the socket, e.g. `evt:history-shot-saved` with the device's shot `id`. */
export interface DeviceMessage {
  tp: string;
  [key: string]: unknown;
}

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
/**
 * A connected machine sends telemetry every 500 ms. Silence this long means
 * the socket is dead: a machine switched off sends no FIN, and nothing is ever
 * written on this socket, so TCP alone never notices. On 2026-09-27 the
 * machine went off at 17:00 and the socket sat ESTABLISHED and silent for
 * 16 hours after it came back, blind to any backflush.
 */
const SILENCE_MS = 20_000;
/** A powered-off machine answers nothing, not even the TCP handshake. */
const HANDSHAKE_MS = 10_000;

/**
 * A persistent subscription to the machine's status stream.
 *
 * The HTTP status endpoint says only mode and temperatures. The WebSocket
 * stream also names the selected profile and whether a process is running,
 * which is the only way to see a run on a utility profile: the firmware's
 * history plugin returns early for those and never writes a log. One socket is
 * kept open (the machine's own web UI does the same) rather than one per poll.
 */
export function startStatusStream(
  onStatus: (event: StatusEvent) => void,
  onGap?: () => void,
  onMessage?: (message: DeviceMessage) => void
): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;
  let backoff = RECONNECT_MIN_MS;
  let timer: NodeJS.Timeout | null = null;
  let silence: NodeJS.Timeout | null = null;

  const connect = () => {
    if (stopped) return;
    const socket = new WebSocket(wsUrl, { handshakeTimeout: HANDSHAKE_MS });
    ws = socket;
    // terminate() emits close, and close schedules the reconnect.
    const heard = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => socket.terminate(), SILENCE_MS);
    };
    socket.on("open", () => { backoff = RECONNECT_MIN_MS; heard(); });
    socket.on("message", (data) => {
      heard();
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.tp === "evt:status") onStatus(msg as StatusEvent);
        else if (typeof msg?.tp === "string") onMessage?.(msg as DeviceMessage);
      } catch {
        // Anything that is not JSON is not a status event.
      }
    });
    const retry = () => {
      if (silence) clearTimeout(silence);
      if (stopped) return;
      onGap?.();
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };
    socket.on("error", () => { /* close follows */ });
    socket.on("close", retry);
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (silence) clearTimeout(silence);
    ws?.close();
  };
}

export interface StatusListener {
  onStatus?: (event: StatusEvent) => void;
  onGap?: () => void;
  onMessage?: (message: DeviceMessage) => void;
}

type StartStream = typeof startStatusStream;

/**
 * One socket to the machine per process, however many consumers.
 *
 * In the container the daemon (flush watch) and the web server (`api/live`)
 * run in one process and both want the stream; two sockets would double the
 * load on the machine's small web server for no information. In the systemd
 * deployment the web process has no daemon, so the socket must open with its
 * first subscriber and close after its last. Reference counting gives both.
 */
export function createStatusHub(start: StartStream = startStatusStream) {
  const listeners = new Set<StatusListener>();
  let stop: (() => void) | null = null;

  // One listener throwing must not starve the others.
  const each = (call: (l: StatusListener) => void) => {
    for (const l of [...listeners]) {
      try { call(l); } catch (error) { console.error(`status listener failed: ${error instanceof Error ? error.message : error}`); }
    }
  };

  return {
    subscribe(listener: StatusListener): () => void {
      listeners.add(listener);
      if (!stop) {
        stop = start(
          (ev) => each((l) => l.onStatus?.(ev)),
          () => each((l) => l.onGap?.()),
          (msg) => each((l) => l.onMessage?.(msg))
        );
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        listeners.delete(listener);
        if (listeners.size === 0 && stop) { stop(); stop = null; }
      };
    },
    /** Listeners currently attached; for tests and diagnostics. */
    size: () => listeners.size,
  };
}

const hub = createStatusHub();

/** Subscribe to the process-wide status stream; returns the unsubscribe. */
export const subscribeStatus = (listener: StatusListener): (() => void) => hub.subscribe(listener);
