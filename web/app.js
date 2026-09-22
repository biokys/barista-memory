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
import { renderProfiles } from "./views/profiles.js";

const routes = [
  { path: /^#\/?$/, view: renderNow, nav: "now" },
  { path: /^#\/shots\/?$/, view: renderHistory, nav: "history" },
  { path: /^#\/shots\/(\d+)$/, view: renderShot, nav: "history" },
  { path: /^#\/machine\/?$/, view: renderMachine, nav: "machine" },
  { path: /^#\/stats\/?$/, view: renderStats, nav: "stats" },
  { path: /^#\/setup\/?$/, view: renderSetup, nav: "setup" },
  { path: /^#\/profiles(?:\/([^/]+))?\/?$/, view: renderProfiles, nav: "profiles" },
];

const NAV = ["now", "history", "machine", "stats", "setup", "profiles"];
const NAV_HREF = { now: "#/", history: "#/shots", machine: "#/machine", stats: "#/stats", setup: "#/setup", profiles: "#/profiles" };

let cleanup = null;

function renderNav(active) {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.map((k) => `<a href="${NAV_HREF[k]}" class="${k === active ? "active" : ""}">${t("nav." + k)}</a>`).join("");
}

async function navigate() {
  const hash = location.hash || "#/";
  const view = document.getElementById("view");
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  for (const r of routes) {
    const m = hash.match(r.path);
    if (!m) continue;
    renderNav(r.nav);
    view.innerHTML = "";
    view.classList.remove("fade"); void view.offsetWidth; view.classList.add("fade");
    try {
      cleanup = (await r.view(view, m.slice(1))) || null;
    } catch (error) {
      view.innerHTML = `<div class="card"><p class="muted">${t("error.generic")}</p><p class="faint small">${String(error.message || error)}</p></div>`;
      console.error(error);
    }
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
  navigate(); pollLive();
});

await initI18n();
document.getElementById("lang").textContent = currentLang().toUpperCase();
document.documentElement.lang = currentLang();
window.addEventListener("hashchange", navigate);
navigate();
pollLive();
setInterval(pollLive, 20000);
