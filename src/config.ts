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
  databasePath: process.env.GAGGIMATE_DB ?? "./gaggimate-archive.db",
  /** Seconds between ingest passes in daemon mode. */
  pollIntervalS: Number(process.env.GAGGIMATE_POLL_INTERVAL ?? 30),
  /** Milliseconds before a device request is abandoned. */
  requestTimeoutMs: Number(process.env.GAGGIMATE_TIMEOUT_MS ?? 10_000),
  /** Push derived context back into the device's own shot notes. */
  syncNotesToDevice: process.env.GAGGIMATE_SYNC_NOTES !== "0",
} as const;

export const httpBase = `${config.deviceProtocol === "wss" ? "https" : "http"}://${config.deviceHost}`;
export const wsUrl = `${config.deviceProtocol}://${config.deviceHost}/ws`;

export { required };
