import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/db.js";
import { machineActivity } from "./machineState.js";

test("machineActivity: idle since the standby that led into the power-off", () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-activity-"));
  const db = openDatabase(join(dir, "archive.db"));
  const now = 1_800_000_000;
  const insert = db.prepare("INSERT INTO machine_state (sampled_at, reachable, mode, target_temp, current_temp) VALUES (?, ?, ?, 93, 90)");

  assert.deepEqual(machineActivity(db, now), { state: null, idle_since: null });

  insert.run(now - 3000, 1, 1); // brewing
  assert.deepEqual(machineActivity(db, now - 2900), { state: "on", idle_since: null });

  insert.run(now - 2000, 1, 0); // standby
  insert.run(now - 1400, 1, 0); // heartbeat
  insert.run(now - 900, 0, null); // switched off
  assert.deepEqual(machineActivity(db, now), { state: "off", idle_since: now - 2000 });

  insert.run(now - 60, 1, 1); // on again
  assert.deepEqual(machineActivity(db, now), { state: "on", idle_since: null });

  // The daemon stopped sampling: an old record says nothing about now.
  assert.deepEqual(machineActivity(db, now + 3 * 600 + 1), { state: null, idle_since: null });

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
