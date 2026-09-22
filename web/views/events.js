import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { statusRows } from "../lib/maintenance.js";

const KINDS = ["equipment", "technique", "maintenance", "beans", "other"];
const toLocalInput = (unix) => { const d = new Date(unix * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (s) => Math.floor(new Date(s).getTime() / 1000);

/**
 * Turning points: a new tool, a change of technique, maintenance. Separate
 * from the grinding screen on purpose — that one holds values later shots
 * inherit; these are moments the timeline is cut at.
 */
export async function renderEvents(view) {
  const load = async () => {
    const [{ events }, maint] = await Promise.all([api.events(), api.maintenance()]);
    const enabled = maint.status.filter((m) => m.enabled);
    const intervalField = (ty, field, label) => `
      <label class="maint-interval"><span>${label}</span><input type="number" min="0" step="${field === "interval_water_l" ? "0.5" : "1"}" value="${ty[field] ?? ""}" data-type="${ty.key}" data-field="${field}"></label>`;
    view.innerHTML = `
      <h1>${t("maint.title")}</h1>
      <p class="muted" style="max-width:70ch">${t("maint.hint")}</p>
      <div class="cols">
        <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("maint.status")}</h2></div>
          <div class="maint-list">${statusRows(enabled, { actions: true })}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("events.add")}</h2></div>
          <p class="muted small" style="margin-bottom:12px">${t("events.hint")}</p>
          <form class="form" id="ef">
            <div class="field"><label>${t("events.what")}</label><input name="title" required placeholder="${t("events.what_placeholder")}"></div>
            <div class="grid cols-2">
              <div class="field"><label>${t("events.kind")}</label><select name="kind">${KINDS.map((k) => `<option value="${k}">${t("events.kind." + k)}</option>`).join("")}</select></div>
              <div class="field"><label>${t("events.when")}</label><input type="datetime-local" name="at" value="${toLocalInput(Math.floor(Date.now() / 1000))}"></div>
            </div>
            <div class="field"><label>${t("events.note")}</label><input name="note"></div>
            <div class="row"><button class="btn primary" type="submit">${t("events.add")}</button></div>
          </form>
        </section>
        </div>
        <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("maint.log")}</h2></div>
          ${maint.log.length ? `<div class="timeline">${maint.log.map((e) => `
            <div class="tl-item">
              <div class="when">${fmt.dateTime(e.at)}</div>
              <div class="row"><span class="pill ${e.auto ? "" : "accent"}">${t("maint.type." + e.type_key)}</span>${e.auto ? `<span class="faint small">${t("maint.detected")}${e.shot_id ? " · #" + e.shot_id : ""}</span>` : ""}${e.note ? `<span class="faint small">${e.note}</span>` : ""}<button class="btn sm ghost" data-del-maint="${e.id}">${t("events.delete")}</button></div>
            </div>`).join("")}</div>` : `<p class="empty">${t("maint.log_empty")}</p>`}
          <details class="maint-settings">
            <summary>${t("maint.intervals")}</summary>
            <p class="faint small">${t("maint.intervals_hint")}</p>
            ${maint.types.map((ty) => `
              <div class="maint-type-row">
                <label class="row"><input type="checkbox" data-enable="${ty.key}" ${ty.enabled ? "checked" : ""}> <b>${t("maint.type." + ty.key)}</b></label>
                <div class="row">
                  ${ty.key === "backflush" || ty.key === "cafiza" ? intervalField(ty, "interval_shots", t("maint.unit.shots")) : ""}
                  ${ty.key === "descale" || ty.key === "water_filter" ? intervalField(ty, "interval_water_l", "l") : ""}
                  ${ty.key === "gasket" ? intervalField(ty, "interval_days", t("maint.unit.days")) : ""}
                </div>
                <p class="faint small">${t("maint.why." + ty.key)}</p>
              </div>`).join("")}
          </details>
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("events.history")}</h2></div>
          ${events.length ? `<div class="timeline">${events.map((e) => `
            <div class="tl-item">
              <div class="when">${fmt.dateTime(e.at)}</div>
              <div class="row"><span class="pill accent">${t("events.kind." + e.kind)}</span><b>${e.title}</b>${e.note ? `<span class="faint small">${e.note}</span>` : ""}<button class="btn sm ghost" data-del-event="${e.id}" data-title="${e.title}">${t("events.delete")}</button></div>
            </div>`).join("")}</div>` : `<p class="empty">${t("events.none")}</p>`}
        </section>
        </div>
      </div>`;
    const ef = view.querySelector("#ef");
    ef.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(ef));
      body.at = fromLocalInput(body.at);
      try { await api.recordEvent(body); toast(t("events.saved")); load(); } catch (err) { toast(String(err.message), "bad"); }
    };
    view.querySelectorAll("[data-done]").forEach((b) => (b.onclick = async () => {
      try { await api.maintenanceDone(b.dataset.done); toast(t("maint.saved")); load(); } catch (err) { toast(String(err.message), "bad"); }
    }));
    const cafiza = view.querySelector("[data-cafiza]");
    if (cafiza) cafiza.onclick = async () => {
      try { await api.lastFlushWasCafiza(); toast(t("maint.saved")); load(); } catch (err) { toast(String(err.message), "bad"); }
    };
    view.querySelectorAll("[data-del-maint]").forEach((b) => (b.onclick = async () => {
      if (!confirm(t("maint.confirm_delete"))) return;
      await api.deleteMaintenanceLog(b.dataset.delMaint); toast(t("events.deleted")); load();
    }));
    view.querySelectorAll("[data-enable]").forEach((c) => (c.onchange = async () => {
      await api.updateMaintenanceType(c.dataset.enable, { enabled: c.checked }); load();
    }));
    view.querySelectorAll("[data-field]").forEach((i) => (i.onchange = async () => {
      await api.updateMaintenanceType(i.dataset.type, { [i.dataset.field]: i.value === "" ? null : Number(i.value) }); toast(t("maint.saved")); load();
    }));
    view.querySelectorAll("[data-del-event]").forEach((b) => (b.onclick = async () => {
      if (!confirm(t("events.confirm_delete", { title: b.dataset.title }))) return;
      await api.deleteEvent(b.dataset.delEvent); toast(t("events.deleted")); load();
    }));
  };
  await load();
}
