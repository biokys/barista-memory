import type { DatabaseSync } from "node:sqlite";
import { parseSlog } from "./device/client.js";
import { transformShotForAI } from "./device/shotTransformer.js";

/**
 * Aggregates the web's statistics screen draws from. Kept in SQL where SQLite
 * can do it, so the numbers match what a query over shot_context would give.
 */
export function statsSummary(db: DatabaseSync) {
  const perBean = db
    .prepare(
      `SELECT COALESCE(bean, '') AS bean, COALESCE(roaster, '') AS roaster,
              COUNT(*) AS shots,
              ROUND(AVG(ratio), 2) AS avg_ratio,
              ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_seconds,
              ROUND(AVG(rating), 2) AS avg_rating,
              MIN(started_at) AS first_at, MAX(started_at) AS last_at
       FROM shot_context GROUP BY bean, roaster ORDER BY last_at DESC`
    )
    .all();

  // One point per shot for the scatter plots; small enough to send whole.
  const points = db
    .prepare(
      `SELECT id, started_at, bean, grind_setting, dose_g, ratio,
              duration_ms / 1000.0 AS seconds, machine_settledness AS settledness, rating,
              stable_weight_source AS weight_source, era_event_id
       FROM shot_context WHERE ratio IS NOT NULL ORDER BY started_at`
    )
    .all();

  // Consistency: spread of extraction time within one bean+grind — the number
  // that says how repeatable the puck prep is.
  const consistency = db
    .prepare(
      `SELECT bean, grind_setting, COUNT(*) AS n,
              ROUND(AVG(duration_ms) / 1000.0, 1) AS mean_s,
              ROUND(SQRT(AVG(duration_ms * duration_ms) - AVG(duration_ms) * AVG(duration_ms)) / 1000.0, 1) AS sd_s
       FROM shot_context WHERE bean IS NOT NULL AND grind_setting IS NOT NULL
       GROUP BY bean, grind_setting HAVING n >= 3 ORDER BY n DESC`
    )
    .all();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS shots, COUNT(DISTINCT bean) AS beans, MIN(started_at) AS since,
              SUM(CASE WHEN stable_weight_source = 'curve' THEN 1 ELSE 0 END) AS weight_from_curve,
              SUM(CASE WHEN stable_weight_source = 'none' THEN 1 ELSE 0 END) AS no_weight
       FROM shot_context`
    )
    .get();

  // Per era: the shots between consecutive events, so "before the WDT" and
  // "after the WDT" can be set side by side.
  const perEra = db
    .prepare(
      `SELECT e.id, e.at, e.kind, e.title,
              COUNT(c.id) AS shots,
              ROUND(AVG(c.ratio), 2) AS avg_ratio,
              ROUND(AVG(c.duration_ms) / 1000.0, 1) AS avg_seconds,
              ROUND(AVG(c.rating), 2) AS avg_rating
       FROM events e LEFT JOIN shot_context c ON c.era_event_id = e.id
       GROUP BY e.id ORDER BY e.at DESC`
    )
    .all();

  return {
    totals, perBean, points, consistency, perEra,
    reference: referenceCurves(db),
    ageing: ageingFits(db),
    control: controlCharts(db),
  };
}

// ---------------------------------------------------------------------------
// Reference curves: the median curve of a bean at one grind, with its
// interquartile band, and the latest shot drawn over it. The anomaly rules
// compare against the same kind of baseline but only report a number; this
// is the picture that says *where* a shot strays.

/** A reference is built from at most this many of the latest shots: recent, and bounded parsing. */
const REFERENCE_MAX = 20;
/** Fewer shots than this make no band worth drawing. */
const REFERENCE_MIN = 3;
const REFERENCE_STEP_S = 0.5;
const REFERENCE_MAX_S = 90;

interface Band { median: Array<number | null>; lo: Array<number | null>; hi: Array<number | null> }
interface Traces { pressure: Array<number | null>; flow: Array<number | null>; weight: Array<number | null> }

export interface ReferenceGroup {
  bean: string;
  grind_setting: number;
  dose_g: number | null;
  /** Shots behind the band; the latest is not among them when there are enough without it. */
  n: number;
  latest_id: number;
  latest_at: number;
  step_s: number;
  pressure: Band;
  flow: Band;
  weight: Band;
  latest: Traces;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** A shot's curve held on the shared grid; null past its end, pressure null past the extraction. */
function tracesOnGrid(slog: Uint8Array, shotId: number, steps: number): Traces {
  const shot = transformShotForAI(parseSlog(Buffer.from(slog), shotId), true);
  const points = (shot.full_curve ?? []) as Array<{ time_seconds: number; pressure_bar: number; flow_ml_s: number; weight_g: number }>;
  const duration = shot.metadata.duration_seconds;
  const pressureEnd = shot.metadata.extraction_end_seconds ?? duration;
  const pressure: Array<number | null> = [], flow: Array<number | null> = [], weight: Array<number | null> = [];
  let i = 0;
  for (let k = 0; k < steps; k++) {
    const t = k * REFERENCE_STEP_S;
    if (t > duration || points.length === 0) { pressure.push(null); flow.push(null); weight.push(null); continue; }
    while (i + 1 < points.length && points[i + 1].time_seconds <= t) i++;
    const p = points[i];
    pressure.push(t <= pressureEnd ? p.pressure_bar : null);
    flow.push(p.flow_ml_s);
    weight.push(p.weight_g);
  }
  return { pressure, flow, weight };
}

function bandOf(traces: Array<Array<number | null>>, steps: number): Band {
  const median: Array<number | null> = [], lo: Array<number | null> = [], hi: Array<number | null> = [];
  for (let k = 0; k < steps; k++) {
    const values = traces.map((tr) => tr[k]).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (values.length < REFERENCE_MIN) { median.push(null); lo.push(null); hi.push(null); continue; }
    median.push(Math.round(quantile(values, 0.5) * 100) / 100);
    lo.push(Math.round(quantile(values, 0.25) * 100) / 100);
    hi.push(Math.round(quantile(values, 0.75) * 100) / 100);
  }
  return { median, lo, hi };
}

export function referenceCurves(db: DatabaseSync): ReferenceGroup[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.started_at, c.bean, c.grind_setting, c.dose_g, c.duration_ms, s.raw_slog
       FROM shot_context c JOIN shots s ON s.id = c.id
       WHERE c.bean IS NOT NULL AND c.grind_setting IS NOT NULL AND s.raw_slog IS NOT NULL AND c.incomplete = 0
       ORDER BY c.started_at DESC`
    )
    .all() as Array<{ id: number; started_at: number; bean: string; grind_setting: number; dose_g: number | null; duration_ms: number | null; raw_slog: Uint8Array }>;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.bean}|${row.grind_setting}`;
    const list = groups.get(key) ?? [];
    if (list.length < REFERENCE_MAX) list.push(row);
    groups.set(key, list);
  }

  const out: ReferenceGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < REFERENCE_MIN) continue;
    const longest = Math.min(REFERENCE_MAX_S, Math.max(...list.map((r) => (r.duration_ms ?? 0) / 1000)));
    const steps = Math.floor(longest / REFERENCE_STEP_S) + 1;
    const traced = list.map((r) => ({ row: r, traces: tracesOnGrid(r.raw_slog, r.id, steps) }));
    const latest = traced[0];
    // Judged against its predecessors, like the anomaly baseline, unless that
    // would leave too few.
    const behind = traced.length > REFERENCE_MIN ? traced.slice(1) : traced;
    out.push({
      bean: latest.row.bean,
      grind_setting: latest.row.grind_setting,
      dose_g: latest.row.dose_g,
      n: behind.length,
      latest_id: latest.row.id,
      latest_at: latest.row.started_at,
      step_s: REFERENCE_STEP_S,
      pressure: bandOf(behind.map((b) => b.traces.pressure), steps),
      flow: bandOf(behind.map((b) => b.traces.flow), steps),
      weight: bandOf(behind.map((b) => b.traces.weight), steps),
      latest: latest.traces,
    });
  }
  // Newest group first, so the web's default is what was pulled last.
  return out.sort((a, b) => b.latest_at - a.latest_at);
}

// ---------------------------------------------------------------------------
// Ageing: extraction time against the age of the bag at one grind, as a
// least-squares line with its 95 % band. The slope is what dial-in needs:
// how much a week costs in seconds, hence how many steps finer.

/** A fit needs this many shots on this many distinct days at one grind. */
const AGEING_MIN_SHOTS = 5;
const AGEING_MIN_DAYS = 3;
/** Two-sided 97.5 % Student t by degrees of freedom 1..30; 1.96 beyond. */
const T_975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

export interface LinearFit {
  grind_setting: number;
  n: number;
  days: number;
  x_min: number;
  x_max: number;
  slope: number;
  slope_se: number;
  intercept: number;
  r2: number;
  /** What the client needs to draw the band: residual SD, mean x, Sxx and the t quantile. */
  resid_sd: number;
  x_mean: number;
  sxx: number;
  t_crit: number;
}

export interface AgeingSeries {
  bean: string;
  roaster: string | null;
  roast_date: string | null;
  /** Days count from the roast date when known, else from the bag's first archived shot. */
  since: "roast" | "first_shot";
  points: Array<{ id: number; started_at: number; days: number; seconds: number; grind_setting: number }>;
  fits: LinearFit[];
}

function linearFit(xs: number[], ys: number[]): Omit<LinearFit, "grind_setting" | "n" | "days" | "x_min" | "x_max"> | null {
  const n = xs.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - xMean) ** 2;
    sxy += (xs[i] - xMean) * (ys[i] - yMean);
    syy += (ys[i] - yMean) ** 2;
  }
  if (sxx === 0 || n < 3) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const sse = Math.max(0, syy - slope * sxy);
  const residSd = Math.sqrt(sse / (n - 2));
  const df = n - 2;
  return {
    slope,
    slope_se: residSd / Math.sqrt(sxx),
    intercept,
    r2: syy === 0 ? 1 : 1 - sse / syy,
    resid_sd: residSd,
    x_mean: xMean,
    sxx,
    t_crit: T_975[Math.min(df, T_975.length) - 1] ?? 1.96,
  };
}

export function ageingFits(db: DatabaseSync): AgeingSeries[] {
  const rows = db
    .prepare(
      `SELECT id, started_at, bean, roaster, roast_date, grind_setting, duration_ms / 1000.0 AS seconds
       FROM shot_context WHERE bean IS NOT NULL AND grind_setting IS NOT NULL AND duration_ms IS NOT NULL
       ORDER BY started_at`
    )
    .all() as Array<{ id: number; started_at: number; bean: string; roaster: string | null; roast_date: string | null; grind_setting: number; seconds: number }>;

  const bags = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.bean}|${row.roaster ?? ""}|${row.roast_date ?? ""}`;
    bags.set(key, [...(bags.get(key) ?? []), row]);
  }

  const out: AgeingSeries[] = [];
  for (const list of bags.values()) {
    const first = list[0];
    const roast = first.roast_date ? Date.parse(first.roast_date + "T00:00:00Z") / 1000 : null;
    const origin = roast ?? first.started_at;
    const points = list.map((r) => ({
      id: r.id, started_at: r.started_at, grind_setting: r.grind_setting, seconds: Math.round(r.seconds * 10) / 10,
      days: Math.round(((r.started_at - origin) / 86400) * 100) / 100,
    }));
    const fits: LinearFit[] = [];
    const byGrind = new Map<number, typeof points>();
    for (const p of points) byGrind.set(p.grind_setting, [...(byGrind.get(p.grind_setting) ?? []), p]);
    for (const [grind, pts] of byGrind) {
      const days = new Set(pts.map((p) => Math.floor(p.days))).size;
      if (pts.length < AGEING_MIN_SHOTS || days < AGEING_MIN_DAYS) continue;
      const fit = linearFit(pts.map((p) => p.days), pts.map((p) => p.seconds));
      if (!fit) continue;
      fits.push({ grind_setting: grind, n: pts.length, days, x_min: Math.min(...pts.map((p) => p.days)), x_max: Math.max(...pts.map((p) => p.days)), ...fit });
    }
    if (points.length < AGEING_MIN_SHOTS) continue;
    out.push({ bean: first.bean, roaster: first.roaster, roast_date: first.roast_date, since: roast != null ? "roast" : "first_shot", points, fits });
  }
  return out.sort((a, b) => b.points[b.points.length - 1].started_at - a.points[a.points.length - 1].started_at);
}

// ---------------------------------------------------------------------------
// Control chart: extraction time and ratio shot by shot, with the centre and
// limits of each stretch pulled the same way (bean, grind, dose). A point
// outside says "something changed", as opposed to "a different coffee".

/** A stretch shorter than this gets no limits. */
const SPC_MIN_SHOTS = 4;
/** Limits at ±2σ: with ten shots a stretch, the textbook 3σ never speaks. */
const SPC_SIGMAS = 2;
/** σ from the mean moving range of consecutive shots (d2 for n = 2), the individuals-chart estimate: unlike the plain SD it is not inflated by a drift. */
const D2_MOVING_RANGE = 1.128;

export interface ControlLimits { center: number; sigma: number; lcl: number; ucl: number; cv_pct: number; outside: number }

export interface ControlSegment {
  index: number;
  bean: string;
  grind_setting: number;
  dose_g: number | null;
  from_seq: number;
  to_seq: number;
  n: number;
  seconds: ControlLimits | null;
  ratio: ControlLimits | null;
}

export interface ControlPoint {
  seq: number; id: number; started_at: number; bean: string; grind_setting: number;
  seconds: number; ratio: number | null; segment: number | null; out_seconds: boolean; out_ratio: boolean;
}

function limitsOf(values: number[]): ControlLimits | null {
  if (values.length < SPC_MIN_SHOTS) return null;
  const n = values.length;
  const center = values.reduce((a, b) => a + b, 0) / n;
  let mr = 0;
  for (let i = 1; i < n; i++) mr += Math.abs(values[i] - values[i - 1]);
  const sigma = mr / (n - 1) / D2_MOVING_RANGE;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - center) ** 2, 0) / (n - 1));
  const lcl = center - SPC_SIGMAS * sigma, ucl = center + SPC_SIGMAS * sigma;
  return {
    center, sigma, lcl, ucl,
    cv_pct: center > 0 ? (sd / center) * 100 : 0,
    outside: values.filter((v) => v < lcl || v > ucl).length,
  };
}

export function controlCharts(db: DatabaseSync): { points: ControlPoint[]; segments: ControlSegment[] } {
  const rows = db
    .prepare(
      `SELECT id, started_at, bean, grind_setting, dose_g, duration_ms / 1000.0 AS seconds, ratio
       FROM shot_context WHERE bean IS NOT NULL AND grind_setting IS NOT NULL AND duration_ms IS NOT NULL
       ORDER BY started_at`
    )
    .all() as Array<{ id: number; started_at: number; bean: string; grind_setting: number; dose_g: number | null; seconds: number; ratio: number | null }>;

  const segments: ControlSegment[] = [];
  const points: ControlPoint[] = [];
  let run: typeof rows = [];
  const close = () => {
    if (!run.length) return;
    const first = run[0];
    const seconds = limitsOf(run.map((r) => r.seconds));
    const ratios = run.map((r) => r.ratio).filter((r): r is number => r != null);
    const ratio = ratios.length === run.length ? limitsOf(ratios) : null;
    const index = segments.length;
    const fromSeq = points.length + 1;
    segments.push({ index, bean: first.bean, grind_setting: first.grind_setting, dose_g: first.dose_g, from_seq: fromSeq, to_seq: fromSeq + run.length - 1, n: run.length, seconds, ratio });
    for (const r of run) {
      points.push({
        seq: points.length + 1, id: r.id, started_at: r.started_at, bean: r.bean, grind_setting: r.grind_setting,
        seconds: Math.round(r.seconds * 10) / 10, ratio: r.ratio, segment: seconds || ratio ? index : null,
        out_seconds: seconds != null && (r.seconds < seconds.lcl || r.seconds > seconds.ucl),
        out_ratio: ratio != null && r.ratio != null && (r.ratio < ratio.lcl || r.ratio > ratio.ucl),
      });
    }
    run = [];
  };
  let key: string | null = null;
  for (const row of rows) {
    const k = `${row.bean}|${row.grind_setting}|${row.dose_g ?? ""}`;
    if (k !== key) { close(); key = k; }
    run.push(row);
  }
  close();
  return { points, segments };
}
