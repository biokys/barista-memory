import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getProfile, parseSlog, type Profile, type ProfilePhase } from "./device/client.js";
import type { ShotData, PhaseTransition } from "./device/parsers/binaryShot.js";

/**
 * The profile each shot was pulled with, archived as a version.
 *
 * The .slog records which phases ran (index into the profile and name) but
 * not what they were: no type, no exit conditions, no plan. The machine keeps
 * only the current profile, and editing it renumbers phases — "Gentle and
 * sweet (tuned)" gained a Fill at the front, so its old shots' phase 1 (Hold)
 * would read as today's phase 1 (Pre-infusion). A copy is therefore taken at
 * ingest and only while the shot is fresh, and only if it agrees with the log.
 */

/** A profile fetched later than this after the shot may already have been edited. */
export const CAPTURE_WINDOW_S = 600;

/** JSON with sorted keys, so the same profile always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Selecting or starring a profile does not make it a new version. */
export function contentHash(profile: Profile): string {
  const { selected: _selected, favorite: _favorite, ...content } = profile;
  return createHash("sha256").update(canonical(content)).digest("hex");
}

/**
 * A phase name as the .slog parser returns it. The firmware writes UTF-8
 * into 25 bytes and decodeCString reads them one byte per character, so
 * "Předinfuze" comes back as mojibake; the profile's name is put through the
 * same path before comparing, rather than changing the vendored parser.
 */
function asLogged(name: string): string {
  return Buffer.from(name, "utf8").toString("latin1");
}

/**
 * Whether the profile is the one the log was recorded with: every phase the
 * log names sits at the same index in the profile under the same name. The
 * .slog stores names in 25 bytes, so a longer name arrives cut short.
 */
export function matchesLog(profile: Profile, transitions: PhaseTransition[]): boolean {
  if (!transitions.length || !Array.isArray(profile.phases)) return false;
  return transitions.every((t) => {
    const name = profile.phases[t.phaseNumber]?.name;
    if (typeof name !== "string") return false;
    const logged = asLogged(name);
    return logged === t.phaseName || (t.phaseName.length >= 24 && logged.startsWith(t.phaseName));
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Whether the setpoints the log recorded agree with the profile. Names alone
 * miss an edit that keeps them (Hold 9 → 8 bar) made between the shot and
 * the capture, and every sample carries the setpoint it was pulled with:
 * the temperature of each phase, whether the pump was driven on pressure or
 * flow, and — where the phase jumps straight to it — the value itself.
 * A ramp's setpoint moves through the phase, so only its mode is compared.
 */
export function setpointsAgree(profile: Profile, shot: ShotData): boolean {
  const TOLERANCE = 0.15;
  // The last samples are written as the pump stops, setpoints already cleared.
  const usable = Math.max(0, shot.samples.length - 2);
  return shot.phases.every((t, k) => {
    const phase = profile.phases?.[t.phaseNumber];
    if (!phase) return false;
    const end = Math.min(shot.phases[k + 1]?.sampleIndex ?? usable, usable);
    const samples = shot.samples.slice(t.sampleIndex, end);
    if (!samples.length) return true;

    const wantTemp = phase.temperature > 0 ? phase.temperature : profile.temperature;
    const temp = median(samples.map((s) => s.tt ?? 0).filter((v) => v > 0));
    if (temp != null && Math.abs(temp - wantTemp) > TOLERANCE) return false;

    const onFlow = phase.pump?.target === "flow";
    const driven = samples.map((s) => (onFlow ? s.tf : s.tp) ?? 0);
    const other = samples.map((s) => (onFlow ? s.tp : s.tf) ?? 0);
    const want = onFlow ? phase.pump.flow : phase.pump.pressure;
    // A pump target of 0 is a phase that does not pump; nothing to compare.
    if (want > 0 && median(other)! > TOLERANCE && median(driven)! <= TOLERANCE) return false;
    const instant = phase.transition?.type === "instant" || !(phase.transition?.duration > 0);
    if (want > 0 && instant) {
      const value = median(driven);
      if (value != null && Math.abs(value - want) > TOLERANCE) return false;
    }
    return true;
  });
}

function storeSnapshot(db: DatabaseSync, profile: Profile, now: number): number {
  const hash = contentHash(profile);
  db.prepare(
    "INSERT OR IGNORE INTO profile_snapshots (profile_id, label, content_hash, profile_json, first_seen_at) VALUES (?, ?, ?, ?, ?)"
  ).run(profile.id, profile.label ?? null, hash, JSON.stringify(profile), now);
  return (db.prepare("SELECT id FROM profile_snapshots WHERE content_hash = ?").get(hash) as { id: number }).id;
}

/**
 * Attach a profile version to each fresh shot that has none. One request per
 * profile per pass, however many shots used it. A shot the profile no longer
 * matches — by phase names or by the setpoints the log recorded — or one
 * archived after the window, stays without: never guessed. Returns the shots
 * that got one. `fetchProfile` is injectable so the rule can be tested
 * without a machine.
 */
export async function captureProfileSnapshots(
  db: DatabaseSync,
  fetchProfile: (id: string) => Promise<Profile | null> = getProfile,
  now = Math.floor(Date.now() / 1000)
): Promise<number[]> {
  const rows = db
    .prepare(
      `SELECT s.id, s.profile_id, s.raw_slog FROM shots s
       LEFT JOIN shot_profiles sp ON sp.shot_id = s.id
       WHERE sp.shot_id IS NULL AND s.profile_id IS NOT NULL AND s.raw_slog IS NOT NULL AND s.incomplete = 0
         AND s.started_at + COALESCE(s.duration_ms, 0) / 1000 >= ?
       ORDER BY s.started_at`
    )
    .all(now - CAPTURE_WINDOW_S) as Array<{ id: number; profile_id: string; raw_slog: Uint8Array }>;
  if (!rows.length) return [];

  const profiles = new Map<string, Profile | null>();
  const link = db.prepare("INSERT OR IGNORE INTO shot_profiles (shot_id, snapshot_id, captured_at) VALUES (?, ?, ?)");
  const captured: number[] = [];
  for (const row of rows) {
    let parsed: ShotData;
    try { parsed = parseSlog(Buffer.from(row.raw_slog), row.id); } catch { continue; }
    if (!profiles.has(row.profile_id)) {
      let profile: Profile | null = null;
      try { profile = await fetchProfile(row.profile_id); } catch { profile = null; }
      profiles.set(row.profile_id, profile);
    }
    const profile = profiles.get(row.profile_id);
    // Unreachable: the next pass tries again while the window is open.
    if (!profile || !matchesLog(profile, parsed.phases) || !setpointsAgree(profile, parsed)) continue;
    link.run(row.id, storeSnapshot(db, profile, now), now);
    captured.push(row.id);
  }
  return captured;
}

export interface SnapshotMeta {
  id: number;
  profile_id: string;
  label: string | null;
  content_hash: string;
  first_seen_at: number;
}

export function snapshotForShot(db: DatabaseSync, shotId: number): (SnapshotMeta & { profile: Profile }) | null {
  const row = db
    .prepare(
      `SELECT ps.id, ps.profile_id, ps.label, ps.content_hash, ps.first_seen_at, ps.profile_json
       FROM shot_profiles sp JOIN profile_snapshots ps ON ps.id = sp.snapshot_id WHERE sp.shot_id = ?`
    )
    .get(shotId) as (SnapshotMeta & { profile_json: string }) | undefined;
  if (!row) return null;
  const { profile_json, ...meta } = row;
  try { return { ...meta, profile: JSON.parse(profile_json) as Profile }; } catch { return null; }
}

/** Phase indices the profile itself calls preinfusion. */
export function preinfusionPhasesOf(profile: Profile): Set<number> {
  return new Set((profile.phases ?? []).flatMap((phase, i) => (phase.phase === "preinfusion" ? [i] : [])));
}

export interface PlannedPhase {
  index: number;
  name: string;
  type: ProfilePhase["phase"];
  pump: ProfilePhase["pump"];
  /** The phase's own setpoint; 0 means it follows the profile's temperature. */
  temperature: number;
  max_duration_s: number;
  transition: ProfilePhase["transition"];
  exits: ProfilePhase["targets"];
  /**
   * ran; skipped — a later phase ran but this one never did, because its exit
   * condition held on entry; not_reached — the shot ended before it.
   */
  status: "ran" | "skipped" | "not_reached";
  start_s: number | null;
  duration_s: number | null;
  /** For a skipped phase, the exit that already held when it was due, if the log shows one. */
  skip_reason: { type: string; value: number; measured: number } | null;
}

/** What a sample reads for an exit condition's quantity, where the log has it. */
function measuredFor(type: string, sample: ShotData["samples"][number]): number | null {
  if (type === "pressure") return typeof sample.cp === "number" ? sample.cp : null;
  if (type === "volumetric") return typeof sample.v === "number" ? sample.v : null;
  if (type === "flow") return typeof sample.pf === "number" ? sample.pf : null;
  return null; // "pumped" is a per-phase total the log does not carry
}

/**
 * The profile's plan laid over what the log shows. Shot 50 is the case this
 * exists for: 9.9 bar left in the boiler met the preinfusion's "≥ 4 bar" exit
 * on the first sample, and the log alone says only "Hold > Decline".
 */
export function phasePlan(profile: Profile, shot: ShotData): PlannedPhase[] {
  const samples = shot.samples;
  const at = (index: number) => (samples[Math.min(index, samples.length - 1)]?.t ?? 0) / 1000;
  const ran = new Map(shot.phases.map((t, i) => [t.phaseNumber, i]));
  const lastRan = Math.max(-1, ...shot.phases.map((t) => t.phaseNumber));
  return (profile.phases ?? []).map((phase, index) => {
    const base = {
      index, name: phase.name, type: phase.phase, pump: phase.pump, temperature: phase.temperature,
      max_duration_s: phase.duration, transition: phase.transition, exits: phase.targets ?? [],
    };
    const k = ran.get(index);
    if (k != null) {
      const start = at(shot.phases[k].sampleIndex);
      const next = shot.phases[k + 1];
      const end = next ? at(next.sampleIndex) : at(samples.length - 1);
      return { ...base, status: "ran" as const, start_s: start, duration_s: Math.max(0, end - start), skip_reason: null };
    }
    if (index > lastRan) return { ...base, status: "not_reached" as const, start_s: null, duration_s: null, skip_reason: null };
    // Skipped: its exits are judged at the sample where the next phase that ran began.
    const following = shot.phases.find((t) => t.phaseNumber > index);
    const sample = following ? samples[following.sampleIndex] : undefined;
    let reason: PlannedPhase["skip_reason"] = null;
    for (const exit of phase.targets ?? []) {
      const measured = sample ? measuredFor(exit.type, sample) : null;
      if (measured == null) continue;
      const met = exit.operator === "lte" ? measured <= exit.value : measured >= exit.value;
      if (met) { reason = { type: exit.type, value: exit.value, measured: Math.round(measured * 10) / 10 }; break; }
    }
    return { ...base, status: "skipped" as const, start_s: null, duration_s: null, skip_reason: reason };
  });
}

export interface SnapshotListing extends SnapshotMeta {
  shots: number;
  first_shot_at: number | null;
  last_shot_at: number | null;
}

/** Every stored version, newest first within each profile. */
export function listSnapshots(db: DatabaseSync): SnapshotListing[] {
  return db
    .prepare(
      `SELECT ps.id, ps.profile_id, ps.label, ps.content_hash, ps.first_seen_at,
              COUNT(sp.shot_id) AS shots, MIN(s.started_at) AS first_shot_at, MAX(s.started_at) AS last_shot_at
       FROM profile_snapshots ps
       LEFT JOIN shot_profiles sp ON sp.snapshot_id = ps.id
       LEFT JOIN shots s ON s.id = sp.shot_id
       GROUP BY ps.id
       ORDER BY ps.label COLLATE NOCASE, ps.profile_id, ps.first_seen_at DESC`
    )
    .all() as unknown as SnapshotListing[];
}

/** One version as a download: the profile verbatim, as the machine returned it. */
export function snapshotDownload(db: DatabaseSync, snapshotId: number): { filename: string; json: string } | null {
  const row = db.prepare("SELECT label, profile_id, content_hash, profile_json FROM profile_snapshots WHERE id = ?").get(snapshotId) as
    | { label: string | null; profile_id: string; content_hash: string; profile_json: string }
    | undefined;
  if (!row) return null;
  const base = (row.label || row.profile_id).replace(/[^\p{L}\p{N}._ -]+/gu, "").trim().replace(/\s+/g, "-") || "profile";
  return { filename: `${base}-${row.content_hash.slice(0, 8)}.json`, json: row.profile_json };
}
