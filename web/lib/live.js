// The live telemetry stream (api/live, Server-Sent Events), shared by the
// whole page: one EventSource however many parts of the UI listen, opened
// with the first listener and closed after the last. The path is relative
// for the same reason as in api.js: Home Assistant ingress.

/** Mirrors MAX_RUN_SAMPLES in src/liveTelemetry.ts: bounds a run that never ends. */
const MAX_RUN_SAMPLES = 600;

const listeners = new Set();
let source = null;
let latest = null;
/** The current or last coffee, as the server's run buffer holds it. */
let run = [];
/** The run in progress, coffee or not; it becomes `run` once it shows it is one. */
let current = null;
let wasActive = false;

/** Same rule as isCoffee() on the server: steam and hot water name no phase. */
const isCoffee = (s) => s.process?.phase != null && s.process.utility !== true;

function emit(name, arg) {
  for (const l of [...listeners]) {
    try { l[name]?.(arg); } catch (error) { console.error(error); }
  }
}

// The server sends the run buffer only on connect; after that the page
// extends it from the status events by the server's own rule, so both hold
// the same curve without the run being resent twice a second.
function onStatus(status) {
  latest = status;
  const active = status.process?.active === true;
  if (active && !wasActive) current = [];
  let extended = false;
  if (current) {
    current.push(status);
    if (current.length > MAX_RUN_SAMPLES) current.shift();
    if (run !== current && isCoffee(status)) run = current;
    extended = run === current;
    // The first sample after the run (phase "Finished") is the last kept.
    if (!active) current = null;
  }
  wasActive = active;
  emit("onStatus", status);
  if (extended) emit("onRun", run);
}

function onRun({ samples }) {
  run = samples;
  const last = samples.at(-1);
  if (last?.process?.active === true) { current = run; wasActive = true; }
  else current = null;
  emit("onRun", run);
}

const HANDLERS = {
  status: onStatus,
  run: onRun,
  offline: () => { latest = null; emit("onOffline"); },
  online: () => emit("onOnline"),
};

function open() {
  if (source || listeners.size === 0 || document.hidden) return;
  // A server without api/live answers 404 and EventSource gives up for good;
  // the page then simply stays on its api/now poll.
  source = new EventSource("api/live");
  for (const [event, handle] of Object.entries(HANDLERS)) {
    source.addEventListener(event, (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      handle(data);
    });
  }
}

function close() {
  source?.close();
  source = null;
  // Nothing keeps this current while closed; the next connect sends it again.
  latest = null;
}

// A tab in the background has no use for two events a second; reconnecting
// brings the latest status and the whole run back.
document.addEventListener("visibilitychange", () => (document.hidden ? close() : open()));

/**
 * Listen to the live stream: `onStatus(status)`, `onRun(samples)`,
 * `onOffline()`, `onOnline()`, all optional. A new listener is told what is
 * already known. Returns the function that stops listening.
 */
export function watchLive(listener) {
  listeners.add(listener);
  open();
  if (latest) listener.onStatus?.(latest);
  listener.onRun?.(run);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) close();
  };
}
