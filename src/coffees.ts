import type { DatabaseSync } from "node:sqlite";

/**
 * Coffees as identities. A setup period points at one; the same bag bought
 * again is the same row, which is what "how did this one grind last time"
 * and "how does it age" need. The name and roaster are the identity, both
 * trimmed, roaster optional — see the unique index in schema.sql.
 */

export interface CoffeeRow {
  id: number;
  name: string;
  roaster: string | null;
  origin: string | null;
  process: string | null;
  roast_level: string | null;
  bag_g: number | null;
  target_time_min_s: number | null;
  target_time_max_s: number | null;
  target_ratio: number | null;
  note: string | null;
  archived: number;
  created_at: number;
}

export interface CoffeeInput {
  name?: string;
  roaster?: string | null;
  origin?: string | null;
  process?: string | null;
  roast_level?: string | null;
  bag_g?: number | null;
  target_time_min_s?: number | null;
  target_time_max_s?: number | null;
  target_ratio?: number | null;
  note?: string | null;
  archived?: boolean;
}

/** A coffee with what the archive knows about its use. */
export interface CoffeeSummary extends CoffeeRow {
  shots: number;
  first_at: number | null;
  last_at: number | null;
  avg_rating: number | null;
  avg_ratio: number | null;
  avg_seconds: number | null;
  /** Distinct roast dates it was recorded with: bags, roughly. */
  bags: number;
  /** The setup in force right now uses it. */
  in_use: boolean;
}

const TEXT_FIELDS = ["name", "roaster", "origin", "process", "roast_level", "note"] as const;
const NUMBER_FIELDS = ["bag_g", "target_time_min_s", "target_time_max_s", "target_ratio"] as const;

function text(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function number(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${value}`);
  return n;
}

export function getCoffee(db: DatabaseSync, id: number): CoffeeRow | null {
  return (db.prepare("SELECT * FROM coffees WHERE id = ?").get(id) as unknown as CoffeeRow | undefined) ?? null;
}

export function findCoffee(db: DatabaseSync, name: string, roaster: string | null): CoffeeRow | null {
  const row = db
    .prepare("SELECT * FROM coffees WHERE name = ? AND COALESCE(roaster, '') = ?")
    .get(name, roaster ?? "") as unknown as CoffeeRow | undefined;
  return row ?? null;
}

/**
 * The coffee a free-text bean/roaster pair names, created if it is new. This
 * keeps every path that still speaks in text — the MCP tools, the controls
 * panel — feeding the same table the picker reads from.
 */
export function findOrCreateCoffee(db: DatabaseSync, name: string, roaster: string | null): CoffeeRow {
  const cleanName = text(name);
  if (!cleanName) throw new Error("A coffee needs a name");
  const cleanRoaster = text(roaster);
  const existing = findCoffee(db, cleanName, cleanRoaster);
  if (existing) return existing;
  return createCoffee(db, { name: cleanName, roaster: cleanRoaster });
}

export function createCoffee(db: DatabaseSync, input: CoffeeInput): CoffeeRow {
  const name = text(input.name);
  if (!name) throw new Error("A coffee needs a name");
  const roaster = text(input.roaster);
  if (findCoffee(db, name, roaster)) throw new Error("COFFEE_EXISTS");
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO coffees (name, roaster, origin, process, roast_level, bag_g, target_time_min_s, target_time_max_s, target_ratio, note, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name, roaster, text(input.origin), text(input.process), text(input.roast_level),
      number(input.bag_g), number(input.target_time_min_s), number(input.target_time_max_s), number(input.target_ratio),
      text(input.note), input.archived ? 1 : 0, now
    );
  return getCoffee(db, Number(result.lastInsertRowid))!;
}

export function updateCoffee(db: DatabaseSync, id: number, change: CoffeeInput): CoffeeRow | null {
  const existing = getCoffee(db, id);
  if (!existing) return null;
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  for (const field of TEXT_FIELDS) {
    if (!(field in change)) continue;
    const value = text(change[field]);
    if (field === "name" && !value) throw new Error("A coffee needs a name");
    assignments.push(`${field} = ?`);
    values.push(value);
  }
  for (const field of NUMBER_FIELDS) {
    if (!(field in change)) continue;
    assignments.push(`${field} = ?`);
    values.push(number(change[field]));
  }
  if (change.archived !== undefined) {
    assignments.push("archived = ?");
    values.push(change.archived ? 1 : 0);
  }
  if (assignments.length === 0) return existing;
  // A rename must not collide with another coffee's identity.
  const name = "name" in change ? text(change.name)! : existing.name;
  const roaster = "roaster" in change ? text(change.roaster) : existing.roaster;
  const clash = findCoffee(db, name, roaster);
  if (clash && clash.id !== id) throw new Error("COFFEE_EXISTS");
  db.prepare(`UPDATE coffees SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  return getCoffee(db, id);
}

const SUMMARY_SQL = `
  SELECT c.*,
         COUNT(s.id) AS shots,
         MIN(s.started_at) AS first_at,
         MAX(s.started_at) AS last_at,
         ROUND(AVG(s.rating), 2) AS avg_rating,
         ROUND(AVG(s.ratio), 2) AS avg_ratio,
         ROUND(AVG(s.duration_ms) / 1000.0, 1) AS avg_seconds,
         (SELECT COUNT(DISTINCT roast_date) FROM setups su WHERE su.coffee_id = c.id AND su.roast_date IS NOT NULL) AS bags
  FROM coffees c
  LEFT JOIN shot_context s ON s.coffee_id = c.id`;

export function listCoffees(db: DatabaseSync, includeArchived = false): CoffeeSummary[] {
  const current = db
    .prepare("SELECT coffee_id FROM setups WHERE valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1")
    .get(Math.floor(Date.now() / 1000)) as { coffee_id: number | null } | undefined;
  const rows = db
    .prepare(`${SUMMARY_SQL} ${includeArchived ? "" : "WHERE c.archived = 0"} GROUP BY c.id ORDER BY last_at DESC NULLS LAST, c.name`)
    .all() as unknown as Array<Omit<CoffeeSummary, "in_use">>;
  return rows.map((row) => ({ ...row, in_use: row.id === current?.coffee_id }));
}

export function coffeeSummary(db: DatabaseSync, id: number): CoffeeSummary | null {
  const row = db.prepare(`${SUMMARY_SQL} WHERE c.id = ? GROUP BY c.id`).get(id) as unknown as Omit<CoffeeSummary, "in_use"> | undefined;
  if (!row || row.id == null) return null;
  const current = db
    .prepare("SELECT coffee_id FROM setups WHERE valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1")
    .get(Math.floor(Date.now() / 1000)) as { coffee_id: number | null } | undefined;
  return { ...row, in_use: row.id === current?.coffee_id };
}
