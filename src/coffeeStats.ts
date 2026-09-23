import type { DatabaseSync } from "node:sqlite";
import { currentSetup } from "./db/db.js";
import { getCoffee, type CoffeeRow } from "./coffees.js";
import { getSetting } from "./settings.js";

/**
 * What the archive can say about a coffee over time: how it ages, and how
 * much of the bag is left. Both are derived on every read — a corrected
 * roast date or dose re-derives everything, nothing is stored.
 *
 * A "bag" is every period of the coffee that shares a roast date; two bags
 * with the same roast date merge, which is rare enough to accept over a
 * table of bags that would have to be kept in step with the periods.
 */

/** Below this many grams left, the stock is reported as low. */
export const STOCK_WARN_G_DEFAULT = 60;
/** A roast date this far off is a typo, not a very old bag. */
const MAX_AGE_DAYS = 365;

export interface AgingPoint {
  id: number;
  started_at: number;
  roast_date: string;
  /** Days between roast and shot, fractional. */
  days: number;
  seconds: number | null;
  ratio: number | null;
  rating: number | null;
  grind_setting: string | null;
}

export function agingPoints(db: DatabaseSync, coffeeId: number): AgingPoint[] {
  const rows = db
    .prepare(
      `SELECT id, started_at, roast_date,
              (started_at - strftime('%s', roast_date)) / 86400.0 AS days,
              duration_ms / 1000.0 AS seconds, ratio, rating, grind_setting
       FROM shot_context
       WHERE coffee_id = ? AND roast_date IS NOT NULL AND duration_ms IS NOT NULL
       ORDER BY started_at`
    )
    .all(coffeeId) as unknown as AgingPoint[];
  return rows.filter((r) => r.days != null && r.days >= 0 && r.days <= MAX_AGE_DAYS);
}

export interface Bag {
  roast_date: string | null;
  opened_at: number;
  last_at: number | null;
  shots: number;
  used_g: number | null;
  bag_g: number | null;
  remaining_g: number | null;
  /** Consumption over the days the bag has actually been in use. */
  g_per_day: number | null;
  days_left: number | null;
  /** The current setup grinds from this bag. */
  current: boolean;
}

export function bags(db: DatabaseSync, coffee: CoffeeRow): Bag[] {
  const current = currentSetup(db);
  const groups = db
    .prepare(
      `SELECT roast_date, MIN(valid_from) AS opened_at
       FROM setups WHERE coffee_id = ? GROUP BY roast_date ORDER BY opened_at DESC`
    )
    .all(coffee.id) as Array<{ roast_date: string | null; opened_at: number }>;
  const usage = db.prepare(
    `SELECT COUNT(*) AS shots, SUM(dose_g) AS used_g, MAX(started_at) AS last_at
     FROM shot_context WHERE coffee_id = ? AND roast_date IS ?`
  );
  const rows = groups.map((g) => {
    const u = usage.get(coffee.id, g.roast_date) as { shots: number; used_g: number | null; last_at: number | null };
    const used = u.shots > 0 ? u.used_g : 0;
    const remaining = coffee.bag_g != null && used != null ? Math.max(0, coffee.bag_g - used) : null;
    // Rate over the span actually brewed from, at least a day, so a bag
    // opened this morning does not extrapolate one shot into a kilo a week.
    const spanDays = u.last_at ? Math.max(1, (u.last_at - g.opened_at) / 86400) : null;
    const rate = spanDays && used ? used / spanDays : null;
    return {
      roast_date: g.roast_date,
      opened_at: g.opened_at,
      last_at: u.last_at,
      shots: u.shots,
      used_g: used != null ? Math.round(used * 10) / 10 : null,
      bag_g: coffee.bag_g,
      remaining_g: remaining != null ? Math.round(remaining * 10) / 10 : null,
      g_per_day: rate != null ? Math.round(rate * 10) / 10 : null,
      days_left: remaining != null && rate ? Math.round(remaining / rate) : null,
      current: current?.coffee_id === coffee.id && (current.roast_date ?? null) === g.roast_date,
    };
  });
  // Periods without a roast date and without shots are not a bag anyone
  // opened — a coffee switched to and away again — unless it is the current one.
  return rows.filter((b) => b.roast_date != null || b.shots > 0 || b.current);
}

export function stockWarnG(db: DatabaseSync): number {
  const n = Number(getSetting(db, "stock_warn_g", String(STOCK_WARN_G_DEFAULT)));
  return Number.isFinite(n) && n >= 0 ? n : STOCK_WARN_G_DEFAULT;
}

export interface Stock {
  coffee_id: number;
  name: string;
  roaster: string | null;
  roast_date: string | null;
  bag_g: number | null;
  used_g: number | null;
  remaining_g: number | null;
  g_per_day: number | null;
  days_left: number | null;
  /** Remaining is known and under the threshold. */
  low: boolean;
  warn_g: number;
}

/** The bag being ground from right now, or null when no coffee is set. */
export function currentStock(db: DatabaseSync): Stock | null {
  const setup = currentSetup(db);
  if (!setup?.coffee_id) return null;
  const coffee = getCoffee(db, setup.coffee_id);
  if (!coffee) return null;
  const bag = bags(db, coffee).find((b) => b.current) ?? null;
  const warn = stockWarnG(db);
  return {
    coffee_id: coffee.id,
    name: coffee.name,
    roaster: coffee.roaster,
    roast_date: setup.roast_date,
    bag_g: coffee.bag_g,
    used_g: bag?.used_g ?? null,
    remaining_g: bag?.remaining_g ?? null,
    g_per_day: bag?.g_per_day ?? null,
    days_left: bag?.days_left ?? null,
    low: bag?.remaining_g != null && bag.remaining_g < warn,
    warn_g: warn,
  };
}
