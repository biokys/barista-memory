import WebSocket from "ws";
import { config, httpBase, wsUrl } from "../config.js";
import { parseBinaryIndex, type IndexEntry } from "./parsers/binaryIndex.js";
import { parseBinaryShot, type ShotData } from "./parsers/binaryShot.js";

/** Notes as the device stores them; every field is a string in its web UI. */
export interface DeviceNotes {
  rating?: number;
  beanType?: string;
  doseIn?: string;
  doseOut?: string;
  ratio?: string;
  grindSetting?: string;
  [key: string]: unknown;
}

function timeout(): AbortSignal {
  return AbortSignal.timeout(config.requestTimeoutMs);
}

async function getBuffer(path: string): Promise<Buffer | null> {
  const response = await fetch(`${httpBase}${path}`, {
    headers: { Accept: "application/octet-stream" },
    signal: timeout(),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET ${path} failed: HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Every shot the device currently holds, newest first is not guaranteed. */
export async function fetchIndex(): Promise<IndexEntry[]> {
  const buffer = await getBuffer("/api/history/index.bin");
  if (!buffer) return [];
  return parseBinaryIndex(buffer).entries;
}

export interface MachineStatus {
  mode: number;
  targetTemp: number;
  currentTemp: number;
}

/**
 * The machine's live state, or null when it does not answer.
 *
 * A null is meaningful, not just a failure: the machine only answers while it
 * has power, so no answer is how "switched off" is observed.
 */
export async function fetchStatus(): Promise<MachineStatus | null> {
  try {
    const response = await fetch(`${httpBase}/api/status`, {
      headers: { Accept: "application/json" },
      signal: timeout(),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { mode?: number; tt?: number; ct?: number };
    if (typeof body.ct !== "number") return null;
    return { mode: body.mode ?? 0, targetTemp: body.tt ?? 0, currentTemp: body.ct };
  } catch {
    return null;
  }
}

/** The device pads shot ids to six digits in its filenames. */
function slogPath(shotId: number): string {
  return `/api/history/${String(shotId).padStart(6, "0")}.slog`;
}

/** The raw sample log, kept verbatim so nothing in it is lost to this parser. */
export async function fetchSlog(shotId: number): Promise<Buffer | null> {
  return getBuffer(slogPath(shotId));
}

export function parseSlog(buffer: Buffer, shotId: number): ShotData {
  return parseBinaryShot(buffer, String(shotId));
}

/**
 * One request/response exchange over the device's WebSocket.
 *
 * The socket carries unsolicited status events too, so replies are matched on
 * the request id rather than on arrival order.
 */
function wsRequest<T>(request: Record<string, unknown>, expect: string, extract: (msg: any) => T): Promise<T | null> {
  return new Promise((resolve) => {
    const rid = `archive-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let handle: NodeJS.Timeout | null = null;

    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      if (handle) clearTimeout(handle);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve(value);
    };

    handle = setTimeout(() => finish(null), config.requestTimeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ ...request, rid })));
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.tp === expect && msg.rid === rid) finish(extract(msg));
      } catch {
        // Status events and other traffic share this socket; ignore what does not parse.
      }
    });
    ws.on("error", () => finish(null));
    ws.on("close", () => finish(null));
  });
}

export async function getNotes(shotId: number): Promise<DeviceNotes | null> {
  return wsRequest(
    { tp: "req:history:notes:get", id: String(shotId) },
    "res:history:notes:get",
    (msg) => (msg.notes ?? null) as DeviceNotes | null
  );
}

/**
 * Write notes back to the device.
 *
 * The firmware treats this as a full replacement and also copies rating and
 * doseOut into its index, so callers must pass a complete, merged object —
 * see syncNotes(), which is the only intended entry point.
 */
export async function saveNotes(shotId: number, notes: DeviceNotes): Promise<boolean> {
  const result = await wsRequest(
    { tp: "req:history:notes:save", id: String(shotId), notes },
    "res:history:notes:save",
    () => true
  );
  return result === true;
}
