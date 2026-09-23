import type { DatabaseSync } from "node:sqlite";
import { parseSlog } from "./device/client.js";
import { transformShotForAI } from "./device/shotTransformer.js";

/**
 * What a shot's own curve says went wrong, and how far it strays from the
 * shots pulled the same way before it. Rules on the pressure, flow and
 * temperature traces — no model — cached in shot_analysis because the
 * comparison needs the neighbours' curves too, which is too much to parse
 * on every list. Bump ANALYSIS_VERSION when a rule changes and the daemon
 * recomputes every row at start, the same way stable weights are re-derived.
 */

export const ANALYSIS_VERSION = 1;

export type Flag = "channeling" | "choked" | "low_pressure" | "temperature_unstable" | "off_pattern";

export interface Analysis {
  shot_id: number;
  version: number;
  flags: Flag[];
  /** Relative RMS distance of the flow curve from the baseline's median, 0 = identical; null without a baseline. */
  deviation: number | null;
  /** How many earlier shots of the same coffee, grind, dose and profile the baseline had. */
  baseline_shots: number;
  computed_at: number;
}

// Channeling: during the main extraction a channel opens, pressure falls by
// this much within CHANNEL_WINDOW_S while flow jumps by CHANNEL_FLOW_RISE.
const CHANNEL_DROP_BAR = 1.5;
const CHANNEL_WINDOW_S = 3;
const CHANNEL_FLOW_RISE = 0.4;
/** Nothing in the cup after this long: the puck is choked. */
const CHOKED_FIRST_DRIP_S = 20;
/** A shot whose pump never got past this is not espresso. */
const LOW_PRESSURE_BAR = 5;
/** Temperature swing over the main extraction worth a remark. */
const TEMP_SWING_C = 3;
/** Baseline: at least this many earlier shots pulled the same way. */
const BASELINE_MIN = 3;
const BASELINE_MAX = 10;
/** Curves are compared on this grid, over their common length. */
const GRID_STEP_S = 0.5;
const GRID_MAX_S = 60;
/** Relative RMS distance from the baseline's median beyond which a shot is off pattern. */
const OFF_PATTERN = 0.4;

interface Point { time_seconds: number; pressure_bar: number; flow_ml_s: number; temperature_c: number; weight_g: number }
interface Phase { name: string; start_time_seconds: number; duration_seconds: number }

function curveOf(slog: Uint8Array, shotId: number) {
  const shot = transformShotForAI(parseSlog(Buffer.from(slog), shotId), true);
  return {
    points: (shot.full_curve ?? []) as Point[],
    phases: (shot.phases ?? []) as Phase[],
    preinfusion_s: shot.summary.extraction.preinfusion_time_seconds,
    duration_s: shot.metadata.duration_seconds,
    first_drip_s: shot.summary.flow.time_to_first_drip_seconds,
    max_bar: shot.summary.pressure.max_bar,
  };
}

/**
 * The stretch of the shot to judge: after preinfusion, before any phase the
 * profile itself lowers the pressure in (a decline or taper), which would
 * otherwise read as a channel opening.
 */
function mainWindow(c: ReturnType<typeof curveOf>): [number, number] {
  const decline = c.phases.find((p) => /decline|taper|ramp.?down|down/i.test(p.name));
  const end = decline ? decline.start_time_seconds : Math.max(0, c.duration_s - 2);
  return [c.preinfusion_s, end];
}

function ownFlags(c: ReturnType<typeof curveOf>): Flag[] {
  const flags: Flag[] = [];
  const [from, to] = mainWindow(c);
  const main = c.points.filter((p) => p.time_seconds >= from && p.time_seconds <= to);

  if (c.max_bar < LOW_PRESSURE_BAR && c.duration_s > 10) flags.push("low_pressure");
  if ((c.first_drip_s == null || c.first_drip_s > CHOKED_FIRST_DRIP_S) && c.duration_s > CHOKED_FIRST_DRIP_S) flags.push("choked");

  // Channeling: compare each sample with the ones up to CHANNEL_WINDOW_S before it.
  if (main.length > 4 && !flags.includes("low_pressure")) {
    for (let i = 1; i < main.length; i++) {
      const now = main[i];
      if (now.pressure_bar < LOW_PRESSURE_BAR) continue;
      for (let j = i - 1; j >= 0 && now.time_seconds - main[j].time_seconds <= CHANNEL_WINDOW_S; j--) {
        const then = main[j];
        if (then.pressure_bar - now.pressure_bar >= CHANNEL_DROP_BAR && now.flow_ml_s - then.flow_ml_s >= CHANNEL_FLOW_RISE) {
          flags.push("channeling");
          i = main.length; // one finding is enough
          break;
        }
      }
    }
  }

  const temps = main.map((p) => p.temperature_c).filter((t) => t > 0);
  if (temps.length > 4 && Math.max(...temps) - Math.min(...temps) > TEMP_SWING_C) flags.push("temperature_unstable");
  return flags;
}

/** Flow resampled on the shared grid, starting `from` seconds into the shot. */
function onGrid(points: Point[], from: number, length: number): number[] {
  const out: number[] = [];
  let i = 0;
  for (let t = from; t <= from + length; t += GRID_STEP_S) {
    while (i + 1 < points.length && points[i + 1].time_seconds <= t) i++;
    out.push(points[i]?.flow_ml_s ?? 0);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * How far the flow curve strays from the median of the earlier shots pulled
 * with the same coffee, grind, dose and profile — the shots that should
 * look alike. Curves are aligned at the end of preinfusion, not at the
 * start: a profile that leaves preinfusion on pressure or weight makes it
 * a different length every time, and compared from zero every shot looked
 * unlike every other. Relative RMS over the common length after that.
 */
function deviationFrom(db: DatabaseSync, shotId: number, own: ReturnType<typeof curveOf>): { deviation: number | null; baseline_shots: number } {
  const context = db
    .prepare("SELECT started_at, coffee_id, grind_setting, dose_g, profile_id FROM shot_context WHERE id = ?")
    .get(shotId) as { started_at: number; coffee_id: number | null; grind_setting: string | null; dose_g: number | null; profile_id: string | null } | undefined;
  if (!context || context.coffee_id == null || context.grind_setting == null) return { deviation: null, baseline_shots: 0 };
  const peers = db
    .prepare(
      `SELECT s.id, s.raw_slog FROM shot_context c JOIN shots s ON s.id = c.id
       WHERE c.coffee_id = ? AND c.grind_setting = ? AND c.dose_g IS ? AND c.profile_id IS ? AND c.started_at < ? AND s.raw_slog IS NOT NULL
       ORDER BY c.started_at DESC LIMIT ?`
    )
    .all(context.coffee_id, context.grind_setting, context.dose_g, context.profile_id, context.started_at, BASELINE_MAX) as Array<{ id: number; raw_slog: Uint8Array }>;
  if (peers.length < BASELINE_MIN) return { deviation: null, baseline_shots: peers.length };

  const curves = peers.map((p) => curveOf(p.raw_slog, p.id));
  const length = Math.min(GRID_MAX_S, own.duration_s - own.preinfusion_s, ...curves.map((c) => c.duration_s - c.preinfusion_s));
  if (length < 5) return { deviation: null, baseline_shots: peers.length };
  const ownGrid = onGrid(own.points, own.preinfusion_s, length);
  const peerGrids = curves.map((c) => onGrid(c.points, c.preinfusion_s, length));
  const med = ownGrid.map((_, i) => median(peerGrids.map((g) => g[i] ?? 0)));
  const scale = Math.max(0.3, med.reduce((a, b) => a + b, 0) / med.length);
  const rms = Math.sqrt(ownGrid.reduce((acc, v, i) => acc + (v - med[i]) ** 2, 0) / ownGrid.length);
  return { deviation: Math.round((rms / scale) * 100) / 100, baseline_shots: peers.length };
}

export function analyseShot(db: DatabaseSync, shotId: number, slog: Uint8Array): Analysis {
  const own = curveOf(slog, shotId);
  const flags = ownFlags(own);
  const { deviation, baseline_shots } = deviationFrom(db, shotId, own);
  if (deviation != null && deviation > OFF_PATTERN) flags.push("off_pattern");
  const analysis: Analysis = { shot_id: shotId, version: ANALYSIS_VERSION, flags, deviation, baseline_shots, computed_at: Math.floor(Date.now() / 1000) };
  db.prepare(
    `INSERT INTO shot_analysis (shot_id, version, flags, deviation, baseline_shots, computed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(shot_id) DO UPDATE SET version = excluded.version, flags = excluded.flags, deviation = excluded.deviation, baseline_shots = excluded.baseline_shots, computed_at = excluded.computed_at`
  ).run(shotId, ANALYSIS_VERSION, JSON.stringify(flags), deviation, baseline_shots, analysis.computed_at);
  return analysis;
}

export function getAnalysis(db: DatabaseSync, shotId: number): Analysis | null {
  const row = db.prepare("SELECT * FROM shot_analysis WHERE shot_id = ?").get(shotId) as any;
  return row ? { ...row, flags: JSON.parse(row.flags) } : null;
}

/** Analyses for many shots at once, for list rows. */
export function analysesFor(db: DatabaseSync, shotIds: number[]): Map<number, Analysis> {
  const out = new Map<number, Analysis>();
  if (!shotIds.length) return out;
  const rows = db.prepare(`SELECT * FROM shot_analysis WHERE shot_id IN (${shotIds.map(() => "?").join(",")})`).all(...shotIds) as any[];
  for (const row of rows) out.set(row.shot_id, { ...row, flags: JSON.parse(row.flags) });
  return out;
}

/**
 * Analyse the coffees that have no analysis, or one from an older rule set;
 * `all` redoes every shot. Oldest first, so each baseline is made of shots
 * that were analysed already — not that it matters for the result, but the
 * order makes a partial run leave a consistent prefix.
 */
export function recomputeAnalysis(db: DatabaseSync, all = false): number {
  const rows = db
    .prepare(
      `SELECT s.id, s.raw_slog FROM shots s LEFT JOIN shot_analysis a ON a.shot_id = s.id
       WHERE s.kind = 'shot' AND s.raw_slog IS NOT NULL ${all ? "" : "AND (a.shot_id IS NULL OR a.version < ?)"}
       ORDER BY s.started_at`
    )
    .all(...(all ? [] : [ANALYSIS_VERSION])) as Array<{ id: number; raw_slog: Uint8Array }>;
  let changed = 0;
  for (const row of rows) {
    try { analyseShot(db, row.id, row.raw_slog); changed++; } catch { /* a shot the parser cannot read is left without analysis */ }
  }
  return changed;
}
