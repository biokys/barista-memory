import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt } from "../lib/fmt.js";
import { machineChart } from "../lib/charts.js";

const RANGES = { "6h": 6 * 3600, "24h": 24 * 3600, "3d": 3 * 86400, "7d": 7 * 86400 };

export async function renderMachine(view) {
  let range = localStorage.getItem("machine.range") || "24h";
  let destroy = null;
  const load = async () => {
    const now = Math.floor(Date.now() / 1000);
    const [state, settings] = await Promise.all([api.machineState(now - RANGES[range], now), api.machineSettings().catch(() => null)]);
    view.innerHTML = `
      <div class="row spread"><h1>${t("machine.title")}</h1>
        <div class="row">${Object.keys(RANGES).map((k) => `<button class="btn sm ${k === range ? "primary" : "ghost"}" data-r="${k}">${t("machine.range." + k)}</button>`).join("")}</div></div>
      <section class="card">
        <div class="card-head"><h2>${t("machine.temperature_history")}</h2></div>
        <div class="chart" id="chart"></div>
        ${state.samples.length ? "" : `<p class="empty">${t("machine.no_samples")}</p>`}
      </section>
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head"><h2>${t("machine.sessions")}</h2></div>
          <div class="timeline">${[...state.sessions].reverse().map((s) => `
            <div class="tl-item ${s.ended_at ? "" : "current"}">
              <div class="when">${fmt.dateTime(s.started_at)} → ${s.ended_at ? fmt.time(s.ended_at) : t("machine.session.running")} · ${fmt.duration(s.duration_s ?? (Date.now() / 1000 - s.started_at))}</div>
              <div class="row small"><span class="num">${t("machine.session.from")} ${s.temp_at_start?.toFixed(0) ?? "–"} °C</span>
                ${s.heatup_s != null ? `<span class="pill">${t("machine.heatup")} ${fmt.duration(s.heatup_s)}</span>` : ""}
                <span class="pill">${s.shots} ${t("machine.session.shots")}</span></div>
            </div>`).join("") || `<p class="empty">${t("machine.no_samples")}</p>`}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("machine.settings")}</h2></div>
          ${settings ? Object.entries(settings.settings).map(([g, vals]) => `<h3 class="small muted" style="margin:10px 0 4px;text-transform:capitalize">${g}</h3><dl class="kv small">${Object.entries(vals).map(([k, v]) => `<dt>${k}</dt><dd class="num">${v}</dd>`).join("")}</dl>`).join("") : `<p class="muted">${t("profiles.unreachable")}</p>`}
        </section>
      </div>`;
    view.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => { range = b.dataset.r; localStorage.setItem("machine.range", range); load(); }));
    if (destroy) destroy();
    destroy = state.samples.length ? machineChart(view.querySelector("#chart"), state.samples, state.shots, state.sessions, state.events || []) : null;
  };
  await load();
  return () => destroy && destroy();
}
