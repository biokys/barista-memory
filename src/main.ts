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
  mqtt_url: "GAGGIMATE_MQTT_URL",
  mqtt_user: "GAGGIMATE_MQTT_USER",
  mqtt_password: "GAGGIMATE_MQTT_PASSWORD",
  ready_percent: "GAGGIMATE_READY_PCT",
  mcp_token: "GAGGIMATE_MCP_TOKEN",
};

/**
 * Under Home Assistant the Mosquitto add-on hands out its credentials through
 * the Supervisor, so MQTT needs no configuration at all when it is installed.
 * An explicit mqtt_url option wins; without Supervisor or Mosquitto, MQTT
 * simply stays off.
 */
async function applySupervisorMqtt(): Promise<void> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || process.env.GAGGIMATE_MQTT_URL) return;
  try {
    const res = await fetch("http://supervisor/services/mqtt", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.log(`mqtt: no broker from Supervisor (${res.status})`); return; }
    const { data } = (await res.json()) as { data?: { host?: string; port?: number; username?: string; password?: string; ssl?: boolean } };
    if (!data?.host) return;
    process.env.GAGGIMATE_MQTT_URL = `${data.ssl ? "mqtts" : "mqtt"}://${data.host}:${data.port ?? 1883}`;
    if (data.username) process.env.GAGGIMATE_MQTT_USER = data.username;
    if (data.password) process.env.GAGGIMATE_MQTT_PASSWORD = data.password;
    console.log(`mqtt: broker ${data.host}:${data.port ?? 1883} provided by the Supervisor`);
  } catch (error) {
    console.log(`mqtt: Supervisor not reachable: ${error instanceof Error ? error.message : error}`);
  }
}

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
await applySupervisorMqtt();

// The web server only listens; the daemon module runs its poll loop until
// SIGTERM and resolves when it has finished its last pass, at which point
// there is nothing left to keep the process for.
await import("./web/server.js");
await import("./daemon.js");
process.exit(0);
