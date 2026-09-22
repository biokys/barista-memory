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
  now: () => call("GET", "/api/now"),
  shots: (q = {}) => call("GET", "/api/shots?" + new URLSearchParams(q)),
  shot: (id) => call("GET", `/api/shots/${id}`),
  rate: (id, rating, note) => call("POST", `/api/shots/${id}/rating`, { rating, note }),
  setups: () => call("GET", "/api/setups"),
  recordSetup: (change) => call("POST", "/api/setups", change),
  updateSetup: (id, change) => call("PATCH", `/api/setups/${id}`, change),
  machineState: (since, until) => call("GET", `/api/machine/state?since=${since}&until=${until}`),
  machineSettings: () => call("GET", "/api/machine/settings"),
  profiles: () => call("GET", "/api/profiles"),
  profile: (id) => call("GET", `/api/profiles/${id}`),
  saveProfile: (id, spec) => call("PUT", `/api/profiles/${id}`, spec),
  stats: () => call("GET", "/api/stats"),
  events: () => call("GET", "/api/events"),
  recordEvent: (e) => call("POST", "/api/events", e),
  updateEvent: (id, e) => call("PATCH", `/api/events/${id}`, e),
  deleteEvent: (id) => call("DELETE", `/api/events/${id}`),
  ingest: () => call("POST", "/api/ingest"),
};
