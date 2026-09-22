import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";

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
    const { events } = await api.events();
    view.innerHTML = `
      <h1>${t("events.title")}</h1>
      <p class="muted" style="max-width:70ch">${t("events.hint")}</p>
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head"><h2>${t("events.add")}</h2></div>
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
        <section class="card">
          <div class="card-head"><h2>${t("events.history")}</h2></div>
          ${events.length ? `<div class="timeline">${events.map((e) => `
            <div class="tl-item">
              <div class="when">${fmt.dateTime(e.at)}</div>
              <div class="row"><span class="pill accent">${t("events.kind." + e.kind)}</span><b>${e.title}</b>${e.note ? `<span class="faint small">${e.note}</span>` : ""}<button class="btn sm ghost" data-del-event="${e.id}" data-title="${e.title}">${t("events.delete")}</button></div>
            </div>`).join("")}</div>` : `<p class="empty">${t("events.none")}</p>`}
        </section>
      </div>`;
    const ef = view.querySelector("#ef");
    ef.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(ef));
      body.at = fromLocalInput(body.at);
      try { await api.recordEvent(body); toast(t("events.saved")); load(); } catch (err) { toast(String(err.message), "bad"); }
    };
    view.querySelectorAll("[data-del-event]").forEach((b) => (b.onclick = async () => {
      if (!confirm(t("events.confirm_delete", { title: b.dataset.title }))) return;
      await api.deleteEvent(b.dataset.delEvent); toast(t("events.deleted")); load();
    }));
  };
  await load();
}
