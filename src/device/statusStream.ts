import WebSocket from "ws";
import { wsUrl } from "../config.js";

/**
 * One `evt:status` message from the machine. Newer firmware splits the event
 * in two: a slow "state" half (mode, selected profile, capabilities) sent on
 * change, and a fast "telemetry" half (temperatures, pressure, flow, the
 * process block) every 500 ms. Neither half is complete on its own, so
 * consumers merge them; `process: null` in the fast half means no process.
 * Only the fields this code reads are typed.
 */
export interface StatusEvent {
  /** Mode: 0 standby, 1 brew, 2 steam, 3 water, 4 grind. */
  m?: number;
  /** Selected profile label and id. */
  p?: string;
  puid?: string;
  pr?: number;
  fl?: number;
  /** a = active, e = elapsed ms, l = phase label, u = utility profile. */
  process?: { a?: number; e?: number; l?: string; u?: number } | null;
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
export function startStatusStream(onStatus: (event: StatusEvent) => void, onGap?: () => void): () => void {
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
