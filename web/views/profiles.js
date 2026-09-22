import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { toast } from "../lib/fmt.js";

const TARGET_TYPES = ["volumetric", "pumped", "pressure", "flow"];

function phaseCard(p, i) {
  return `<div class="card" data-phase="${i}" style="background:var(--bg-2)">
    <div class="row spread" style="margin-bottom:10px"><b>${t("profiles.phase")} ${i + 1}</b><button type="button" class="btn sm ghost" data-remove="${i}">${t("profiles.remove_phase")}</button></div>
    <div class="grid cols-3">
      <div class="field"><label>${t("profiles.phase.name")}</label><input name="name" value="${p.name ?? ""}"></div>
      <div class="field"><label>${t("profiles.phase.type")}</label><select name="phase"><option ${p.phase === "preinfusion" ? "selected" : ""}>preinfusion</option><option ${p.phase !== "preinfusion" ? "selected" : ""}>brew</option></select></div>
      <div class="field"><label>${t("profiles.phase.valve")}</label><select name="valve"><option value="1" ${p.valve !== 0 ? "selected" : ""}>open</option><option value="0" ${p.valve === 0 ? "selected" : ""}>closed</option></select></div>
      <div class="field"><label>${t("profiles.phase.duration")}</label><input type="number" step="0.5" name="duration" value="${p.duration}"></div>
      <div class="field"><label>${t("profiles.phase.temp")}</label><input type="number" step="0.5" name="temperature" value="${p.temperature ?? ""}"></div>
      <div class="field"><label>${t("profiles.phase.pump")}</label><select name="pump.target"><option ${p.pump?.target === "pressure" ? "selected" : ""}>pressure</option><option ${p.pump?.target === "flow" ? "selected" : ""}>flow</option></select></div>
      <div class="field"><label>${t("profiles.phase.pressure")}</label><input type="number" step="0.1" name="pump.pressure" value="${p.pump?.pressure ?? 0}"></div>
      <div class="field"><label>${t("profiles.phase.flow")}</label><input type="number" step="0.1" name="pump.flow" value="${p.pump?.flow ?? 0}"></div>
      <div class="field"><label>${t("profiles.phase.transition")}</label><select name="transition.type">${["instant", "linear", "ease-in", "ease-out"].map((k) => `<option ${p.transition?.type === k ? "selected" : ""}>${k}</option>`).join("")}</select></div>
      <div class="field"><label>${t("profiles.phase.transition_s")}</label><input type="number" step="0.5" name="transition.duration" value="${p.transition?.duration ?? 0}"></div>
    </div>
    <div class="field" style="margin-top:8px"><label>${t("profiles.phase.targets")}</label>
      <div class="row" data-targets>${(p.targets || []).map((tg, j) => `<span class="pill" data-target="${j}"><select name="t.type" class="ghost" style="background:none;border:none">${TARGET_TYPES.map((k) => `<option ${tg.type === k ? "selected" : ""}>${k}</option>`).join("")}</select> ≥ <input name="t.value" type="number" step="0.5" value="${tg.value}" style="width:64px;background:none;border:none;border-bottom:1px solid var(--line-2)"> <button type="button" data-rm-target="${j}" class="btn sm ghost" style="padding:0 6px">×</button></span>`).join("")}
        <button type="button" class="btn sm ghost" data-add-target>+</button></div></div>
  </div>`;
}

function readPhases(root) {
  return [...root.querySelectorAll("[data-phase]")].map((card) => {
    const v = (n) => card.querySelector(`[name="${n}"]`)?.value;
    const targets = [...card.querySelectorAll("[data-target]")].map((el) => ({ type: el.querySelector('[name="t.type"]').value, operator: "gte", value: Number(el.querySelector('[name="t.value"]').value) }));
    return {
      name: v("name"), phase: v("phase"), valve: Number(v("valve")), duration: Number(v("duration")),
      temperature: v("temperature") ? Number(v("temperature")) : undefined,
      pump: { target: v("pump.target"), pressure: Number(v("pump.pressure")), flow: Number(v("pump.flow")) },
      transition: { type: v("transition.type"), duration: Number(v("transition.duration")), target: "time", adaptive: false },
      targets,
    };
  });
}

export async function renderProfiles(view, [id]) {
  let list;
  try { list = (await api.profiles()).profiles; } catch { view.innerHTML = `<h1>${t("profiles.title")}</h1><p class="empty">${t("profiles.unreachable")}</p>`; return; }

  if (!id) {
    view.innerHTML = `<h1>${t("profiles.title")}</h1><div class="list">${list.map((p) => `
      <a class="shot-row" href="#/profiles/${p.id}" style="grid-template-columns:1fr auto">
        <div class="main"><div class="title"><b>${p.label}</b>${p.selected ? `<span class="pill accent">${t("profiles.selected")}</span>` : ""}${p.favorite ? `<span class="pill">★ ${t("profiles.favorite")}</span>` : ""}${p.utility ? `<span class="pill">${t("profiles.utility")}</span>` : ""}</div>
        <div class="meta">${p.description ?? ""}</div></div>
        <div class="nums num"><span><b>${p.temperature} °C</b><i>${t("profiles.temperature").split(" ")[0]}</i></span><span><b>${p.phases?.length ?? "–"}</b><i>${t("profiles.phases")}</i></span></div>
      </a>`).join("")}</div>`;
    return;
  }

  const { profile: p } = await api.profile(id);
  let phases = structuredClone(p.phases);
  const draw = () => {
    view.innerHTML = `
      <div class="row spread"><div><a class="faint small" href="#/profiles">← ${t("common.back")}</a><h1>${p.label}</h1></div><span class="pill warn">${t("profiles.warn")}</span></div>
      <form id="pf" class="form">
        <section class="card"><div class="grid cols-3">
          <div class="field"><label>${t("profiles.phase.name")}</label><input name="label" value="${p.label}"></div>
          <div class="field"><label>${t("profiles.temperature")}</label><input type="number" step="0.5" name="temperature" value="${p.temperature}"></div>
          <div class="field"><label>${t("profiles.description")}</label><input name="description" value="${p.description ?? ""}"></div>
        </div></section>
        <div id="phases" class="grid">${phases.map(phaseCard).join("")}</div>
        <div class="row spread"><button type="button" class="btn ghost" id="add">${t("profiles.add_phase")}</button><button type="submit" class="btn primary">${t("profiles.save")}</button></div>
      </form>`;
    const form = view.querySelector("#pf");
    view.querySelector("#add").onclick = () => { phases = readPhases(form); phases.push({ name: "Phase", phase: "brew", valve: 1, duration: 10, pump: { target: "pressure", pressure: 9, flow: 0 }, transition: { type: "linear", duration: 2 }, targets: [] }); draw(); };
    view.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => { phases = readPhases(form); phases.splice(Number(b.dataset.remove), 1); draw(); }));
    view.querySelectorAll("[data-add-target]").forEach((b) => (b.onclick = () => { phases = readPhases(form); phases[Number(b.closest("[data-phase]").dataset.phase)].targets.push({ type: "volumetric", operator: "gte", value: 40 }); draw(); }));
    view.querySelectorAll("[data-rm-target]").forEach((b) => (b.onclick = () => { phases = readPhases(form); const i = Number(b.closest("[data-phase]").dataset.phase); phases[i].targets.splice(Number(b.dataset.rmTarget), 1); draw(); }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!confirm(t("profiles.confirm", { label: form.label.value }))) return;
      try {
        await api.saveProfile(p.id, { label: form.label.value, temperature: Number(form.temperature.value), description: form.description.value, phases: readPhases(form) });
        toast(t("profiles.saved")); location.hash = "#/profiles";
      } catch (err) { toast(String(err.message), "bad"); }
    };
  };
  draw();
}
