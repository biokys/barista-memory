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

let assistantStatus = null;

export const api = {
  now: () => call("GET", "api/now"),
  shots: (q = {}) => call("GET", "api/shots?" + new URLSearchParams(q)),
  shot: (id) => call("GET", `api/shots/${id}`),
  rate: (id, rating, note) => call("POST", `api/shots/${id}/rating`, { rating, note }),
  coffees: (archived = false) => call("GET", "api/coffees" + (archived ? "?archived=1" : "")),
  coffee: (id) => call("GET", `api/coffees/${id}`),
  createCoffee: (input) => call("POST", "api/coffees", input),
  updateCoffee: (id, change) => call("PATCH", `api/coffees/${id}`, change),
  suggestion: (coffeeId) => call("GET", `api/coffees/${coffeeId}/suggestion`),
  preferences: () => call("GET", "api/preferences"),
  updatePreferences: (change) => call("PATCH", "api/preferences", change),
  importSetupCard: (card, options = {}) => call("POST", "api/setup-card", { card, ...options }),
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
  setCaption: (id, text) => call("PUT", `api/shots/${id}/caption`, { text }),
  suggestCaption: (id) => call("POST", `api/shots/${id}/caption/suggest`),
  // Asked once per page load: whether the assistant is configured decides
  // which cards and which nav item exist at all.
  assistantStatus: () => (assistantStatus ??= call("GET", "api/assistant").catch(() => ({ enabled: false }))),
  assistantUsage: () => call("GET", "api/assistant"),
  conversations: (q = {}) => call("GET", "api/assistant/conversations?" + new URLSearchParams(q)),
  conversation: (id) => call("GET", `api/assistant/conversations/${id}`),
  createConversation: (body = {}) => call("POST", "api/assistant/conversations", body),
  deleteConversation: (id) => call("DELETE", `api/assistant/conversations/${id}`),
  /** One chat turn: the answer arrives as Server-Sent Events, one JSON object per event. */
  streamMessage: async (id, body, onEvent) => {
    const res = await fetch(`api/assistant/conversations/${id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.message || data.error || `${res.status}`); }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        for (const line of chunk.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
      }
    }
  },
};
