import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveTelemetry, normalise, type LiveEvent } from "./liveTelemetry.js";
import type { DeviceMessage, StatusEvent, StatusListener } from "./device/statusStream.js";

/**
 * A shot and the start of steam, recorded from firmware 1.9.0 on 2026-11-04
 * (diagnostic fields dropped). Lines are {t, msg} with the machine's raw message.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "status-1.9.0-shot.jsonl");
const recording = readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { t: number; msg: DeviceMessage });

/** A hub that delivers whatever the test pushes, and counts subscriptions. */
function fakeHub() {
  const listeners = new Set<StatusListener>();
  let subscribes = 0;
  return {
    subscribe(l: StatusListener) { subscribes++; listeners.add(l); return () => { listeners.delete(l); }; },
    deliver(msg: DeviceMessage) {
      for (const l of listeners) {
        if (msg.tp === "evt:status") l.onStatus?.(msg as unknown as StatusEvent);
        else l.onMessage?.(msg);
      }
    },
    gap() { for (const l of listeners) l.onGap?.(); },
    get subscribes() { return subscribes; },
    get size() { return listeners.size; },
  };
}

function setup() {
  const hub = fakeHub();
  let clock = 0;
  const live = createLiveTelemetry({ subscribe: hub.subscribe, probe: async () => true, now: () => clock });
  const replay = (until: (t: number) => boolean) => {
    for (const r of recording) { if (!until(r.t)) continue; clock = r.t; hub.deliver(r.msg); }
  };
  return { hub, live, replay };
}

const at = (iso: string) => Date.parse(iso);
const STEAM = at("2026-11-04T15:52:00+01:00");

test("one status per telemetry message, merged with the state half", () => {
  const { live, replay } = setup();
  const events: LiveEvent[] = [];
  live.attach((e) => events.push(e));
  replay((t) => t < STEAM);

  const telemetry = recording.filter((r) => r.t < STEAM && r.msg.tp === "evt:status" && "ct" in r.msg).length;
  const statuses = events.filter((e) => e.event === "status");
  assert.equal(statuses.length, telemetry);

  const last = statuses.at(-1)!.data as any;
  assert.equal(last.mode, "brew");
  assert.equal(last.profile.label, "Direct Lever [Automatic Pro] v3.5");
  assert.equal(last.profile.targetWeight, 41);
  assert.equal(last.scale.connected, true);
  assert.equal(last.process.phase, "Finished");
  assert.equal(last.process.active, false);
  assert.ok(Math.abs(last.weight - 40.8) <= 0.2, `final weight ${last.weight}`);

  const saved = events.filter((e) => e.event === "shot-saved");
  assert.deepEqual(saved.map((e) => e.data), [{ deviceId: 197 }]);
});

const runOf = (events: LiveEvent[]) => (events.find((e) => e.event === "run")!.data as { samples: any[] }).samples;

test("a late client gets the whole last coffee; steam after it does not replace it", () => {
  const { live, replay } = setup();
  const keep = live.attach(() => {}); // keeps the subscription, as the daemon or a kiosk would
  replay((t) => t < STEAM);

  const late: LiveEvent[] = [];
  live.attach((e) => late.push(e));
  const run = runOf(late);
  assert.ok(run.length > 50, `run has ${run.length} samples`);
  assert.equal(run[0].process.phase, "Stabilize");
  assert.ok(run[0].process.elapsedMs <= 100);
  assert.equal(run.at(-1).process.phase, "Finished");
  assert.equal(run.filter((s) => !s.process.active).length, 1, "only the first Finished sample is kept");

  // The recording ends in steam (a bare {a: 1} process block); a client
  // attaching after it still gets the shot.
  replay((t) => t >= STEAM);
  const later: LiveEvent[] = [];
  live.attach((e) => later.push(e));
  assert.deepEqual(runOf(later), run);
  keep();
});

test("a utility run is not a coffee; the next coffee replaces the last", () => {
  const hub = fakeHub();
  const live = createLiveTelemetry({ subscribe: hub.subscribe, probe: async () => true });
  const keep = live.attach(() => {});
  const tick = (process: Record<string, unknown>) => hub.deliver({ tp: "evt:status", ct: 93, process });
  tick({ a: 1, u: 0, l: "Extraction" });
  tick({ a: 0, u: 0, l: "Finished" });
  const runNow = () => { const ev: LiveEvent[] = []; live.attach((e) => ev.push(e))(); return runOf(ev); };
  assert.deepEqual(runNow().map((s) => s.process.phase), ["Extraction", "Finished"]);

  // A backflush on a flagged profile names its phases too.
  tick({ a: 1, u: 1, l: "Backflush" });
  tick({ a: 0, u: 1, l: "Finished" });
  assert.deepEqual(runNow().map((s) => s.process.phase), ["Extraction", "Finished"]);

  // Mid-shot, a reconnecting client gets the coffee in progress, not the last one.
  tick({ a: 1, u: 0, l: "Bloom" });
  assert.deepEqual(runNow().map((s) => s.process.phase), ["Bloom"]);
  keep();
});

test("a client that drops and comes back within the grace period still gets the run", () => {
  const hub = fakeHub();
  let clock = 0;
  const live = createLiveTelemetry({ subscribe: hub.subscribe, probe: async () => true, now: () => clock });
  const kiosk = live.attach(() => {});
  for (const r of recording) { if (r.t >= STEAM) break; clock = r.t; hub.deliver(r.msg); }
  kiosk(); // Wi-Fi drop: the only client is gone
  const back: LiveEvent[] = [];
  const again = live.attach((e) => back.push(e));
  const run = back.find((e) => e.event === "run")!.data as { samples: any[] };
  assert.ok(run.samples.length > 50);
  assert.equal(hub.subscribes, 1, "the stream was kept, not reopened");
  again();
});

test("no stale status for a new client while the machine is known off", () => {
  const { hub, live, replay } = setup();
  const keep = live.attach(() => {});
  replay((t) => t < at("2026-11-04T15:47:10+01:00"));
  hub.gap();
  const late: LiveEvent[] = [];
  live.attach((e) => late.push(e));
  assert.deepEqual(late.map((e) => e.event), ["run", "offline"]);
  keep();
});

test("offline once on a gap, online with the next telemetry", () => {
  const { hub, live, replay } = setup();
  const events: LiveEvent[] = [];
  live.attach((e) => events.push(e));
  replay((t) => t < at("2026-11-04T15:47:00+01:00"));
  hub.gap();
  hub.gap();
  replay((t) => t >= at("2026-11-04T15:47:00+01:00") && t < at("2026-11-04T15:47:05+01:00"));
  const kinds = events.map((e) => e.event).filter((k) => k === "offline" || k === "online");
  assert.deepEqual(kinds, ["offline", "online"]);
});

test("a first client with no data and an unreachable machine is told offline", async () => {
  const hub = fakeHub();
  const live = createLiveTelemetry({ subscribe: hub.subscribe, probe: async () => false });
  const events: LiveEvent[] = [];
  live.attach((e) => events.push(e));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.map((e) => e.event), ["run", "offline"]);
});

test("one upstream subscription for many clients, released after the last", async () => {
  const hub = fakeHub();
  const live = createLiveTelemetry({ subscribe: hub.subscribe, probe: async () => true, lingerMs: 10 });
  const a = live.attach(() => {});
  const b = live.attach(() => {});
  assert.equal(hub.subscribes, 1);
  a();
  assert.equal(hub.size, 1);
  b();
  b(); // idempotent
  assert.equal(live.clientCount(), 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hub.size, 0);
});

test("a telemetry half replaces the previous one, so omitted fields read as absent", () => {
  const busy = normalise({ m: 1 }, { ct: 92, pr: 9, fl: 2, process: { a: 1, l: "Extraction" } }, 0);
  assert.equal(busy.pressure.current, 9);
  const idle = normalise({ m: 1 }, { ct: 92 }, 1);
  assert.equal(idle.pressure.current, null);
  assert.equal(idle.process, null);
  assert.equal(normalise({ m: 9 }, { ct: 20 }, 0).mode, "unknown");
});
