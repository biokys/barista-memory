import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/db.js";
import { createKioskActivity, KIOSK_DETACH_MS } from "./kioskActivity.js";
import type { LiveEvent, LiveStatus } from "./liveTelemetry.js";

const status = (mode: LiveStatus["mode"], active = false) =>
  ({ event: "status", data: { mode, process: active ? { active: true } : null } }) as unknown as LiveEvent;

test("kioskActivity follows the stream at once and keeps the record's start of an idle stretch", () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-kiosk-activity-"));
  const db = openDatabase(join(dir, "archive.db"));
  let nowMs = 1_800_000_000_000;
  const now = () => nowMs;
  let send: ((e: LiveEvent) => void) | null = null;
  let attached = 0;
  const activity = createKioskActivity((s) => { send = s; attached++; return () => { send = null; }; }, now);
  const sec = Math.floor(nowMs / 1000);
  // The record: standby for the last 40 minutes.
  db.prepare("INSERT INTO machine_state (sampled_at, reachable, mode) VALUES (?, 1, 0)").run(sec - 2400);
  db.prepare("INSERT INTO machine_state (sampled_at, reachable, mode) VALUES (?, 1, 0)").run(sec - 60);

  // Before the stream says anything, the record answers.
  assert.deepEqual(activity(db), { state: "standby", idle_since: sec - 2400 });
  assert.equal(attached, 1);

  // Still standby by the stream: the stretch began where the record says.
  send!(status("standby"));
  assert.deepEqual(activity(db), { state: "standby", idle_since: sec - 2400 });

  // Woken: on at once, though the record still reads standby.
  nowMs += 5000;
  send!(status("brew"));
  assert.deepEqual(activity(db), { state: "on", idle_since: null });

  // Back to standby within one daemon pass, so the record never saw the
  // wake: idle from that moment, not from the old stretch.
  nowMs += 30_000;
  send!(status("standby"));
  assert.deepEqual(activity(db), { state: "standby", idle_since: sec + 35 });

  // A coffee in standby mode is not idle; a lost stream is off since it went.
  send!(status("standby", true));
  assert.equal(activity(db).state, "on");
  send!({ event: "offline", data: { since: nowMs } });
  assert.deepEqual(activity(db), { state: "off", idle_since: Math.floor(nowMs / 1000) });

  // A kiosk gone quiet lets the stream go, and starts over when it asks again.
  nowMs += KIOSK_DETACH_MS + 1000;
  activity(db);
  assert.equal(attached, 2);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
