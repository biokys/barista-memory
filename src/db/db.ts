import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Bump when a migration is added below. */
const SCHEMA_VERSION = 7;

/**
 * Changes that CREATE ... IF NOT EXISTS cannot make on their own.
 *
 * An existing table keeps its original definition no matter what schema.sql
 * says, and an existing view is never redefined, so anything that alters either
 * has to be spelled out here. Each step must be safe to run against a fresh
 * database too, because a new file also starts at user_version 0.
 */
function migrate(db: DatabaseSync, from: number): void {
  // Version 2 only adds machine_state, which CREATE TABLE IF NOT EXISTS
  // handles on its own; no step is needed here.
  if (from < 7) {
    // Columns on an existing table, and a view that exposes them. Backfilling
    // is left to the recompute functions in ingest.ts, which need the parser
    // and the session logic and so do not belong in the storage layer.
    const columns = db.prepare("PRAGMA table_info(shots)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const wanted: Array<[string, string]> = [
      ["stable_weight_g", "REAL"],
      ["stable_weight_source", "TEXT"],
      ["machine_powered_for_s", "INTEGER"],
      ["machine_heating_for_s", "INTEGER"],
      ["machine_heatup_s", "INTEGER"],
      ["machine_settled", "INTEGER"],
      ["machine_settledness", "INTEGER"],
      ["kind", "TEXT NOT NULL DEFAULT 'shot'"],
      ["water_ml", "REAL"],
    ];
    if (names.size > 0) {
      for (const [name, type] of wanted) {
        if (!names.has(name)) db.exec(`ALTER TABLE shots ADD COLUMN ${name} ${type}`);
      }
    }
    const syncColumns = db.prepare("PRAGMA table_info(notes_sync)").all() as Array<{ name: string }>;
    if (syncColumns.length > 0 && !syncColumns.some((column) => column.name === "fingerprint")) {
      db.exec("ALTER TABLE notes_sync ADD COLUMN fingerprint TEXT");
    }
    db.exec("DROP VIEW IF EXISTS shot_context");
  }

  if (from < 1) {
    // setups.valid_from was UNIQUE, which forced two changes recorded in the
    // same second apart and pushed one into the future. Ties are broken by id
    // now, so the constraint has to go — and the view has to be rebuilt, since
    // its lookup gained the tie-break.
    db.exec("DROP VIEW IF EXISTS shot_context");
    const hasSetups = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'setups'")
      .get();
    if (hasSetups) {
      db.exec(`
        CREATE TABLE setups_migrated (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          valid_from    INTEGER NOT NULL,
          bean          TEXT,
          roaster       TEXT,
          roast_date    TEXT,
          grind_setting TEXT,
          dose_g        REAL,
          basket        TEXT,
          note          TEXT,
          created_at    INTEGER NOT NULL
        );
        INSERT INTO setups_migrated
          SELECT id, valid_from, bean, roaster, roast_date, grind_setting, dose_g, basket, note, created_at
          FROM setups;
        DROP TABLE setups;
        ALTER TABLE setups_migrated RENAME TO setups;
      `);
    }
  }
}

/**
 * The routines a Gaggia Classic needs, with the intervals usually quoted for
 * it. Inserted only when missing, so a changed interval is never overwritten.
 * Descaling and the water filter are by litres because scale comes from water,
 * not coffee; the gasket is by time. The filter starts disabled — not everyone
 * has one.
 */
function seedMaintenanceTypes(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO maintenance_types (key, sort, enabled, interval_shots, interval_water_l, interval_days) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run("backflush", 1, 1, 15, null, null);
  insert.run("cafiza", 2, 1, 60, null, null);
  // ~90 ml pass the boiler per coffee (measured), so 15 l is roughly 160
  // coffees — a few months at home use, the usual advice for medium-hard water.
  insert.run("descale", 3, 1, null, 15, null);
  insert.run("water_filter", 4, 0, null, 100, null);
  insert.run("gasket", 5, 0, null, null, 180);
}

/**
 * Open the archive, migrating and applying the schema.
 *
 * The schema is written entirely with IF NOT EXISTS, so it creates whatever is
 * missing and leaves the rest alone; migrate() handles the changes it cannot
 * make. Both run on every open, so first run and every later run take the same
 * path.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };

  if (current < SCHEMA_VERSION) {
    migrate(db, current);
  }

  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(schema);
  seedMaintenanceTypes(db);

  if (current < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

export interface SetupRow {
  id: number;
  valid_from: number;
  bean: string | null;
  roaster: string | null;
  roast_date: string | null;
  grind_setting: string | null;
  dose_g: number | null;
  basket: string | null;
  note: string | null;
  created_at: number;
}

export interface ShotContextRow {
  id: number;
  started_at: number;
  profile_id: string | null;
  profile_name: string | null;
  duration_ms: number | null;
  final_weight_g: number | null;
  stable_weight_g: number | null;
  stable_weight_source: string | null;
  machine_powered_for_s: number | null;
  machine_heating_for_s: number | null;
  machine_heatup_s: number | null;
  machine_settled: number | null;
  machine_settledness: number | null;
  water_ml: number | null;
  incomplete: number;
  bean: string | null;
  roaster: string | null;
  roast_date: string | null;
  grind_setting: string | null;
  dose_g: number | null;
  basket: string | null;
  ratio: number | null;
  rating: number | null;
  taste_note: string | null;
  setup_id: number | null;
  era_event_id: number | null;
}

/** The setup in force at a point in time, or null if none had started yet. */
export function setupAt(db: DatabaseSync, at: number): SetupRow | null {
  const row = db
    .prepare("SELECT * FROM setups WHERE valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1")
    .get(at) as SetupRow | undefined;
  return row ?? null;
}

/** The setup in force right now. */
export function currentSetup(db: DatabaseSync): SetupRow | null {
  return setupAt(db, Math.floor(Date.now() / 1000));
}
