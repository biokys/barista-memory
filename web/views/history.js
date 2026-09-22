import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, sparkline } from "../lib/fmt.js";

function badges(s) {
  const out = [];
  if (s.stable_weight_source === "curve") out.push(`<span class="pill warn">${t("history.badge.curve")}</span>`);
  if (s.stable_weight_source === "none") out.push(`<span class="pill bad">${t("history.badge.noweight")}</span>`);
  if (s.machine_settledness != null && s.machine_settledness < 60) out.push(`<span class="pill bad">${t("history.badge.cold")}</span>`);
  return out.join(" ");
}

export function shotRow(s) {
  return `<a class="shot-row" href="#/shots/${s.id}">
    ${sparkline(s.sparkline)}
    <div class="main">
      <div class="title"><b>#${s.id}</b><span class="muted">${s.bean ?? "–"}</span><span class="faint">${fmt.dateTime(s.started_at)}</span>${badges(s)}</div>
      <div class="meta">${s.profile_name ?? ""} · ${t("now.grind")} ${s.grind_setting ?? "–"} · ${s.dose_g ?? "–"} g · ${fmt.stars(s.rating)}</div>
    </div>
    <div class="nums num">
      <span><b>${fmt.seconds(s.duration_ms / 1000)}</b><i>${t("shot.time")}</i></span>
      <span><b>${fmt.g(s.stable_weight_g)}</b><i>${t("shot.cup")}</i></span>
      <span><b>${fmt.ratio(s.ratio)}</b><i>${t("shot.ratio")}</i></span>
      <span><b class="${fmt.settledTone(s.machine_settledness) ? "" : "faint"}">${fmt.pct(s.machine_settledness)}</b><i>${t("shot.machine")}</i></span>
    </div>
  </a>`;
}

/** Shots newest first, with each event dropped in where it happened. */
function interleave(shots, events) {
  const evs = [...events].sort((a, b) => b.at - a.at);
  const out = []; let i = 0;
  for (const s of shots) {
    while (i < evs.length && evs[i].at >= s.started_at) { out.push(eventRow(evs[i])); i++; }
    out.push(shotRow(s));
  }
  while (i < evs.length) out.push(eventRow(evs[i++]));
  return out.join("");
}

function eventRow(e) {
  return `<div class="event-row"><span class="pill accent">${t("events.kind." + e.kind)}</span><b>${e.title}</b><span class="faint small">${fmt.dateTime(e.at)}</span></div>`;
}

export async function renderHistory(view) {
  const state = { bean: "", profile: "" };
  const load = async () => {
    const q = { limit: 200 };
    if (state.bean) q.bean = state.bean;
    if (state.profile) q.profile = state.profile;
    const data = await api.shots(q);
    view.innerHTML = `
      <div class="row spread">
        <h1>${t("history.title")} <span class="muted" style="font-weight:400;font-size:1rem">· ${t("history.count", { n: data.shots.length })}</span></h1>
        <div class="row">
          <select id="f-bean" class="btn sm"><option value="">${t("history.all_beans")}</option>${data.beans.map((b) => `<option ${b === state.bean ? "selected" : ""}>${b}</option>`).join("")}</select>
          <select id="f-profile" class="btn sm"><option value="">${t("history.all_profiles")}</option>${data.profiles.map((p) => `<option ${p === state.profile ? "selected" : ""}>${p}</option>`).join("")}</select>
        </div>
      </div>
      <div class="list">${data.shots.length ? interleave(data.shots, data.events || []) : `<p class="empty">${t("history.empty")}</p>`}</div>`;
    view.querySelector("#f-bean").onchange = (e) => { state.bean = e.target.value; load(); };
    view.querySelector("#f-profile").onchange = (e) => { state.profile = e.target.value; load(); };
  };
  await load();
}
