import { fetchStatus, type MachineStatus } from "./device/client.js";

/**
 * The machine's live status for interactive callers (web routes, MCP).
 *
 * A powered-off machine does not refuse connections, it stays silent: ARP
 * gets no answer and every request waits out the full timeout. With the
 * daemon's 10 s that made each page load of the UI hang for 10 s while the
 * machine was off. Interactive callers therefore probe with a short timeout
 * (the machine answers in milliseconds on a LAN) and remember a failure for
 * a while, so the several routes one page load touches share one probe and
 * the machine-side routes can refuse at once instead of each waiting.
 */
const PROBE_TIMEOUT_MS = 2500;
const OK_TTL_MS = 3000;
const OFF_TTL_MS = 15000;

let cached: { status: MachineStatus | null; at: number } | null = null;
let inflight: Promise<MachineStatus | null> | null = null;

export async function liveStatus(): Promise<MachineStatus | null> {
  const now = Date.now();
  if (cached && now - cached.at < (cached.status ? OK_TTL_MS : OFF_TTL_MS)) return cached.status;
  if (!inflight) {
    inflight = fetchStatus(PROBE_TIMEOUT_MS)
      .then((status) => { cached = { status, at: Date.now() }; return status; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** True when the machine answered recently; false means "known off", not "unknown". */
export async function machineReachable(): Promise<boolean> {
  return (await liveStatus()) != null;
}

/** Forget a cached failure, e.g. after the user switched the machine on through us. */
export function forgetLiveStatus(): void {
  cached = null;
}
