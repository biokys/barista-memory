import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, sparkline, toast, verdictText, verdictTone } from "../lib/fmt.js";
import { usage, tone } from "../lib/maintenance.js";

function stateLabel(m) {
  if (!m.reachable) return t("machine.off");
  if (m.mode_name === "standby") return t("machine.standby");
  if (m.at_target) return t("machine.at_target");
  if (m.trend === "heating") return t("machine.heating");
  if (m.trend === "cooling") return t("machine.cooling");
  return t("machine.holding");
}

function readiness(p, reachable) {
  // A cooling body can still read 90 %, but an off machine is not "ready".
  if (!reachable) return { text: t("machine.off"), tone: "" };
  if (p == null) return { text: t("machine.unknown"), tone: "" };
  if (p >= 85) return { text: t("machine.ready"), tone: "ok" };
  if (p >= 60) return { text: t("machine.partly"), tone: "warn" };
  return { text: t("machine.cold"), tone: "bad" };
}

/**
 * The dial-in lines: the verdict on the last shot when the coffee has
 * targets, else a hint to set them; and, for a coffee with no shots of its
 * own yet, where to start.
 */
function dialinBlock(d) {
  if (!d) return "";
  const parts = [];
  const v = d.verdict;
  if (v && v.code !== "no_data") {
    const text = verdictText(v);
    if (text) parts.push(`<div class="row" style="margin-top:12px"><span class="pill ${verdictTone(v)}">${t("dialin.next")}</span><span>${text}</span><span class="faint small num">${v.seconds != null ? v.seconds + " s" : ""}${v.targets?.time_min_s != null || v.targets?.time_max_s != null ? ` / ${v.targets.time_min_s ?? "?"}–${v.targets.time_max_s ?? "?"} s` : ""}</span></div>`);
    else if (v.code === "no_targets" && v.coffee) parts.push(`<p class="faint small" style="margin-top:12px">${t("dialin.no_targets")}</p>`);
  }
  const s = d.suggestion;
  if (s && s.source !== "none" && s.source !== "coffee") {
    parts.push(`<p class="small muted" style="margin-top:8px">${t("dialin.start", { grind: s.grind_setting ?? "?", dose: s.dose_g ?? "?" })} <span class="faint">${t("dialin.source." + s.source, { coffee: s.from_coffee ?? "" })}</span></p>`);
  }
  return parts.join("");
}

/** "Ready in": minutes from the current state, or "now" once the warm-up model says so. */
function readyIn(m) {
  if (m.minutes_to_ready == null) return "–";
  if (m.minutes_to_ready === 0) return t("machine.ready_now");
  return `~${m.minutes_to_ready} min`;
}

const PLAN_KEY = "coffee_at";
/** Within this, the machine's current warmth still counts; beyond it, plan from cold. */
const SOON_MS = 90 * 60000;
function readPlan() { try { return localStorage.getItem(PLAN_KEY) || ""; } catch { return ""; } }

/**
 * When to switch on for a coffee at a chosen time: the time minus the
 * from-cold estimate, or minus the current one if the machine is already
 * warming. The chosen time is a per-viewer convenience kept in the browser.
 */
function planner(m) {
  const at = readPlan();
  let advice = "";
  if (at) {
    const [h, min] = at.split(":").map(Number);
    const target = new Date(); target.setHours(h, min, 0, 0);
    if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1);
    // A warm machine is only worth counting on for a coffee soon; by tomorrow
    // morning it has cooled, so anything further off plans from cold.
    const soon = target.getTime() - Date.now() < SOON_MS;
    const minutes = soon && m.reachable && m.minutes_to_ready != null ? m.minutes_to_ready : m.minutes_to_ready_from_cold;
    const on = new Date(target.getTime() - minutes * 60000);
    advice = on.getTime() <= Date.now()
      ? t("machine.switch_on_now", { at })
      : t("machine.switch_on_at", { at, on: fmt.time(on.getTime() / 1000), minutes });
  }
  return `<div class="row small muted" style="margin-top:12px;gap:8px"><label class="row" style="gap:6px">${t("machine.coffee_at")} <input type="time" id="coffee-at" value="${at}" style="width:auto"></label>${advice ? `<span class="pill">${advice}</span>` : `<span class="faint">${t("machine.from_cold", { minutes: m.minutes_to_ready_from_cold })}</span>`}</div>`;
}

/** The modes a person can switch to from here; grind is the grinder's business. */
const MODES = ["standby", "brew", "steam", "water"];

export async function renderNow(view) {
  const draw = (now) => {
    const m = now.machine, s = now.setup, last = now.last_shot;
    const r = readiness(m.settledness, m.reachable);
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
            <dt>${t("machine.ready_in")}</dt><dd class="num">${readyIn(m)}</dd>
          </dl>
          ${planner(m)}
          <div class="seg" style="margin-top:18px" role="group" aria-label="${t("machine.control")}">
            ${MODES.map((mode) => `<button type="button" data-mode="${mode}" class="${m.reachable && m.mode_name === mode ? "active" : ""}" ${m.reachable ? "" : "disabled"}>${t("machine.mode." + mode)}</button>`).join("")}
          </div>
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
            ${now.stock?.remaining_g != null ? `<p class="small ${now.stock.low ? "" : "muted"}" style="margin-top:6px">${now.stock.low ? `<span class="pill warn">${t("now.stock_low")}</span> ` : ""}${t("now.stock", { g: now.stock.remaining_g, days: now.stock.days_left != null ? t("coffees.days", { n: now.stock.days_left }) : "–" })}</p>` : ""}
          ` : `<p class="muted">${t("now.no_setup")}</p>`}
          ${dialinBlock(now.dialin)}
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
  let latest = null;
  view.addEventListener("change", (e) => {
    if (e.target.id !== "coffee-at") return;
    try { localStorage.setItem(PLAN_KEY, e.target.value); } catch {}
    if (latest) draw(latest);
  });
  // One handler on the view, since draw() replaces the buttons on every poll.
  view.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-mode]");
    if (!button || button.disabled || button.classList.contains("active")) return;
    view.querySelectorAll("[data-mode]").forEach((b) => (b.disabled = true));
    try {
      await api.setMode(button.dataset.mode);
      toast(t("machine.mode_changed", { mode: t("machine.mode." + button.dataset.mode) }));
    } catch (err) {
      toast(t("machine.mode_failed") + " " + err.message, "bad");
    }
    draw(await api.now());
  });
  const drawLatest = (now) => { latest = now; draw(now); };
  drawLatest(await api.now());
  const onLive = (e) => drawLatest(e.detail);
  document.addEventListener("live", onLive);
  return () => document.removeEventListener("live", onLive);
}
