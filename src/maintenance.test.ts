import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/db.js";
import { maintenanceStatus, logMaintenance } from "./maintenance.js";

test("due_in_days follows the pace of the last two weeks", () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-maint-"));
  const db = openDatabase(join(dir, "archive.db"));
  const now = Date.parse("2026-11-10T12:00:00Z") / 1000;
  const day = 86400;

  // A backflush 7 days ago, then 2 coffees a day since (14 in 7 days), each
  // 50 ml through the group.
  logMaintenance(db, "backflush", { at: now - 7 * day });
  logMaintenance(db, "descale", { at: now - 7 * day });
  const insert = db.prepare("INSERT INTO shots (id, device_id, started_at, ingested_at, kind, water_ml) VALUES (?, ?, ?, 0, 'shot', 50)");
  for (let i = 0; i < 14; i++) insert.run(i + 1, i + 1, now - 7 * day + 3600 + i * (day / 2));

  const byKey = Object.fromEntries(maintenanceStatus(db, now).map((m) => [m.key, m]));
  // The pace is 14 shots over the 14-day window: 1 a day. 15 - 14 left -> 1 day.
  assert.equal(byKey.backflush.shots_since, 14);
  assert.equal(byKey.backflush.due_in_days, 1);
  // Water: 0.7 l in 14 days = 0.05 l/day; 15 - 0.7 l left -> 286 days.
  assert.equal(byKey.descale.due_in_days, 286);
  // Measured in days alone and never logged: nothing to count from.
  assert.equal(byKey.gasket.due_in_days, null);

  // Past due reads as 0, not negative.
  for (let i = 0; i < 5; i++) insert.run(100 + i, 100 + i, now - 3600 + i);
  assert.equal(maintenanceStatus(db, now).find((m) => m.key === "backflush")!.due_in_days, 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
