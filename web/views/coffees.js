import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { shotRow } from "./history.js";
import { scatterChart } from "../lib/charts.js";

/**
 * Coffees as identities: the list, and one coffee with its details, targets,
 * periods and shots. The grinding screen picks from this list; a bean typed
 * there as text lands here too.
 */

const FIELDS = [
  ["name", "text"], ["roaster", "text"], ["origin", "text"], ["process", "text"], ["roast_level", "text"],
  ["bag_g", "number"], ["target_time_min_s", "number"], ["target_time_max_s", "number"], ["target_ratio", "number"],
];

function form(c = {}, submitLabel) {
  const input = (name, type) => `<div class="field"><label>${t("coffees." + name)}</label><input name="${name}" type="${type}" ${type === "number" ? 'step="0.1" min="0"' : ""} value="${c[name] ?? ""}" ${name === "name" ? "required" : ""}></div>`;
  return `
    <form class="form" id="cf">
      <div class="grid cols-2">${input("name", "text")}${input("roaster", "text")}</div>
      <div class="grid cols-3">${input("origin", "text")}${input("process", "text")}${input("roast_level", "text")}</div>
      <div class="grid cols-3">${input("bag_g", "number")}${input("target_time_min_s", "number")}${input("target_time_max_s", "number")}</div>
      <div class="grid cols-2">${input("target_ratio", "number")}<div class="field"><label>${t("coffees.note")}</label><input name="note" value="${c.note ?? ""}"></div></div>
      <p class="faint small">${t("coffees.targets_hint")}</p>
      <div class="row"><button class="btn primary" type="submit">${submitLabel}</button></div>
    </form>`;
}

function readForm(f) {
  const out = {};
  for (const [name, type] of FIELDS) {
    const v = f[name].value.trim();
    out[name] = v === "" ? null : type === "number" ? Number(v) : v;
  }
  out.note = f.note.value.trim() || null;
  return out;
}

async function submitCoffee(f, save) {
  try {
    await save(readForm(f));
    toast(t("coffees.saved"));
    return true;
  } catch (err) {
    toast(err.message === "COFFEE_EXISTS" || /already exists/.test(err.message) ? t("coffees.exists") : err.message, "bad");
    return false;
  }
}

async function renderList(view) {
  const { coffees } = await api.coffees(true);
  const active = coffees.filter((c) => !c.archived);
  const archived = coffees.filter((c) => c.archived);
  const row = (c) => `
    <a class="shot-row" href="#/coffees/${c.id}">
      <div class="main">
        <div class="title"><b>${c.name}</b><span class="muted">${c.roaster ?? ""}</span>${c.in_use ? `<span class="pill accent">${t("coffees.in_use")}</span>` : ""}${c.archived ? `<span class="pill">${t("coffees.archived")}</span>` : ""}</div>
        <div class="meta">${[c.origin, c.process, c.roast_level].filter(Boolean).join(" · ") || "&nbsp;"}</div>
      </div>
      <div class="nums num">
        <span><b>${c.shots}</b><i>${t("coffees.shots")}</i></span>
        <span><b>${c.avg_seconds ?? "–"} s</b><i>${t("shot.time")}</i></span>
        <span><b>${fmt.ratio(c.avg_ratio)}</b><i>${t("shot.ratio")}</i></span>
        <span><b>${c.avg_rating ?? "–"}</b><i>${t("coffees.rating")}</i></span>
        <span><b>${c.last_at ? fmt.date(c.last_at) : "–"}</b><i>${t("coffees.last")}</i></span>
      </div>
    </a>`;
  view.innerHTML = `
    <h1>${t("coffees.title")}</h1>
    <div class="cols">
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("coffees.list")}</h2></div>
          <div class="list">${active.length ? active.map(row).join("") : `<p class="empty">${t("coffees.empty")}</p>`}</div>
          ${archived.length ? `<details style="margin-top:12px"><summary class="muted small">${t("coffees.archived")} (${archived.length})</summary><div class="list">${archived.map(row).join("")}</div></details>` : ""}
        </section>
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("coffees.new")}</h2></div>
          ${form({}, t("coffees.save"))}
        </section>
      </div>
    </div>`;
  const f = view.querySelector("#cf");
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (await submitCoffee(f, (input) => api.createCoffee(input))) renderList(view);
  };
}

async function renderDetail(view, id) {
  let data;
  try {
    data = await api.coffee(id);
  } catch {
    view.innerHTML = `<div class="card" style="text-align:center;padding:48px 24px"><h1>${t("coffees.missing")}</h1><p style="margin-top:20px"><a class="btn" href="#/coffees">${t("coffees.title")}</a></p></div>`;
    return;
  }
  const { coffee: c, shots, setups, aging, bags } = data;
  const bagRow = (b) => `<tr class="${b.current ? "current" : ""}">
    <td>${b.roast_date ?? "–"}${b.current ? ` <span class="pill accent">${t("coffees.in_use")}</span>` : ""}</td>
    <td class="r num">${fmt.date(b.opened_at)}</td>
    <td class="r num">${b.shots}</td>
    <td class="r num">${b.used_g ?? "–"} g</td>
    <td class="r num">${b.remaining_g != null ? b.remaining_g + " g" : "–"}</td>
    <td class="r num">${b.g_per_day != null ? b.g_per_day + " g" : "–"}</td>
    <td class="r num">${b.days_left != null ? t("coffees.days", { n: b.days_left }) : "–"}</td>
  </tr>`;
  const targets = c.target_time_min_s || c.target_time_max_s || c.target_ratio
    ? `${c.target_time_min_s ?? "?"}–${c.target_time_max_s ?? "?"} s${c.target_ratio ? ` · 1:${c.target_ratio}` : ""}`
    : t("coffees.no_targets");
  view.innerHTML = `
    <div class="row spread">
      <div>
        <h1>${c.name}</h1>
        <p class="muted">${[c.roaster, c.origin, c.process, c.roast_level].filter(Boolean).join(" · ")}</p>
      </div>
      <div class="row">
        ${c.in_use ? `<span class="pill accent">${t("coffees.in_use")}</span>` : `<button class="btn sm ghost" id="use">${t("coffees.use")}</button>`}
        <button class="btn sm ghost" id="archive">${c.archived ? t("coffees.unarchive") : t("coffees.archive")}</button>
        <a class="btn sm ghost" href="#/coffees">← ${t("coffees.title")}</a>
      </div>
    </div>
    <div class="grid cols-3" style="margin-bottom:14px">
      <div class="card stat"><span class="v num">${c.shots}</span><span class="l">${t("coffees.shots")}</span></div>
      <div class="card stat"><span class="v num">${c.avg_seconds ?? "–"} s</span><span class="l">${t("shot.time")}</span></div>
      <div class="card stat"><span class="v num">${fmt.ratio(c.avg_ratio)}</span><span class="l">${t("shot.ratio")}</span></div>
      <div class="card stat"><span class="v num">${c.avg_rating ?? "–"}</span><span class="l">${t("coffees.rating")}</span></div>
      <div class="card stat"><span class="v num">${c.bags}</span><span class="l">${t("coffees.bags")}</span></div>
      <div class="card stat"><span class="v num" style="font-size:1rem">${targets}</span><span class="l">${t("coffees.targets")}</span></div>
    </div>
    <section class="card">
      <div class="card-head"><h2>${t("coffees.aging")}</h2><span class="faint small">${t("coffees.aging_hint")}</span></div>
      ${aging.length >= 3 ? `<div class="grid cols-2"><div class="chart chart-stat" id="age-time"></div><div class="chart chart-stat" id="age-ratio"></div></div>` : `<p class="empty">${t("coffees.aging_empty")}</p>`}
    </section>
    <section class="card">
      <div class="card-head"><h2>${t("coffees.bags")}</h2>${c.bag_g ? "" : `<span class="faint small">${t("coffees.bags_hint")}</span>`}</div>
      ${bags.length ? `<table><thead><tr><th>${t("setup.roast_date")}</th><th class="r">${t("coffees.opened")}</th><th class="r">${t("coffees.shots")}</th><th class="r">${t("coffees.used")}</th><th class="r">${t("coffees.remaining")}</th><th class="r">${t("coffees.per_day")}</th><th class="r">${t("coffees.days_left")}</th></tr></thead><tbody>${bags.map(bagRow).join("")}</tbody></table>` : `<p class="empty">${t("coffees.no_periods")}</p>`}
    </section>
    <div class="cols">
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("coffees.details")}</h2></div>
          ${form(c, t("coffees.save"))}
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("coffees.periods")}</h2></div>
          ${setups.length ? `<div class="timeline">${setups.map((s) => `
            <div class="tl-item">
              <div class="when">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</div>
              <div class="row"><span class="pill num">${t("now.grind")} ${s.grind_setting ?? "–"}</span><span class="pill num">${s.dose_g ?? "–"} g</span>${s.roast_date ? `<span class="faint small">${t("setup.roast_date").toLowerCase()} ${s.roast_date}</span>` : ""}${s.note ? `<span class="faint small">${s.note}</span>` : ""}</div>
            </div>`).join("")}</div>` : `<p class="empty">${t("coffees.no_periods")}</p>`}
        </section>
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("coffees.recent")}</h2></div>
          <div class="list">${shots.length ? shots.slice(0, 30).map(shotRow).join("") : `<p class="empty">${t("history.empty")}</p>`}</div>
        </section>
      </div>
    </div>`;
  const cleanups = [];
  if (aging.length >= 3) {
    // Colour by grind, so a grind change does not read as the coffee aging.
    const grinds = [...new Set(aging.map((p) => p.grind_setting ?? "?"))];
    const groups = aging.map((p) => grinds.indexOf(p.grind_setting ?? "?"));
    const labels = Object.fromEntries(grinds.map((g, i) => [i, `${t("now.grind")} ${g}`]));
    const days = aging.map((p) => Math.round(p.days * 10) / 10);
    cleanups.push(scatterChart(view.querySelector("#age-time"), days, aging.map((p) => p.seconds), groups, labels, { xLabel: t("coffees.days_since_roast"), yLabel: "s" }));
    const withRatio = aging.filter((p) => p.ratio != null);
    cleanups.push(scatterChart(view.querySelector("#age-ratio"), withRatio.map((p) => Math.round(p.days * 10) / 10), withRatio.map((p) => p.ratio), withRatio.map((p) => grinds.indexOf(p.grind_setting ?? "?")), labels, { xLabel: t("coffees.days_since_roast"), yLabel: "1:x" }));
  }
  const f = view.querySelector("#cf");
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (await submitCoffee(f, (input) => api.updateCoffee(c.id, input))) renderDetail(view, id);
  };
  view.querySelector("#archive").onclick = async () => {
    await api.updateCoffee(c.id, { archived: !c.archived });
    renderDetail(view, id);
  };
  const use = view.querySelector("#use");
  if (use) use.onclick = async () => {
    await api.recordSetup({ coffee_id: c.id });
    toast(t("coffees.now_in_use", { name: c.name }));
    renderDetail(view, id);
  };

  return () => cleanups.forEach((fn) => fn && fn());
}

export async function renderCoffees(view, [id]) {
  if (id) return renderDetail(view, Number(id));
  return renderList(view);
}
