import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { openDatabase, currentSetup, type ShotContextRow } from "../db/db.js";
import { listProfiles, getProfile, fetchRawSettings } from "../device/client.js";
import { renderShotReceipt } from "../receipt.js";
import { printShot, printTest, printerStatus, printerSettings, updatePrinterSettings, findPrinters } from "../printer/index.js";
import { bluetoothAvailable } from "../printer/bluez.js";
import { exportArchive, importArchive } from "../transfer.js";
import { liveStatus, machineReachable } from "../liveStatus.js";
import { groupSettings } from "../device/machineSettings.js";
import { currentConditions, powerSessions, allStateSamples, coldBaseline, type StateRow } from "../machineState.js";
import { massTemperatureSeries, settledness } from "../thermalModel.js";
import { changeMode, SWITCHABLE_MODES } from "../machineControl.js";
import { handleMcpRequest, mcpEnabled } from "../mcp/http.js";
import { recordSetup, updateSetup } from "../setups.js";
import { listCoffees, coffeeSummary, createCoffee, updateCoffee } from "../coffees.js";
import { loadArchivedShot, pressureSparkline } from "../shots.js";
import { saveProfileMerged, selectProfileOnMachine } from "../profiles.js";
import { statsSummary } from "../stats.js";
import { ingestOnce } from "../ingest.js";
import { recordEvent, updateEvent, deleteEvent, listEvents, eraOf, EVENT_KINDS } from "../events.js";
import {
  maintenanceStatus, logMaintenance, listMaintenanceLog, deleteMaintenanceLog,
  markLastFlushAsCafiza, updateMaintenanceType, MAINTENANCE_KEYS,
} from "../maintenance.js";

/**
 * The web UI's backend: a static file server for web/ and a JSON API that is
 * a thin translation of the same modules the MCP uses. No framework — the
 * surface is a dozen routes, and one fewer dependency is one fewer thing to
 * `npm ci` on the server.
 *
 * Meant for the LAN or a tailnet. There is no authentication: anyone who can
 * reach the port can change the grind setting and save profiles.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const WEB = join(ROOT, "web");
const PORT = Number(process.env.GAGGIMATE_WEB_PORT ?? 8080);
const HOST = process.env.GAGGIMATE_WEB_HOST ?? "0.0.0.0";

const db = openDatabase(config.databasePath);

/**
 * What is running: read once at startup. The commit comes from the checkout
 * the server runs from — deploy.sh guarantees it is one — and is what the
 * footer shows, so "which build is this" is answered by looking at the page.
 */
const VERSION = (() => {
  let version = "0.0.0";
  try { version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; } catch {}
  // A container has no .git; the Dockerfile bakes the commit in as an env var.
  let commit = process.env.BARISTA_COMMIT ?? "";
  if (!commit) {
    try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
  }
  return { version, commit, node: process.version };
})();

/** Third-party assets served straight from node_modules, so nothing is copied at build. */
const VENDOR: Record<string, string> = {
  "/vendor/uplot.js": join(ROOT, "node_modules/uplot/dist/uPlot.iife.min.js"),
  "/vendor/uplot.css": join(ROOT, "node_modules/uplot/dist/uPlot.min.css"),
};
const INTER_DIR = join(ROOT, "node_modules/@fontsource-variable/inter");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function sendFile(res: ServerResponse, path: string, cache = "no-cache"): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
    "Cache-Control": cache,
  });
  createReadStream(path).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void>;
const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, key) => (keys.push(key), "([^/]+)")) + "$");
  routes.push({ method, pattern, keys, handler });
}

/** Routes that need the machine answer at once while it is known to be off. */
async function requireMachine(res: ServerResponse): Promise<boolean> {
  if (await machineReachable()) return true;
  json(res, 502, { error: "MACHINE_OFF", message: "The machine is not answering" });
  return false;
}

route("GET", "/api/version", async (_req, res) => {
  json(res, 200, VERSION);
});

route("GET", "/api/now", async (_req, res) => {
  const live = await liveStatus();
  const conditions = currentConditions(db, live);
  const setup = currentSetup(db);
  const last = db.prepare("SELECT * FROM shot_context ORDER BY started_at DESC LIMIT 1").get() as unknown as
    | ShotContextRow
    | undefined;
  json(res, 200, {
    machine: conditions,
    setup,
    maintenance: maintenanceStatus(db).filter((m) => m.enabled),
    last_shot: last ? { ...last, sparkline: pressureSparkline(db, last.id) } : null,
    server_time: Math.floor(Date.now() / 1000),
  });
});

route("GET", "/api/shots", async (_req, res, _p, url) => {
  const q = url.searchParams;
  const where: string[] = [];
  const params: Array<string | number> = [];
  const add = (clause: string, value: string | null, cast: (v: string) => string | number = (v) => v) => {
    if (value) { where.push(clause); params.push(cast(value)); }
  };
  add("bean = ?", q.get("bean"));
  add("coffee_id = ?", q.get("coffee"), Number);
  add("profile_name = ?", q.get("profile"));
  add("started_at >= ?", q.get("since"), Number);
  add("started_at <= ?", q.get("until"), Number);
  const limit = Math.min(Number(q.get("limit") ?? 100), 500);
  const sql = "SELECT * FROM shot_context" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY started_at DESC LIMIT ?";
  const shots = db.prepare(sql).all(...params, limit) as unknown as ShotContextRow[];
  const oldest = shots.length ? shots[shots.length - 1].started_at : 0;
  json(res, 200, {
    shots: shots.map((s) => ({ ...s, sparkline: pressureSparkline(db, s.id) })),
    events: listEvents(db, oldest),
    maintenance: listMaintenanceLog(db, 500).filter((m) => m.at >= oldest),
    beans: db.prepare("SELECT DISTINCT bean FROM shot_context WHERE bean IS NOT NULL ORDER BY bean").all().map((r: any) => r.bean),
    profiles: db.prepare("SELECT DISTINCT profile_name FROM shot_context WHERE profile_name IS NOT NULL").all().map((r: any) => r.profile_name),
  });
});

route("GET", "/api/shots/:id/receipt.png", async (_req, res, p) => {
  const receipt = await renderShotReceipt(db, Number(p.id), printerSettings(db).lang);
  if (!receipt) return json(res, 404, { error: "SHOT_NOT_FOUND" });
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
  res.end(Buffer.from(receipt.png));
});

route("GET", "/api/shots/:id/receipt.svg", async (_req, res, p) => {
  const receipt = await renderShotReceipt(db, Number(p.id), printerSettings(db).lang);
  if (!receipt) return json(res, 404, { error: "SHOT_NOT_FOUND" });
  res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
  res.end(receipt.svg);
});

route("POST", "/api/shots/:id/print", async (_req, res, p) => {
  const result = await printShot(db, Number(p.id));
  json(res, result.ok ? 200 : result.code === "NOT_FOUND" ? 404 : 502, result);
});

route("GET", "/api/export", async (_req, res) => {
  const bytes = exportArchive(db);
  res.writeHead(200, {
    "Content-Type": "application/vnd.sqlite3",
    "Content-Disposition": `attachment; filename="barista-memory-${new Date().toISOString().slice(0, 10)}.db"`,
    "Content-Length": bytes.length,
  });
  res.end(Buffer.from(bytes));
});

// Replaces this archive with the uploaded one; the UI asks for confirmation.
route("POST", "/api/import", async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 512 * 1024 * 1024) return json(res, 413, { error: "TOO_LARGE" });
    chunks.push(chunk as Buffer);
  }
  try {
    json(res, 200, importArchive(db, Buffer.concat(chunks)));
  } catch (error) {
    json(res, 400, { error: "IMPORT_FAILED", message: error instanceof Error ? error.message : String(error) });
  }
});

route("GET", "/api/printer", async (_req, res) => {
  json(res, 200, { settings: printerSettings(db), bluetooth: await bluetoothAvailable() });
});

route("PATCH", "/api/printer", async (req, res) => {
  const body = await readJson(req);
  json(res, 200, { settings: updatePrinterSettings(db, body) });
});

route("POST", "/api/printer/scan", async (_req, res) => {
  json(res, 200, await findPrinters());
});

route("POST", "/api/printer/test", async (_req, res) => {
  const result = await printTest(db);
  json(res, result.ok ? 200 : 502, result);
});

route("GET", "/api/printer/status", async (_req, res) => {
  const result = await printerStatus(db);
  json(res, result.ok ? 200 : 502, result);
});

route("GET", "/api/shots/:id", async (_req, res, p) => {
  const loaded = loadArchivedShot(db, Number(p.id), true);
  if (!loaded) return json(res, 404, { error: "SHOT_NOT_FOUND" });
  // Neighbours, for the previous/next links and the default comparison —
  // from shot_context, so a flush archived between two coffees is skipped
  // instead of leading to a "not found" page.
  const prev = db.prepare("SELECT id FROM shot_context WHERE started_at < (SELECT started_at FROM shots WHERE id = ?) ORDER BY started_at DESC LIMIT 1").get(Number(p.id)) as any;
  const next = db.prepare("SELECT id FROM shot_context WHERE started_at > (SELECT started_at FROM shots WHERE id = ?) ORDER BY started_at ASC LIMIT 1").get(Number(p.id)) as any;
  json(res, 200, { ...loaded, era: eraOf(db, loaded.context.started_at), prev_id: prev?.id ?? null, next_id: next?.id ?? null });
});

route("POST", "/api/shots/:id/rating", async (req, res, p) => {
  const id = Number(p.id);
  if (!db.prepare("SELECT 1 FROM shots WHERE id = ?").get(id)) return json(res, 404, { error: "SHOT_NOT_FOUND" });
  const body = await readJson(req);
  db.prepare(
    "INSERT INTO tastings (shot_id, rating, note, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(shot_id) DO UPDATE SET rating = excluded.rating, note = excluded.note"
  ).run(id, body.rating ?? null, body.note ?? null, Math.floor(Date.now() / 1000));
  json(res, 200, db.prepare("SELECT * FROM shot_context WHERE id = ?").get(id));
});

route("GET", "/api/setups", async (_req, res) => {
  json(res, 200, {
    current: currentSetup(db),
    setups: db.prepare("SELECT * FROM setups ORDER BY valid_from DESC, id DESC LIMIT 50").all(),
  });
});

route("POST", "/api/setups", async (req, res) => {
  const body = await readJson(req);
  const change: Record<string, unknown> = {};
  for (const key of ["coffee_id", "bean", "roaster", "roast_date", "grind_setting", "dose_g", "basket", "note", "valid_from"]) {
    if (body[key] !== undefined && body[key] !== "") change[key] = key === "dose_g" || key === "valid_from" || key === "coffee_id" ? Number(body[key]) : body[key];
  }
  // An explicit null clears the coffee; Number(null) would have made it 0.
  if (body.coffee_id === null) change.coffee_id = null;
  try {
    json(res, 200, { setup: recordSetup(db, change) });
  } catch (error) {
    json(res, 400, { error: "INVALID", message: error instanceof Error ? error.message : String(error) });
  }
});

route("PATCH", "/api/setups/:id", async (req, res, p) => {
  const body = await readJson(req);
  if (body.coffee_id !== undefined && body.coffee_id !== null && body.coffee_id !== "") body.coffee_id = Number(body.coffee_id);
  if (body.coffee_id === "") body.coffee_id = null;
  try {
    const setup = updateSetup(db, Number(p.id), body);
    if (!setup) return json(res, 404, { error: "SETUP_NOT_FOUND" });
    json(res, 200, { setup });
  } catch (error) {
    json(res, 400, { error: "INVALID", message: error instanceof Error ? error.message : String(error) });
  }
});

// Coffees: identities the periods point at. Errors from the module are
// short codes; COFFEE_EXISTS is the one the form has to explain.
function coffeeError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "COFFEE_EXISTS") return json(res, 409, { error: "COFFEE_EXISTS", message: "A coffee with this name and roaster already exists" });
  json(res, 400, { error: "INVALID", message });
}

route("GET", "/api/coffees", async (_req, res, _p, url) => {
  json(res, 200, { coffees: listCoffees(db, url.searchParams.get("archived") === "1") });
});

route("GET", "/api/coffees/:id", async (_req, res, p) => {
  const coffee = coffeeSummary(db, Number(p.id));
  if (!coffee) return json(res, 404, { error: "COFFEE_NOT_FOUND" });
  const shots = db.prepare("SELECT * FROM shot_context WHERE coffee_id = ? ORDER BY started_at DESC LIMIT 200").all(coffee.id) as unknown as ShotContextRow[];
  json(res, 200, {
    coffee,
    shots: shots.map((s) => ({ ...s, sparkline: pressureSparkline(db, s.id) })),
    setups: db.prepare("SELECT * FROM setups WHERE coffee_id = ? ORDER BY valid_from DESC, id DESC").all(coffee.id),
  });
});

route("POST", "/api/coffees", async (req, res) => {
  try {
    json(res, 200, { coffee: createCoffee(db, await readJson(req)) });
  } catch (error) {
    coffeeError(res, error);
  }
});

route("PATCH", "/api/coffees/:id", async (req, res, p) => {
  try {
    const coffee = updateCoffee(db, Number(p.id), await readJson(req));
    if (!coffee) return json(res, 404, { error: "COFFEE_NOT_FOUND" });
    json(res, 200, { coffee });
  } catch (error) {
    coffeeError(res, error);
  }
});

route("GET", "/api/events", async (_req, res) => {
  json(res, 200, { events: listEvents(db), kinds: EVENT_KINDS });
});

route("POST", "/api/events", async (req, res) => {
  const body = await readJson(req);
  try {
    json(res, 200, { event: recordEvent(db, { ...body, at: body.at != null ? Number(body.at) : undefined }) });
  } catch (error) {
    json(res, 400, { error: "INVALID", message: error instanceof Error ? error.message : String(error) });
  }
});

route("PATCH", "/api/events/:id", async (req, res, p) => {
  const body = await readJson(req);
  const event = updateEvent(db, Number(p.id), { ...body, at: body.at != null ? Number(body.at) : undefined });
  if (!event) return json(res, 404, { error: "EVENT_NOT_FOUND" });
  json(res, 200, { event });
});

route("DELETE", "/api/events/:id", async (_req, res, p) => {
  json(res, deleteEvent(db, Number(p.id)) ? 200 : 404, {});
});

route("GET", "/api/maintenance", async (_req, res) => {
  json(res, 200, {
    status: maintenanceStatus(db),
    log: listMaintenanceLog(db),
    types: db.prepare("SELECT * FROM maintenance_types ORDER BY sort").all(),
    keys: MAINTENANCE_KEYS,
  });
});

route("POST", "/api/maintenance/:key", async (req, res, p) => {
  const body = await readJson(req);
  try {
    const entry = logMaintenance(db, p.key, { note: body.note, at: body.at != null ? Number(body.at) : undefined });
    json(res, 200, { entry, status: maintenanceStatus(db) });
  } catch (error) {
    json(res, 400, { error: "INVALID", message: error instanceof Error ? error.message : String(error) });
  }
});

// The machine cannot tell a plain flush from one with Cafiza; this promotes
// the last detected flush after the fact.
route("POST", "/api/maintenance/last-flush/cafiza", async (_req, res) => {
  const entry = markLastFlushAsCafiza(db);
  if (!entry) return json(res, 404, { error: "NO_DETECTED_FLUSH" });
  json(res, 200, { entry, status: maintenanceStatus(db) });
});

route("PATCH", "/api/maintenance/types/:key", async (req, res, p) => {
  const body = await readJson(req);
  const num = (v: unknown) => (v === null || v === "" ? null : v === undefined ? undefined : Number(v));
  const type = updateMaintenanceType(db, p.key, {
    enabled: body.enabled === undefined ? undefined : body.enabled ? 1 : 0,
    interval_shots: num(body.interval_shots),
    interval_water_l: num(body.interval_water_l),
    interval_days: num(body.interval_days),
  });
  if (!type) return json(res, 404, { error: "TYPE_NOT_FOUND" });
  json(res, 200, { type, status: maintenanceStatus(db) });
});

route("DELETE", "/api/maintenance/log/:id", async (_req, res, p) => {
  json(res, deleteMaintenanceLog(db, Number(p.id)) ? 200 : 404, {});
});

route("GET", "/api/machine/state", async (_req, res, _p, url) => {
  const now = Math.floor(Date.now() / 1000);
  const since = Number(url.searchParams.get("since") ?? now - 24 * 3600);
  const until = Number(url.searchParams.get("until") ?? now);
  const window = db
    .prepare("SELECT sampled_at, reachable, mode, target_temp, current_temp FROM machine_state WHERE sampled_at BETWEEN ? AND ? ORDER BY sampled_at")
    .all(since, until) as unknown as StateRow[];
  // The modelled body temperature needs the history before the window too:
  // a machine switched on an hour before `since` is still cooling from it.
  const history = allStateSamples(db);
  const baseline = coldBaseline(db, until);
  const mass = massTemperatureSeries(history, window.map((s) => s.sampled_at), baseline);
  const samples = window.map((s, i) => ({
    ...s,
    mass_temp: mass[i] == null ? null : Math.round(mass[i]! * 10) / 10,
    settledness: mass[i] == null || !s.target_temp ? null : settledness(mass[i]!, s.target_temp, baseline),
  }));
  // The model moves between samples — a machine holding its setpoint stores
  // one heartbeat per ten minutes while the body is still warming — so the
  // chart gets it on a minute grid, independent of when samples happened.
  const step = Math.max(60, Math.floor((until - since) / 2000));
  const grid: number[] = [];
  for (let t = since; t <= until; t += step) grid.push(t);
  const gridMass = massTemperatureSeries(history, grid, baseline);
  const setpointAt = (t: number) => {
    let target = 94;
    for (const s of window) { if (s.sampled_at > t) break; if (s.reachable && s.target_temp) target = s.target_temp; }
    return target;
  };
  const model = {
    t: grid,
    mass: gridMass.map((m) => (m == null ? null : Math.round(m * 10) / 10)),
    settledness: gridMass.map((m, i) => (m == null ? null : settledness(m, setpointAt(grid[i]), baseline))),
  };
  const shots = db
    .prepare("SELECT id, started_at, ratio, machine_settledness FROM shot_context WHERE started_at BETWEEN ? AND ? ORDER BY started_at")
    .all(since, until);
  json(res, 200, { samples, model, baseline, shots, events: listEvents(db, since, until), sessions: powerSessions(db, since), since, until });
});

route("POST", "/api/machine/mode", async (req, res) => {
  if (!(await requireMachine(res))) return;
  const body = await readJson(req);
  const result = await changeMode(String(body.mode ?? ""));
  if (!result.ok) return json(res, result.code === "INVALID_MODE" ? 400 : 502, { error: result.code, message: result.message });
  json(res, 200, { ...result, modes: SWITCHABLE_MODES });
});

route("GET", "/api/machine/settings", async (_req, res) => {
  if (!(await requireMachine(res))) return;
  try {
    json(res, 200, groupSettings(await fetchRawSettings()));
  } catch (error) {
    json(res, 502, { error: "MACHINE_UNREACHABLE", message: error instanceof Error ? error.message : String(error) });
  }
});

route("GET", "/api/profiles", async (_req, res) => {
  if (!(await requireMachine(res))) return;
  const profiles = await listProfiles();
  if (!profiles) return json(res, 502, { error: "MACHINE_UNREACHABLE" });
  json(res, 200, { profiles });
});

route("GET", "/api/profiles/:id", async (_req, res, p) => {
  if (!(await requireMachine(res))) return;
  const profile = await getProfile(p.id);
  if (!profile) return json(res, 404, { error: "PROFILE_NOT_FOUND" });
  json(res, 200, { profile });
});

route("PUT", "/api/profiles/:id", async (req, res, p) => {
  if (!(await requireMachine(res))) return;
  const body = await readJson(req);
  const result = await saveProfileMerged({ ...body, profile_id: p.id });
  if (!result.ok) return json(res, result.code === "PROFILE_NOT_FOUND" ? 404 : 502, { error: result.code, message: result.message });
  json(res, 200, result);
});

route("POST", "/api/profiles/:id/select", async (_req, res, p) => {
  if (!(await requireMachine(res))) return;
  const result = await selectProfileOnMachine(p.id);
  if (!result.ok) return json(res, result.code === "PROFILE_NOT_FOUND" ? 404 : 502, { error: result.code, message: result.message });
  json(res, 200, result);
});

route("GET", "/api/stats", async (_req, res) => {
  json(res, 200, statsSummary(db));
});

route("POST", "/api/ingest", async (_req, res) => {
  json(res, 200, await ingestOnce(db));
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = normalize(url.pathname);

  try {
    if (path === "/mcp") {
      await handleMcpRequest(db, req, res);
      return;
    }

    if (path.startsWith("/api/")) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = path.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        await r.handler(req, res, params, url);
        return;
      }
      return json(res, 404, { error: "NOT_FOUND" });
    }

    if (VENDOR[path]) {
      if (await sendFile(res, VENDOR[path], "public, max-age=86400")) return;
    }
    if (path.startsWith("/vendor/inter/")) {
      const rel = path.slice("/vendor/inter/".length);
      if (!rel.includes("..") && (await sendFile(res, join(INTER_DIR, rel), "public, max-age=604800"))) return;
    }

    // Static app; unknown paths fall back to index.html for the hash router's sake.
    const candidate = join(WEB, path === "/" ? "index.html" : path);
    if (candidate.startsWith(WEB) && (await sendFile(res, candidate))) return;
    await sendFile(res, join(WEB, "index.html"));
  } catch (error) {
    console.error(`${req.method} ${path}: ${error instanceof Error ? error.stack : error}`);
    if (!res.headersSent) json(res, 500, { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`barista-memory web on http://${HOST}:${PORT} (db ${config.databasePath}, machine ${config.deviceHost})`);
  console.log(mcpEnabled() ? `MCP over HTTP at /mcp (bearer token set)` : `MCP over HTTP off: set GAGGIMATE_MCP_TOKEN to enable /mcp`);
  if (!existsSync(join(WEB, "index.html"))) console.warn("web/index.html is missing — API only");
});
