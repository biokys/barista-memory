import { config } from "./config.js";
import { openDatabase } from "./db/db.js";
import { ingestOnce, recomputeStableWeights, recomputeMachineContext } from "./ingest.js";
import { fetchStatus } from "./device/client.js";
import { recordState } from "./machineState.js";
import { startStatusStream } from "./device/statusStream.js";
import { createFlushWatcher } from "./flushWatch.js";
import { startMqtt, type MqttBridge } from "./mqtt.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Poll the device forever, archiving whatever is new.
 *
 * A failed pass is logged and the loop continues: the machine being off, or the
 * network being down, is the normal state most of the day, and the device keeps
 * its own history, so a missed pass is caught up by the next one.
 */
async function main(): Promise<void> {
  const db = openDatabase(config.databasePath);
  let running = true;

  const stop = (signal: string) => {
    console.log(`${signal} received, stopping after this pass`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  console.log(
    `Archiving ${config.deviceHost} into ${config.databasePath} every ${config.pollIntervalS}s ` +
      `(notes sync ${config.syncNotesToDevice ? "on" : "off"})`
  );

  // Self-healing: a schema upgrade leaves the new columns empty, and a shot
  // archived while the parser was failing has none either.
  const backfilled = recomputeStableWeights(db);
  if (backfilled > 0) console.log(`derived stable weight for ${backfilled} shot(s)`);
  const contextualised = recomputeMachineContext(db);
  if (contextualised > 0) console.log(`derived machine context for ${contextualised} shot(s)`);

  // Backflushes are never written to the machine's history, so they are
  // watched live instead of ingested.
  const flushWatcher = createFlushWatcher(db);
  const stopStream = startStatusStream((ev) => flushWatcher.onStatus(ev), () => flushWatcher.onGap());

  let mqttBridge: MqttBridge | null = null;
  if (config.mqttUrl) {
    let version = "0.0.0";
    try { version = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version; } catch {}
    mqttBridge = startMqtt(db, version);
  }

  while (running) {
    // Sampled before the ingest and outside its try, because an unreachable
    // machine is exactly the observation worth keeping: the firmware records no
    // uptime, so "did not answer" is how a power-off gets into the record.
    let live = null as Awaited<ReturnType<typeof fetchStatus>>;
    try {
      live = await fetchStatus();
      recordState(db, live);
    } catch (error) {
      console.error(`state sample failed: ${error instanceof Error ? error.message : error}`);
    }

    try {
      const result = await ingestOnce(db);
      if (result.archived > 0 || result.notesSynced > 0 || result.failures.length > 0) {
        console.log(
          `archived=${result.archived} notes=${result.notesSynced} ` +
            `skipped=${result.skipped} failures=${result.failures.length}`
        );
        for (const failure of result.failures) {
          console.warn(`  shot ${failure.shotId}: ${failure.reason}`);
        }
      }
    } catch (error) {
      console.error(`pass failed: ${error instanceof Error ? error.message : error}`);
    }

    // After the pass, so a shot archived just now is already the "last shot".
    try { mqttBridge?.publish(db, live); } catch (error) { console.error(`mqtt publish failed: ${error instanceof Error ? error.message : error}`); }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalS * 1000));
  }

  stopStream();
  await mqttBridge?.close();
  db.close();
}

await main();
