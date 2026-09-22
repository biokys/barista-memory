import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";

const toLocalInput = (unix) => { const d = new Date(unix * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (s) => Math.floor(new Date(s).getTime() / 1000);

const KINDS = ["equipment", "technique", "maintenance", "beans", "other"];

function eventsSection(events) {
  return `
      <section class="card">
        <div class="card-head"><h2>${t("events.title")}</h2></div>
        <p class="faint small" style="margin-bottom:12px">${t("events.hint")}</p>
        <form class="form" id="ef">
          <div class="grid cols-3">
            <div class="field" style="grid-column: span 2"><label>${t("events.what")}</label><input name="title" required placeholder="${t("events.what_placeholder")}"></div>
            <div class="field"><label>${t("events.kind")}</label><select name="kind">${KINDS.map((k) => `<option value="${k}">${t("events.kind." + k)}</option>`).join("")}</select></div>
            <div class="field"><label>${t("events.when")}</label><input type="datetime-local" name="at" value="${toLocalInput(Math.floor(Date.now() / 1000))}"></div>
            <div class="field" style="grid-column: span 2"><label>${t("events.note")}</label><input name="note"></div>
          </div>
          <div class="row"><button class="btn primary" type="submit">${t("events.add")}</button></div>
        </form>
        <div class="sep" style="margin:16px 0"></div>
        <div class="timeline">${events.length ? events.map((e) => `
          <div class="tl-item">
            <div class="when">${fmt.dateTime(e.at)}</div>
            <div class="row"><span class="pill">${t("events.kind." + e.kind)}</span><b>${e.title}</b>${e.note ? `<span class="faint small">${e.note}</span>` : ""}<button class="btn sm ghost" data-del-event="${e.id}" data-title="${e.title}">${t("events.delete")}</button></div>
          </div>`).join("") : `<p class="empty">${t("events.none")}</p>`}</div>
      </section>`;
}

export async function renderSetup(view) {
  let editing = null;
  const load = async () => {
    const [data, evs] = await Promise.all([api.setups(), api.events()]);
    const cur = data.current;
    view.innerHTML = `
      <h1>${t("setup.title")}</h1>
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head"><h2>${t("setup.current")}</h2></div>
          ${cur ? `<div style="font-size:1.5rem;font-weight:580;letter-spacing:-.02em">${cur.bean ?? "?"}</div><div class="muted">${cur.roaster ?? ""}${cur.roast_date ? " · " + cur.roast_date : ""}</div>
            <div class="grid cols-2" style="margin-top:16px"><div class="stat"><span class="v num">${cur.grind_setting ?? "–"}</span><span class="l">${t("now.grind")}</span></div><div class="stat"><span class="v num">${cur.dose_g ?? "–"} g</span><span class="l">${t("now.dose")}</span></div></div>
            <p class="faint small" style="margin-top:12px">${t("setup.since")} ${fmt.dateTime(cur.valid_from)}${cur.basket ? " · " + cur.basket : ""}</p>` : `<p class="muted">${t("now.no_setup")}</p>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("setup.change")}</h2></div>
          <p class="faint small" style="margin-bottom:12px">${t("setup.change_hint")}</p>
          <form class="form" id="f">
            <div class="grid cols-2">
              <div class="field"><label>${t("setup.bean")}</label><input name="bean" placeholder="${cur?.bean ?? ""}"></div>
              <div class="field"><label>${t("setup.roaster")}</label><input name="roaster" placeholder="${cur?.roaster ?? ""}"></div>
            </div>
            <div class="field"><label>${t("setup.grind")} · <span class="range-v num" id="gv">${cur?.grind_setting ?? "12.5"}</span></label><input type="range" name="grind_setting" min="0" max="90" step="0.1" value="${cur?.grind_setting ?? 12.5}"></div>
            <div class="field"><label>${t("setup.dose")} · <span class="range-v num" id="dv">${cur?.dose_g ?? "18"}</span></label><input type="range" name="dose_g" min="12" max="24" step="0.1" value="${cur?.dose_g ?? 18}"></div>
            <div class="grid cols-2">
              <div class="field"><label>${t("setup.roast_date")}</label><input type="date" name="roast_date" value="${cur?.roast_date ?? ""}"></div>
              <div class="field"><label>${t("setup.basket")}</label><input name="basket" placeholder="${cur?.basket ?? ""}"></div>
            </div>
            <div class="field"><label>${t("setup.note")}</label><input name="note"></div>
            <div class="row"><button class="btn primary" type="submit">${t("setup.save")}</button></div>
          </form>
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h2>${t("setup.history")}</h2><span class="faint small">${t("setup.edit_hint")}</span></div>
        <div class="timeline">${data.setups.map((s) => `
          <div class="tl-item ${s.id === cur?.id ? "current" : ""}" data-id="${s.id}">
            <div class="when">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</div>
            ${editing === s.id ? `
              <form class="form edit" style="margin-top:8px">
                <div class="grid cols-3">
                  <div class="field"><label>${t("setup.bean")}</label><input name="bean" value="${s.bean ?? ""}"></div>
                  <div class="field"><label>${t("setup.roaster")}</label><input name="roaster" value="${s.roaster ?? ""}"></div>
                  <div class="field"><label>${t("setup.roast_date")}</label><input type="date" name="roast_date" value="${s.roast_date ?? ""}"></div>
                  <div class="field"><label>${t("setup.grind")}</label><input name="grind_setting" value="${s.grind_setting ?? ""}"></div>
                  <div class="field"><label>${t("setup.dose")}</label><input type="number" step="0.1" name="dose_g" value="${s.dose_g ?? ""}"></div>
                  <div class="field"><label>${t("setup.valid_from")}</label><input type="datetime-local" name="valid_from" value="${toLocalInput(s.valid_from)}"></div>
                </div>
                <div class="row"><button class="btn primary sm" type="submit">${t("shot.save")}</button><button class="btn sm ghost" type="button" data-cancel>${t("setup.cancel")}</button></div>
              </form>` : `
              <div class="row"><b>${s.bean ?? "–"}</b><span class="muted">${s.roaster ?? ""}</span><span class="pill num">${t("now.grind")} ${s.grind_setting ?? "–"}</span><span class="pill num">${s.dose_g ?? "–"} g</span>${s.note ? `<span class="faint small">${s.note}</span>` : ""}<button class="btn sm ghost" data-edit="${s.id}">${t("setup.edit")}</button></div>`}
          </div>`).join("")}</div>
      </section>
      ${eventsSection(evs.events)}`;

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

    const f = view.querySelector("#f");
    f.grind_setting.oninput = () => (view.querySelector("#gv").textContent = f.grind_setting.value);
    f.dose_g.oninput = () => (view.querySelector("#dv").textContent = f.dose_g.value);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const change = Object.fromEntries([...new FormData(f)].filter(([, v]) => v !== ""));
      const before = cur?.id;
      const r = await api.recordSetup(change);
      toast(r.setup.id === before ? t("setup.unchanged") : t("setup.saved", { bean: r.setup.bean ?? "?", grind: r.setup.grind_setting ?? "?", dose: r.setup.dose_g ?? "?" }));
      editing = null; load();
    };
    view.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { editing = Number(b.dataset.edit); load(); }));
    view.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => { editing = null; load(); }));
    const editForm = view.querySelector("form.edit");
    if (editForm) editForm.onsubmit = async (e) => {
      e.preventDefault();
      const change = Object.fromEntries([...new FormData(editForm)]);
      change.valid_from = fromLocalInput(change.valid_from);
      if (change.dose_g !== "") change.dose_g = Number(change.dose_g); else delete change.dose_g;
      await api.updateSetup(editing, change);
      toast(t("setup.updated")); editing = null; load();
    };
  };
  await load();
}
