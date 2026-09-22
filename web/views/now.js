import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, sparkline } from "../lib/fmt.js";
import { usage, tone } from "../lib/maintenance.js";

function stateLabel(m) {
  if (!m.reachable) return t("machine.off");
  if (m.mode_name === "standby") return t("machine.standby");
  if (m.at_target) return t("machine.at_target");
  if (m.trend === "heating") return t("machine.heating");
  if (m.trend === "cooling") return t("machine.cooling");
  return t("machine.holding");
}

function readiness(p) {
  if (p == null) return { text: t("machine.unknown"), tone: "" };
  if (p >= 85) return { text: t("machine.ready"), tone: "ok" };
  if (p >= 60) return { text: t("machine.partly"), tone: "warn" };
  return { text: t("machine.cold"), tone: "bad" };
}

export async function renderNow(view) {
  const draw = (now) => {
    const m = now.machine, s = now.setup, last = now.last_shot;
    const r = readiness(m.settledness);
    view.innerHTML = `
      <div class="hero">
        <section class="card">
          <div class="card-head"><h2>${t("machine.title")}</h2><span class="pill ${m.reachable ? (m.trend === "heating" ? "warn" : "ok") : ""}">${stateLabel(m)}</span></div>
          <div class="big num">${m.reachable ? m.current_temp.toFixed(1) : "–"}<small>°C${m.reachable && m.target_temp > 0 ? " · " + t("machine.target") + " " + m.target_temp : ""}</small></div>
          <div class="gauge" title="${t("machine.settledness_hint")}"><i style="width:${m.settledness ?? 0}%"></i></div>
          <div class="row spread" style="margin-top:10px">
            <span class="muted small">${t("machine.settledness")}: <b class="num">${fmt.pct(m.settledness)}</b></span>
            <span class="pill ${r.tone}">${r.text}</span>
          </div>
          <dl class="kv" style="margin-top:16px">
            <dt>${t("machine.heating_for")}</dt><dd class="num">${fmt.duration(m.heating_for_s)}</dd>
            <dt>${t("machine.heatup")}</dt><dd class="num">${fmt.duration(m.heatup_s)}</dd>
            <dt>${t("machine.powered_for")}</dt><dd class="num">${fmt.duration(m.powered_for_s)}</dd>
          </dl>
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("now.brewing")}</h2><a class="btn sm ghost" href="#/setup">${t("setup.change")}</a></div>
          ${s ? `
            <div style="font-size:1.35rem;font-weight:580;letter-spacing:-.02em">${s.bean ?? "?"}</div>
            <div class="muted">${s.roaster ?? ""}${s.roast_date ? " · " + s.roast_date : ""}</div>
            <div class="grid cols-2" style="margin-top:18px">
              <div class="stat"><span class="v num">${s.grind_setting ?? "–"}</span><span class="l">${t("now.grind")}</span></div>
              <div class="stat"><span class="v num">${s.dose_g != null ? s.dose_g + " g" : "–"}</span><span class="l">${t("now.dose")}</span></div>
            </div>
            <p class="faint small" style="margin-top:14px">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</p>
          ` : `<p class="muted">${t("now.no_setup")}</p>`}
        </section>
      </div>
      ${(now.maintenance || []).length ? `
      <a class="maint-strip" href="#/events">
        ${now.maintenance.map((m) => `<span class="maint-chip ${tone(m)}"><b>${t("maint.type." + m.key)}</b><span class="num">${usage(m)}</span></span>`).join("")}
      </a>` : ""}
      <section class="card">
        <div class="card-head"><h2>${t("now.last_shot")}</h2>${last ? `<a class="btn sm ghost" href="#/shots/${last.id}">${t("now.open")}</a>` : ""}</div>
        ${last ? `
          <a class="shot-row" href="#/shots/${last.id}">
            ${sparkline(last.sparkline)}
            <div class="main">
              <div class="title"><b>#${last.id}</b><span class="muted">${last.profile_name ?? ""}</span><span class="faint">${fmt.dateTime(last.started_at)}</span></div>
              <div class="meta">${last.bean ?? "–"} · ${t("now.grind")} ${last.grind_setting ?? "–"} · ${fmt.stars(last.rating)}</div>
            </div>
            <div class="nums num">
              <span><b>${fmt.seconds(last.duration_ms / 1000)}</b><i>${t("shot.time")}</i></span>
              <span><b>${fmt.g(last.stable_weight_g)}</b><i>${t("shot.cup")}</i></span>
              <span><b>${fmt.ratio(last.ratio)}</b><i>${t("shot.ratio")}</i></span>
              <span><b>${fmt.pct(last.machine_settledness)}</b><i>${t("shot.machine")}</i></span>
            </div>
          </a>` : `<p class="empty">${t("now.none")}</p>`}
      </section>`;
  };
  draw(await api.now());
  const onLive = (e) => draw(e.detail);
  document.addEventListener("live", onLive);
  return () => document.removeEventListener("live", onLive);
}
