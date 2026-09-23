// Paths are relative on purpose: behind Home Assistant ingress the app lives
// under /api/hassio_ingress/<token>/, and the hash router never changes the
// document path, so "api/now" resolves correctly there and at the root alike.
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `${res.status}`);
  return data;
}

export const api = {
  now: () => call("GET", "api/now"),
  shots: (q = {}) => call("GET", "api/shots?" + new URLSearchParams(q)),
  shot: (id) => call("GET", `api/shots/${id}`),
  rate: (id, rating, note) => call("POST", `api/shots/${id}/rating`, { rating, note }),
  setups: () => call("GET", "api/setups"),
  recordSetup: (change) => call("POST", "api/setups", change),
  updateSetup: (id, change) => call("PATCH", `api/setups/${id}`, change),
  machineState: (since, until) => call("GET", `api/machine/state?since=${since}&until=${until}`),
  setMode: (mode) => call("POST", "api/machine/mode", { mode }),
  machineSettings: () => call("GET", "api/machine/settings"),
  profiles: () => call("GET", "api/profiles"),
  profile: (id) => call("GET", `api/profiles/${id}`),
  selectProfile: (id) => call("POST", `api/profiles/${id}/select`),
  saveProfile: (id, spec) => call("PUT", `api/profiles/${id}`, spec),
  stats: () => call("GET", "api/stats"),
  events: () => call("GET", "api/events"),
  recordEvent: (e) => call("POST", "api/events", e),
  updateEvent: (id, e) => call("PATCH", `api/events/${id}`, e),
  deleteEvent: (id) => call("DELETE", `api/events/${id}`),
  ingest: () => call("POST", "api/ingest"),
  maintenance: () => call("GET", "api/maintenance"),
  importArchive: async (file) => {
    const res = await fetch("api/import", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `${res.status}`);
    return data;
  },
  printer: () => call("GET", "api/printer"),
  updatePrinter: (change) => call("PATCH", "api/printer", change),
  scanPrinters: () => call("POST", "api/printer/scan"),
  testPrint: () => call("POST", "api/printer/test"),
  printerStatus: () => call("GET", "api/printer/status"),
  printShot: (id) => call("POST", `api/shots/${id}/print`),
  maintenanceDone: (key, body = {}) => call("POST", `api/maintenance/${key}`, body),
  lastFlushWasCafiza: () => call("POST", "api/maintenance/last-flush/cafiza"),
  updateMaintenanceType: (key, change) => call("PATCH", `api/maintenance/types/${key}`, change),
  deleteMaintenanceLog: (id) => call("DELETE", `api/maintenance/log/${id}`),
};
