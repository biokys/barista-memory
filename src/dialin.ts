import type { DatabaseSync } from "node:sqlite";
import type { ShotContextRow } from "./db/db.js";
import { getCoffee, type CoffeeRow } from "./coffees.js";

/**
 * Dialling in, from the archive: where to start a coffee, and what the last
 * shot says about the next one. Rules only — a short verdict from time and
 * ratio against the coffee's own targets, phrased by the caller (web
 * dictionary, receipt dictionary), never generated text.
 */

/** A ratio this far from the target, either way, is worth a remark. */
const RATIO_TOLERANCE = 0.1;
/** Outside the time window by more than this fraction of it: a big step, not a nudge. */
const LARGE_STEP_FRACTION = 0.5;

export interface Suggestion {
  /** Where the numbers come from: this coffee's own history, the same roaster, everything, or nothing. */
  source: "coffee" | "roaster" | "global" | "none";
  grind_setting: string | null;
  dose_g: number | null;
  /** What that grind and dose produced, on average. */
  ratio: number | null;
  seconds: number | null;
  rating: number | null;
  shots: number;
  /** The coffee the numbers were taken from, when not this one. */
  from_coffee: string | null;
}

interface Group {
  grind_setting: string | null;
  dose_g: number | null;
  n: number;
  avg_rating: number | null;
  rated: number;
  avg_ratio: number | null;
  avg_seconds: number | null;
  last_at: number;
  bean: string | null;
}

/**
 * The best grind/dose pair among shots matching `where`: the highest-rated
 * pair when any shot was rated, else the most recent — what someone who
 * kept notes would read back.
 */
function bestGroup(db: DatabaseSync, where: string, params: Array<string | number>): Group | null {
  const groups = db
    .prepare(
      `SELECT grind_setting, dose_g, COUNT(*) AS n,
              AVG(rating) AS avg_rating, COUNT(rating) AS rated,
              ROUND(AVG(ratio), 2) AS avg_ratio, ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_seconds,
              MAX(started_at) AS last_at, MAX(bean) AS bean
       FROM shot_context WHERE grind_setting IS NOT NULL AND ${where}
       GROUP BY grind_setting, dose_g`
    )
    .all(...params) as unknown as Group[];
  if (!groups.length) return null;
  const rated = groups.filter((g) => g.rated > 0 && g.avg_rating != null);
  if (rated.length) {
    rated.sort((a, b) => (b.avg_rating! - a.avg_rating!) || (b.last_at - a.last_at));
    return rated[0];
  }
  groups.sort((a, b) => b.last_at - a.last_at);
  return groups[0];
}

export function suggestFor(db: DatabaseSync, coffeeId: number): Suggestion {
  const coffee = getCoffee(db, coffeeId);
  const none: Suggestion = { source: "none", grind_setting: null, dose_g: null, ratio: null, seconds: null, rating: null, shots: 0, from_coffee: null };
  if (!coffee) return none;
  const pick = (source: Suggestion["source"], g: Group | null, fromCoffee: string | null): Suggestion | null =>
    g && {
      source,
      grind_setting: g.grind_setting,
      dose_g: g.dose_g,
      ratio: g.avg_ratio,
      seconds: g.avg_seconds,
      rating: g.avg_rating != null ? Math.round(g.avg_rating * 10) / 10 : null,
      shots: g.n,
      from_coffee: fromCoffee,
    };
  const own = bestGroup(db, "coffee_id = ?", [coffee.id]);
  if (own) return pick("coffee", own, null)!;
  if (coffee.roaster) {
    const sameRoaster = bestGroup(db, "roaster = ? AND coffee_id != ?", [coffee.roaster, coffee.id]);
    if (sameRoaster) return pick("roaster", sameRoaster, sameRoaster.bean)!;
  }
  const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
  const global = bestGroup(db, "started_at >= ?", [ninetyDaysAgo]);
  if (global) return pick("global", global, global.bean)!;
  return none;
}

export type VerdictCode = "on_target" | "too_fast" | "too_slow" | "ratio_low" | "ratio_high" | "no_targets" | "no_data";

export interface Verdict {
  shot_id: number;
  code: VerdictCode;
  /** For too_fast / too_slow: how far outside the window the shot fell. */
  step: "small" | "large" | null;
  seconds: number | null;
  ratio: number | null;
  targets: { time_min_s: number | null; time_max_s: number | null; ratio: number | null } | null;
  coffee: string | null;
}

/** Judge a shot against its coffee's targets. Time first: it is what the grinder changes. */
export function verdictFor(db: DatabaseSync, context: ShotContextRow): Verdict {
  const coffee: CoffeeRow | null = context.coffee_id != null ? getCoffee(db, context.coffee_id) : null;
  const seconds = context.duration_ms != null ? Math.round(context.duration_ms / 100) / 10 : null;
  const base = { shot_id: context.id, seconds, ratio: context.ratio, coffee: coffee?.name ?? null };
  const hasTime = coffee != null && (coffee.target_time_min_s != null || coffee.target_time_max_s != null);
  const hasRatio = coffee != null && coffee.target_ratio != null;
  if (!coffee || (!hasTime && !hasRatio)) return { ...base, code: "no_targets", step: null, targets: null };
  const targets = { time_min_s: coffee.target_time_min_s, time_max_s: coffee.target_time_max_s, ratio: coffee.target_ratio };
  if (seconds == null && context.ratio == null) return { ...base, code: "no_data", step: null, targets };

  if (hasTime && seconds != null) {
    const min = coffee.target_time_min_s, max = coffee.target_time_max_s;
    const width = min != null && max != null ? Math.max(1, max - min) : 10;
    if (min != null && seconds < min) return { ...base, code: "too_fast", step: min - seconds > width * LARGE_STEP_FRACTION ? "large" : "small", targets };
    if (max != null && seconds > max) return { ...base, code: "too_slow", step: seconds - max > width * LARGE_STEP_FRACTION ? "large" : "small", targets };
  }
  if (hasRatio && context.ratio != null) {
    const target = coffee.target_ratio!;
    if (context.ratio < target * (1 - RATIO_TOLERANCE)) return { ...base, code: "ratio_low", step: null, targets };
    if (context.ratio > target * (1 + RATIO_TOLERANCE)) return { ...base, code: "ratio_high", step: null, targets };
  }
  return { ...base, code: "on_target", step: null, targets };
}

export function verdictForShot(db: DatabaseSync, shotId: number): Verdict | null {
  const context = db.prepare("SELECT * FROM shot_context WHERE id = ?").get(shotId) as unknown as ShotContextRow | undefined;
  return context ? verdictFor(db, context) : null;
}
