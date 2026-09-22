/**
 * Single-process entry point for the container image: the archive daemon
 * and the web UI together, so one `docker run` is the whole installation.
 * The systemd deployment keeps running them as two services from
 * daemon.js and web/server.js; this file only combines them.
 *
 * Under Home Assistant the add-on's options arrive as /data/options.json
 * rather than as environment variables, so they are mapped onto the same
 * GAGGIMATE_* variables before config.ts reads them — which is why the two
 * halves are imported dynamically, after the mapping.
 */
import { readFileSync, existsSync } from "node:fs";

const HA_OPTIONS = "/data/options.json";

const OPTION_TO_ENV: Record<string, string> = {
  machine_host: "GAGGIMATE_HOST",
  poll_interval: "GAGGIMATE_POLL_INTERVAL",
  sync_notes: "GAGGIMATE_SYNC_NOTES",
};

function applyHomeAssistantOptions(): void {
  if (!existsSync(HA_OPTIONS)) return;
  let options: Record<string, unknown>;
  try {
    options = JSON.parse(readFileSync(HA_OPTIONS, "utf8"));
  } catch (error) {
    console.error(`cannot read ${HA_OPTIONS}: ${error instanceof Error ? error.message : error}`);
    return;
  }
  for (const [option, env] of Object.entries(OPTION_TO_ENV)) {
    const value = options[option];
    if (value === undefined || value === null || value === "") continue;
    // Explicit env wins, so a docker-compose override still works under HA.
    if (process.env[env]) continue;
    process.env[env] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  }
}

applyHomeAssistantOptions();

// The web server only listens; the daemon module runs its poll loop until
// SIGTERM and resolves when it has finished its last pass, at which point
// there is nothing left to keep the process for.
await import("./web/server.js");
await import("./daemon.js");
process.exit(0);
