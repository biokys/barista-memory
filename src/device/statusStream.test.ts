import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatusHub, type StatusEvent, type DeviceMessage } from "./statusStream.js";

/** A stand-in for startStatusStream that records opens and closes. */
function fakeStart() {
  const calls = { open: 0, close: 0 };
  let emit: { status?: (e: StatusEvent) => void; gap?: () => void; message?: (m: DeviceMessage) => void } = {};
  const start = (onStatus: (e: StatusEvent) => void, onGap?: () => void, onMessage?: (m: DeviceMessage) => void) => {
    calls.open++;
    emit = { status: onStatus, gap: onGap, message: onMessage };
    return () => { calls.close++; };
  };
  return { start, calls, emit: () => emit };
}

test("one socket for every listener; the last one out closes it", () => {
  const fake = fakeStart();
  const hub = createStatusHub(fake.start);
  const seen: string[] = [];
  const a = hub.subscribe({ onStatus: () => seen.push("a") });
  const b = hub.subscribe({ onStatus: () => seen.push("b"), onGap: () => seen.push("b-gap") });
  assert.equal(fake.calls.open, 1);

  fake.emit().status!({ ct: 90 });
  fake.emit().gap!();
  assert.deepEqual(seen, ["a", "b", "b-gap"]);

  a();
  assert.equal(fake.calls.close, 0);
  b();
  assert.equal(fake.calls.close, 1);

  // Reopens for a new listener after everyone left.
  hub.subscribe({});
  assert.equal(fake.calls.open, 2);
});

test("a throwing listener does not starve the others", () => {
  const fake = fakeStart();
  const hub = createStatusHub(fake.start);
  let got = 0;
  hub.subscribe({ onStatus: () => { throw new Error("boom"); } });
  hub.subscribe({ onStatus: () => { got++; } });
  const error = console.error;
  console.error = () => {};
  try { fake.emit().status!({ ct: 90 }); } finally { console.error = error; }
  assert.equal(got, 1);
});

test("other message types reach onMessage", () => {
  const fake = fakeStart();
  const hub = createStatusHub(fake.start);
  const ids: unknown[] = [];
  hub.subscribe({ onMessage: (m) => ids.push(m.id) });
  fake.emit().message!({ tp: "evt:history-shot-saved", id: 197 });
  assert.deepEqual(ids, [197]);
});
