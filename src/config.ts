// Every deployment-specific value comes from the environment, so the same build
// runs against the machine, against a spare one, or against a test fixture.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
function effortOf(value: string | undefined): Effort {
  return (EFFORTS as readonly string[]).includes(value ?? "") ? (value as Effort) : "medium";
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
  /**
   * Anthropic API key for the in-app assistant; unset = the assistant is off
   * and the UI hides it. Kept in the environment, never in the settings
   * table: that table travels with every export of the archive.
   */
  anthropicApiKey: process.env.GAGGIMATE_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
  /** Claude model the assistant and the receipt captions use. */
  assistantModel: process.env.GAGGIMATE_ASSISTANT_MODEL ?? "claude-opus-5",
  /** Reasoning effort for chat turns; captions always run at "low". */
  assistantEffort: effortOf(process.env.GAGGIMATE_ASSISTANT_EFFORT),
} as const;


export const httpBase = `${config.deviceProtocol === "wss" ? "https" : "http"}://${config.deviceHost}`;
export const wsUrl = `${config.deviceProtocol}://${config.deviceHost}/ws`;

export { required };
