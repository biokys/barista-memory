import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db/db.js";
import { setShotTime } from "./ingest.js";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "bm-shot-time-"));
  return { path: join(dir, "archive.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a corrected start keeps the device's timestamp for matching", () => {
  const s = scratch();
  const db = openDatabase(s.path);
  // Shot 221 as it was archived on 2026-11-10: stamped 761 s after boot.
  db.prepare("INSERT INTO shots (id, device_id, started_at, duration_ms, ingested_at) VALUES (221, 221, 761, 56005, 0)").run();
  const at = Date.parse("2026-11-10T10:40:13+01:00") / 1000;

  assert.equal(setShotTime(db, 221, at), true);
  let row = db.prepare("SELECT started_at, device_started_at FROM shots WHERE id = 221").get() as Record<string, number>;
  assert.deepEqual({ ...row }, { started_at: at, device_started_at: 761 });

  // A second correction moves the start again but never loses the device's stamp.
  assert.equal(setShotTime(db, 221, at + 20), true);
  row = db.prepare("SELECT started_at, device_started_at FROM shots WHERE id = 221").get() as Record<string, number>;
  assert.deepEqual({ ...row }, { started_at: at + 20, device_started_at: 761 });

  assert.equal(setShotTime(db, 999, at), false);
  db.close();
  s.done();
});

test("an archive from before the column gains it on open", () => {
  const s = scratch();
  const old = new DatabaseSync(s.path);
  old.exec("CREATE TABLE shots (id INTEGER PRIMARY KEY, device_id INTEGER, started_at INTEGER NOT NULL); PRAGMA user_version = 10;");
  old.close();

  const db = openDatabase(s.path);
  const columns = (db.prepare("PRAGMA table_info(shots)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(columns.includes("device_started_at"));
  db.close();
  s.done();
});
