import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/db.js";

/**
 * Moving an archive between installations: a Pi to a Home Assistant add-on,
 * a container to another host. Export is a consistent copy (VACUUM INTO, so
 * a WAL mid-write cannot be caught); import replaces the content of this
 * archive with the file's, table by table, after migrating the file to the
 * current schema. Replace rather than merge on purpose: a merge would have
 * to reconcile autoincrement ids of setups, events and maintenance entries,
 * and the one real use is "make this instance the old one".
 */

/** Tables whose rows travel; everything derived lives in views. */
const TABLES = ["shots", "setups", "shot_overrides", "tastings", "notes_sync", "machine_state", "events", "maintenance_types", "maintenance_log", "settings"];

export function exportArchive(db: DatabaseSync): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "barista-export-"));
  const file = join(dir, "archive.db");
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ImportResult {
  ok: true;
  counts: Record<string, number>;
}

export function importArchive(db: DatabaseSync, bytes: Uint8Array): ImportResult {
  if (bytes.length < 100 || Buffer.from(bytes.subarray(0, 15)).toString("latin1") !== "SQLite format 3") {
    throw new Error("Not a SQLite database file");
  }
  const dir = mkdtempSync(join(tmpdir(), "barista-import-"));
  const file = join(dir, "import.db");
  try {
    writeFileSync(file, bytes);
    // Opening through openDatabase migrates an older export to this schema.
    const probe = openDatabase(file);
    const hasShots = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shots'").get();
    probe.close();
    if (!hasShots) throw new Error("The file has no shots table; is it a barista-memory archive?");

    db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS imp`);
    const counts: Record<string, number> = {};
    // Rows are replaced wholesale, so referential order does not matter; the
    // pragma cannot change inside a transaction, hence before BEGIN.
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN");
      for (const table of TABLES) {
        db.exec(`DELETE FROM main.${table}`);
        const columns = (db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        const theirs = new Set((db.prepare(`PRAGMA imp.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
        const shared = columns.filter((c) => theirs.has(c)).join(", ");
        db.exec(`INSERT INTO main.${table} (${shared}) SELECT ${shared} FROM imp.${table}`);
        counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM main.${table}`).get() as { n: number }).n;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("DETACH DATABASE imp");
      db.exec("PRAGMA foreign_keys = ON");
    }
    return { ok: true, counts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
