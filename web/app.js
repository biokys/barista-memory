// barista-memory web — router, i18n, API, formatting. No framework: six views,
// a hash router and a handful of helpers is all it takes, and nothing here
// needs a build step on the server.

import { t, initI18n, currentLang, setLang } from "./lib/i18n.js";
import { api } from "./lib/api.js";
import { renderNow } from "./views/now.js";
import { renderHistory } from "./views/history.js";
import { renderShot } from "./views/shot.js";
import { renderMachine } from "./views/machine.js";
import { renderStats } from "./views/stats.js";
import { renderSetup } from "./views/setup.js";
import { renderCoffees } from "./views/coffees.js";
import { renderEvents } from "./views/events.js";
import { renderProfiles } from "./views/profiles.js";
import { renderSettings } from "./views/settings.js";

const routes = [
  { path: /^#\/?$/, view: renderNow, nav: "now" },
  { path: /^#\/shots\/?$/, view: renderHistory, nav: "history" },
  { path: /^#\/shots\/(\d+)$/, view: renderShot, nav: "history" },
  { path: /^#\/machine\/?$/, view: renderMachine, nav: "machine" },
  { path: /^#\/stats\/?$/, view: renderStats, nav: "stats" },
  { path: /^#\/setup\/?$/, view: renderSetup, nav: "setup" },
  { path: /^#\/coffees(?:\/(\d+))?\/?$/, view: renderCoffees, nav: "coffees" },
  { path: /^#\/events\/?$/, view: renderEvents, nav: "events" },
  { path: /^#\/settings\/?$/, view: renderSettings, nav: "settings" },
  { path: /^#\/profiles(?:\/([^/]+))?\/?$/, view: renderProfiles, nav: "profiles" },
];

const NAV = ["now", "history", "machine", "stats", "setup", "coffees", "events", "profiles", "settings"];
const NAV_HREF = { now: "#/", history: "#/shots", machine: "#/machine", stats: "#/stats", setup: "#/setup", coffees: "#/coffees", events: "#/events", profiles: "#/profiles", settings: "#/settings" };

let cleanup = null;

function renderNav(active) {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.map((k) => `<a href="${NAV_HREF[k]}" class="${k === active ? "active" : ""}">${t("nav." + k)}</a>`).join("");
}

async function navigate() {
  const hash = location.hash || "#/";
  const view = document.getElementById("view");
  // Freeze the height while the next view loads: destroying the old charts
  // shrinks the page and the scrollbar flashes otherwise.
  view.style.minHeight = view.offsetHeight + "px";
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  for (const r of routes) {
    const m = hash.match(r.path);
    if (!m) continue;
    renderNav(r.nav);
    // The old content stays until the new view has its data and replaces it:
    // an empty frame in between made the page collapse and the scrollbar
    // flash on every navigation.
    view.classList.add("loading");
    try {
      cleanup = (await r.view(view, m.slice(1))) || null;
    } catch (error) {
      view.innerHTML = `<div class="card"><p class="muted">${t("error.generic")}</p><p class="faint small">${String(error.message || error)}</p></div>`;
      console.error(error);
    }
    view.classList.remove("loading");
    view.style.minHeight = "";
    view.classList.remove("fade"); void view.offsetWidth; view.classList.add("fade");
    window.scrollTo({ top: 0 });
    return;
  }
  location.hash = "#/";
}

// Live badge in the top bar: one cheap poll that every screen benefits from.
async function pollLive() {
  const badge = document.getElementById("live-badge");
  try {
    const now = await api.now();
    const m = now.machine;
    badge.className = "live" + (m.reachable ? (m.trend === "heating" ? " on heating" : " on") : "");
    badge.textContent = m.reachable
      ? `${m.current_temp.toFixed(0)} °C · ${t("machine.settledness_short", { n: m.settledness ?? "–" })}`
      : t("machine.off");
    document.dispatchEvent(new CustomEvent("live", { detail: now }));
  } catch {
    badge.className = "live"; badge.textContent = t("error.offline");
  }
}

document.getElementById("lang").addEventListener("click", () => {
  setLang(currentLang() === "cs" ? "en" : "cs");
  document.getElementById("lang").textContent = currentLang().toUpperCase();
  document.documentElement.lang = currentLang();
  document.getElementById("theme").title = t("theme.title");
  navigate(); pollLive();
});

// ---- theme -----------------------------------------------------------------
// Dark or light: a saved choice wins; otherwise, inside Home Assistant the
// parent page's theme is followed (ingress is same-origin, so its CSS
// variables are readable), and standalone the system preference is.

const INGRESS = location.pathname.includes("/api/hassio_ingress/");
if (INGRESS) document.documentElement.classList.add("ingress");

function parentPrefersDark() {
  try {
    const bg = getComputedStyle(window.parent.document.documentElement).getPropertyValue("--primary-background-color").trim();
    const m = bg.match(/^#([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum < 0.5;
  } catch { return null; }
}

function resolveTheme() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  if (saved === "light" || saved === "dark") return saved;
  const parent = INGRESS ? parentPrefersDark() : null;
  if (parent != null) return parent ? "dark" : "light";
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(rerender) {
  const theme = resolveTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f2ec" : "#0f0e0c");
  // Charts read their colours once, when drawn, so the current view is redrawn.
  if (rerender) navigate();
}

document.getElementById("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  try { localStorage.setItem("theme", next); } catch {}
  applyTheme(true);
});
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(true));
if (INGRESS) {
  try {
    new MutationObserver(() => applyTheme(true)).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  } catch {}
}

await initI18n();
document.getElementById("lang").textContent = currentLang().toUpperCase();
document.getElementById("theme").title = t("theme.title");
document.documentElement.lang = currentLang();
applyTheme(false);
window.addEventListener("hashchange", navigate);
navigate();
pollLive();
setInterval(pollLive, 20000);
