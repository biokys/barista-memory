import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { openDatabase, currentSetup, type ShotContextRow } from "../db/db.js";
import { fetchStatus, listProfiles, getProfile, fetchRawSettings } from "../device/client.js";
import { groupSettings } from "../device/machineSettings.js";
import { currentConditions, powerSessions, allStateSamples } from "../machineState.js";
import { recordSetup, updateSetup } from "../setups.js";
import { loadArchivedShot, pressureSparkline } from "../shots.js";
import { saveProfileMerged } from "../profiles.js";
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
  let commit = "";
  try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
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

route("GET", "/api/version", async (_req, res) => {
  json(res, 200, VERSION);
});

route("GET", "/api/now", async (_req, res) => {
  const live = await fetchStatus();
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

route("GET", "/api/shots/:id", async (_req, res, p) => {
  const loaded = loadArchivedShot(db, Number(p.id), true);
  if (!loaded) return json(res, 404, { error: "SHOT_NOT_FOUND" });
  // Neighbours, for the previous/next links and the default comparison.
  const prev = db.prepare("SELECT id FROM shots WHERE started_at < (SELECT started_at FROM shots WHERE id = ?) ORDER BY started_at DESC LIMIT 1").get(Number(p.id)) as any;
  const next = db.prepare("SELECT id FROM shots WHERE started_at > (SELECT started_at FROM shots WHERE id = ?) ORDER BY started_at ASC LIMIT 1").get(Number(p.id)) as any;
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
  for (const key of ["bean", "roaster", "roast_date", "grind_setting", "dose_g", "basket", "note", "valid_from"]) {
    if (body[key] !== undefined && body[key] !== "") change[key] = key === "dose_g" || key === "valid_from" ? Number(body[key]) : body[key];
  }
  json(res, 200, { setup: recordSetup(db, change) });
});

route("PATCH", "/api/setups/:id", async (req, res, p) => {
  const body = await readJson(req);
  const setup = updateSetup(db, Number(p.id), body);
  if (!setup) return json(res, 404, { error: "SETUP_NOT_FOUND" });
  json(res, 200, { setup });
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
  const samples = db
    .prepare("SELECT sampled_at, reachable, mode, target_temp, current_temp FROM machine_state WHERE sampled_at BETWEEN ? AND ? ORDER BY sampled_at")
    .all(since, until);
  const shots = db
    .prepare("SELECT id, started_at, ratio, machine_settledness FROM shot_context WHERE started_at BETWEEN ? AND ? ORDER BY started_at")
    .all(since, until);
  json(res, 200, { samples, shots, events: listEvents(db, since, until), sessions: powerSessions(db, since), since, until });
});

route("GET", "/api/machine/settings", async (_req, res) => {
  json(res, 200, groupSettings(await fetchRawSettings()));
});

route("GET", "/api/profiles", async (_req, res) => {
  const profiles = await listProfiles();
  if (!profiles) return json(res, 502, { error: "MACHINE_UNREACHABLE" });
  json(res, 200, { profiles });
});

route("GET", "/api/profiles/:id", async (_req, res, p) => {
  const profile = await getProfile(p.id);
  if (!profile) return json(res, 404, { error: "PROFILE_NOT_FOUND" });
  json(res, 200, { profile });
});

route("PUT", "/api/profiles/:id", async (req, res, p) => {
  const body = await readJson(req);
  const result = await saveProfileMerged({ ...body, profile_id: p.id });
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
  if (!existsSync(join(WEB, "index.html"))) console.warn("web/index.html is missing — API only");
});
