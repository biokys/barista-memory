import type { DatabaseSync } from "node:sqlite";

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
              stable_weight_source AS weight_source
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

  return { totals, perBean, points, consistency };
}
