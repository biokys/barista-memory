// Every deployment-specific value comes from the environment, so the same build
// runs against the machine, against a spare one, or against a test fixture.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const config = {
  /** GaggiMate hostname or IP. Prefer an IP: resolving .local can take seconds. */
  deviceHost: process.env.GAGGIMATE_HOST ?? "gaggimate.local",
  /** "ws" or "wss"; the HTTP scheme follows from it. */
  deviceProtocol: process.env.GAGGIMATE_PROTOCOL === "wss" ? "wss" : "ws",
  /** Path to the SQLite file. Must be on storage that outlives the device. */
  databasePath: process.env.GAGGIMATE_DB ?? "./barista-memory.db",
  /** Seconds between ingest passes in daemon mode. */
  pollIntervalS: Number(process.env.GAGGIMATE_POLL_INTERVAL ?? 30),
  /** Milliseconds before a device request is abandoned. */
  requestTimeoutMs: Number(process.env.GAGGIMATE_TIMEOUT_MS ?? 10_000),
  /** Push derived context back into the device's own shot notes. */
  syncNotesToDevice: process.env.GAGGIMATE_SYNC_NOTES !== "0",
  /** MQTT broker for Home Assistant, e.g. mqtt://homeassistant.local:1883; unset = off. */
  mqttUrl: process.env.GAGGIMATE_MQTT_URL ?? "",
  mqttUser: process.env.GAGGIMATE_MQTT_USER ?? "",
  mqttPassword: process.env.GAGGIMATE_MQTT_PASSWORD ?? "",
  /** Topic prefix for state and commands; also the Home Assistant device id. */
  mqttPrefix: process.env.GAGGIMATE_MQTT_PREFIX ?? "barista-memory",
  /** Home Assistant's discovery prefix. */
  haDiscoveryPrefix: process.env.GAGGIMATE_HA_DISCOVERY ?? "homeassistant",
  /** Bearer token for MCP over HTTP at /mcp on the web port; unset = endpoint off. */
  mcpToken: process.env.GAGGIMATE_MCP_TOKEN ?? "",
  /** Language of printed receipts: "cs" or "en". */
  lang: process.env.GAGGIMATE_LANG === "cs" ? "cs" : "en",
  /** Public base URL of the web UI, for the QR code on receipts; unset = no QR. */
  webUrl: (process.env.GAGGIMATE_WEB_URL ?? "").replace(/\/$/, ""),
  /** Bluetooth address of the receipt printer (MXW01 class). Settings in the DB override. */
  printerMac: process.env.GAGGIMATE_PRINTER_MAC ?? "",
  /** Warm-up percent at which the "ready" sensor turns on. */
  readyPct: Number(process.env.GAGGIMATE_READY_PCT ?? 85),
} as const;

export const httpBase = `${config.deviceProtocol === "wss" ? "https" : "http"}://${config.deviceHost}`;
export const wsUrl = `${config.deviceProtocol}://${config.deviceHost}/ws`;

export { required };
