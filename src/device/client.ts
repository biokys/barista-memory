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
export async function fetchStatus(timeoutMs = config.requestTimeoutMs): Promise<MachineStatus | null> {
  try {
    const response = await fetch(`${httpBase}/api/status`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
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

// ---------------------------------------------------------------------------
// Profiles and settings — the parts of the machine this archive can *change*.
// Everything above only reads; these are the two write paths, and the one
// settings read that needs a credential filter.
// ---------------------------------------------------------------------------

export interface ProfilePhase {
  name: string;
  phase: "preinfusion" | "brew";
  valve: 0 | 1;
  duration: number;
  temperature: number;
  transition: { type: string; duration: number; target?: string; adaptive?: boolean };
  pump: { target: "pressure" | "flow"; pressure: number; flow: number };
  targets: Array<{ type: string; operator?: string; value: number }>;
}

export interface Profile {
  id: string;
  label: string;
  type: string;
  description?: string;
  temperature: number;
  favorite: boolean;
  selected: boolean;
  utility: boolean;
  phases: ProfilePhase[];
}

export async function listProfiles(): Promise<Profile[] | null> {
  return wsRequest({ tp: "req:profiles:list" }, "res:profiles:list", (msg) => (msg.profiles ?? []) as Profile[]);
}

export async function getProfile(profileId: string): Promise<Profile | null> {
  return wsRequest(
    { tp: "req:profiles:load", id: profileId },
    "res:profiles:load",
    (msg) => (msg.profile ?? null) as Profile | null
  );
}

/**
 * Save a profile. The machine treats the payload as the whole profile, so the
 * caller must send a complete object — see saveProfileTool in the MCP, which
 * merges the caller's changes onto the existing profile first.
 */
export async function saveProfile(profile: Profile): Promise<{ ok: true; profile: Profile } | { ok: false; error: string }> {
  const result = await wsRequest<{ ok: true; profile: Profile } | { ok: false; error: string }>(
    { tp: "req:profiles:save", profile },
    "res:profiles:save",
    (msg) => (msg.error ? { ok: false, error: String(msg.error) } : { ok: true, profile: msg.profile as Profile })
  );
  return result ?? { ok: false, error: `No answer from ${config.deviceHost}` };
}

/** Make a profile the machine's current one; the firmware answers with no payload. */
export async function selectProfile(profileId: string): Promise<boolean> {
  const result = await wsRequest({ tp: "req:profiles:select", id: profileId }, "res:profiles:select", (msg) => !msg.error);
  return result === true;
}

/**
 * Send one request the firmware never answers. Resolves once the socket has
 * flushed it; whether the machine acted on it has to be observed elsewhere
 * (e.g. /api/status for a mode change).
 */
export function wsSend(request: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve(ok);
    };
    const handle = setTimeout(() => finish(false), config.requestTimeoutMs);
    ws.on("open", () => ws.send(JSON.stringify(request), (error) => finish(!error)));
    ws.on("error", () => finish(false));
  });
}

/**
 * Raw /api/settings. Contains wifiPassword, apPassword and haPassword in
 * cleartext, unauthenticated — callers must pass it through groupSettings()
 * and never return it as-is.
 */
export async function fetchRawSettings(): Promise<Record<string, unknown>> {
  const response = await fetch(`${httpBase}/api/settings`, {
    headers: { Accept: "application/json" },
    signal: timeout(),
  });
  if (!response.ok) throw new Error(`GET /api/settings failed: HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * The machine's Bluetooth scale, managed by the firmware (the scale talks to
 * the machine, not to us). /api/scales/* answer 404 on a build without BLE.
 */
export interface ScaleInfo { connected: boolean; name: string; uuid: string; rssi: number; hasBattery: boolean; battery?: number }
export interface ScaleCandidate { uuid: string; name: string; rssi: number }

async function scaleGet<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${httpBase}${path}`, { headers: { Accept: "application/json" }, signal: timeout() });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const scaleInfo = () => scaleGet<ScaleInfo>("/api/scales/info");
export const scaleList = () => scaleGet<ScaleCandidate[]>("/api/scales/list");
export const scaleScan = () => scaleGet<{ success: boolean }>("/api/scales/scan");
export const scaleConnect = (uuid: string) => scaleGet<{ success: boolean }>(`/api/scales/connect?uuid=${encodeURIComponent(uuid)}`);
