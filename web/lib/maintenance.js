import { t } from "./i18n.js";
import { fmt } from "./fmt.js";

/** "38 / 60 shots · 12,4 / 40 l" — whichever dimensions the routine is measured in. */
export function usage(m) {
  const parts = [];
  if (m.interval_shots != null) parts.push(`${m.shots_since ?? "–"} / ${m.interval_shots} ${t("maint.unit.shots")}`);
  if (m.interval_water_l != null) parts.push(`${m.water_l_since != null ? m.water_l_since.toLocaleString() : "–"} / ${m.interval_water_l} l`);
  if (m.interval_days != null) parts.push(`${m.days_since ?? "–"} / ${m.interval_days} ${t("maint.unit.days")}`);
  return parts.join(" · ");
}

/** Red only when overdue; amber when coming up; otherwise quiet. */
export function tone(m) {
  return m.state === "due" ? "bad" : m.state === "soon" ? "warn" : m.state === "never" ? "" : "ok";
}

export function lastLine(m) {
  if (!m.last_at) return t("maint.never");
  return `${t("maint.last")} ${fmt.dateTime(m.last_at)}${m.last_auto ? " · " + t("maint.detected") : ""}`;
}

/** One compact row per routine: name, progress bar, usage, state. */
export function statusRows(status, { actions = false } = {}) {
  return status.map((m) => {
    const pct = Math.min(100, Math.round((m.fraction ?? 0) * 100));
    return `
      <div class="maint-row ${tone(m)}" data-key="${m.key}">
        <div class="maint-head">
          <b>${t("maint.type." + m.key)}</b>
          <span class="pill ${tone(m)}">${t("maint.state." + m.state)}</span>
        </div>
        <div class="gauge maint-gauge"><i style="width:${pct}%"></i></div>
        <div class="row spread small">
          <span class="num">${usage(m)}</span>
          <span class="faint">${lastLine(m)}</span>
        </div>
        ${actions ? `<div class="row" style="margin-top:8px">
          <button class="btn sm" data-done="${m.key}">${t("maint.done." + m.key)}</button>
          ${m.key === "backflush" && m.last_auto ? `<button class="btn sm ghost" data-cafiza title="${t("maint.cafiza_hint")}">${t("maint.with_cafiza")}</button>` : ""}
        </div>` : ""}
      </div>`;
  }).join("");
}
