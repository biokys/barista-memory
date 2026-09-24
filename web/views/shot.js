import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast, verdictText, verdictTone } from "../lib/fmt.js";
import { shotChart } from "../lib/charts.js";

function declineEnd(shot) {
  const d = (shot.phases || []).find((p) => p.name === "Decline");
  if (!d || !shot.full_curve) return null;
  const end = d.start_time_seconds + d.duration_seconds;
  const inPhase = shot.full_curve.filter((s) => s.time_seconds >= d.start_time_seconds && s.time_seconds <= end).map((s) => s.pressure_bar);
  return inPhase.length ? Math.min(...inPhase) : null;
}

/**
 * The two shots' facts side by side — context, cup, curve summary and the
 * machine's state — with the difference where a number makes one. The
 * chart shows *that* they differ; this says *in what*.
 */
function compareTable(a, b) {
  const num = (v, d = 1) => (v == null ? null : Number(v.toFixed(d)));
  const rows = [
    [t("shot.bean"), (x) => [x.context.bean ? `${x.context.bean}${x.context.roaster ? " · " + x.context.roaster : ""}` : "–"]],
    [t("shot.profile"), (x) => [x.context.profile_name ?? "–"]],
    [t("shot.grind"), (x) => [x.context.grind_setting ?? "–", Number(x.context.grind_setting)]],
    [t("shot.dose"), (x) => [x.context.dose_g != null ? x.context.dose_g + " g" : "–", x.context.dose_g]],
    [t("shot.cup"), (x) => [fmt.g(x.context.stable_weight_g), num(x.context.stable_weight_g)]],
    [t("shot.ratio"), (x) => [fmt.ratio(x.context.ratio), num(x.context.ratio, 2)]],
    [t("shot.time"), (x) => [fmt.seconds(x.context.duration_ms / 1000), num(x.context.duration_ms / 1000)]],
    [t("shot.preinfusion"), (x) => [x.shot ? x.shot.summary.extraction.preinfusion_time_seconds.toFixed(0) + " s" : "–", x.shot ? num(x.shot.summary.extraction.preinfusion_time_seconds, 0) : null]],
    [t("shot.temp"), (x) => [x.shot ? fmt.temp(x.shot.summary.temperature.average_celsius) : "–", x.shot ? num(x.shot.summary.temperature.average_celsius) : null]],
    [t("machine.target"), (x) => [x.shot?.summary.temperature.target_average ? x.shot.summary.temperature.target_average.toFixed(0) + " °C" : "–", x.shot ? num(x.shot.summary.temperature.target_average, 0) : null]],
    [t("shot.peak"), (x) => [x.shot ? fmt.bar(x.shot.summary.pressure.max_bar) : "–", x.shot ? num(x.shot.summary.pressure.max_bar) : null]],
    [t("shot.avg_flow"), (x) => [x.shot ? x.shot.summary.flow.average_flow_rate_ml_s.toFixed(2) + " ml/s" : "–", x.shot ? num(x.shot.summary.flow.average_flow_rate_ml_s, 2) : null]],
    [t("shot.machine"), (x) => [x.machine ? fmt.pct(x.machine.settledness) : "–", x.machine?.settledness ?? null]],
    [t("machine.heating_for"), (x) => [x.machine ? fmt.duration(x.machine.heating_for_s) : "–", x.machine?.heating_for_s != null ? num(x.machine.heating_for_s / 60, 0) : null]],
    [t("shot.rating"), (x) => [x.context.rating ? "★".repeat(x.context.rating) : "–", x.context.rating ?? null]],
    [t("anomaly.title"), (x) => [(x.analysis?.flags || []).map((f) => t("anomaly." + f)).join(", ") || (x.analysis ? t("anomaly.none") : "–")]],
    [t("dialin.next"), (x) => [verdictText(x.verdict) || "–"]],
  ];
  const delta = (va, vb) => {
    if (va == null || vb == null || !Number.isFinite(va) || !Number.isFinite(vb) || va === vb) return "";
    const d = va - vb;
    // No colour: a shorter time or a lower peak is not better or worse by itself.
    return `${d > 0 ? "+" : "−"}${Math.abs(Math.round(d * 100) / 100)}`;
  };
  return `
    <table class="cmp" style="margin-top:16px">
      <thead><tr><th></th><th class="r">#${a.context.id}</th><th class="r">#${b.context.id}</th><th class="r">${t("shot.compare_delta")}</th></tr></thead>
      <tbody>${rows.map(([label, get]) => {
        const [ta, va] = get(a), [tb, vb] = get(b);
        const same = ta === tb;
        // Some labels are lowercase because they sit mid-sentence elsewhere.
        return `<tr class="${same ? "faint" : ""}"><td>${label.charAt(0).toUpperCase() + label.slice(1)}</td><td class="r num">${ta}</td><td class="r num">${tb}</td><td class="r num">${delta(va, vb)}</td></tr>`;
      }).join("")}</tbody>
    </table>`;
}

export async function renderShot(view, [id]) {
  let data;
  try {
    data = await api.shot(id);
  } catch (err) {
    view.innerHTML = `
      <div class="card" style="text-align:center;padding:48px 24px">
        <h1>${t("shot.missing_title", { id })}</h1>
        <p class="muted" style="margin-top:8px">${t("shot.missing_hint")}</p>
        <p style="margin-top:20px"><a class="btn" href="#/shots">${t("nav.history")}</a></p>
      </div>`;
    return;
  }
  const { context: c, machine: m, shot } = data;
  const readiness = m?.settledness == null ? null : m.settledness >= 85 ? "ok" : m.settledness >= 60 ? "warn" : "bad";
  const peak = shot?.summary?.pressure?.max_bar;
  const dec = shot ? declineEnd(shot) : null;
  const weightNote = c.stable_weight_source === "curve" ? t("shot.weight_curve") : c.stable_weight_source === "none" ? t("shot.weight_none") : t("shot.weight_recorded");
  const phaseBar = (shot?.phases || []).map((p) => `<i style="flex:${p.duration_seconds}" title="${p.name} ${p.duration_seconds.toFixed(1)} s"></i>`).join("");

  view.innerHTML = `
    <div class="row spread">
      <div>
        <h1>${t("shot.title", { id: c.id })}</h1>
        <p class="muted">${fmt.dateLong(c.started_at)} · ${fmt.time(c.started_at)} · ${c.profile_name ?? ""}</p>
      </div>
      <div class="row">
        <a class="btn sm ghost" href="api/shots/${c.id}/receipt.png" target="_blank" rel="noopener">${t("shot.receipt")}</a>
        <button class="btn sm ghost" id="print">${t("shot.print")}</button>
        ${data.prev_id ? `<a class="btn sm ghost" href="#/shots/${data.prev_id}">← ${t("shot.prev")}</a>` : ""}
        ${data.next_id ? `<a class="btn sm ghost" href="#/shots/${data.next_id}">${t("shot.next")} →</a>` : ""}
      </div>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>${t("shot.curve")}</h2>
        <label class="row small muted">${t("shot.compare")} <select id="cmp" class="btn sm"><option value="">${t("shot.compare_none")}</option></select></label>
      </div>
      <div class="chart chart-shot" id="chart"></div>
      ${shot ? `<div class="phase-bar" style="margin-top:14px">${phaseBar}</div>
      <div class="row small faint" style="margin-top:6px;gap:18px">${(shot.phases || []).map((p) => `<span>${t("shot.phase." + p.name) || p.name} <b class="num muted">${p.duration_seconds.toFixed(1)} s</b> · ${p.avg_pressure_bar.toFixed(1)} bar · ${p.avg_temperature_c.toFixed(1)}°</span>`).join("")}</div>` : ""}
      <div id="cmp-table"></div>
    </section>

    <div class="grid cols-2">
      <section class="card">
        <div class="card-head"><h2>${t("shot.facts")}</h2></div>
        <dl class="kv">
          <dt>${t("shot.bean")}</dt><dd>${c.bean ?? "–"}${c.roaster ? ` <span class="muted">· ${c.roaster}</span>` : ""}</dd>
          <dt>${t("shot.grind")}</dt><dd class="num">${c.grind_setting ?? "–"} <span class="muted">· ${t("shot.dose").toLowerCase()} ${c.dose_g ?? "–"} g</span></dd>
          <dt>${t("shot.cup")}</dt><dd class="num">${fmt.g(c.stable_weight_g)} <span class="muted">· ${t("shot.ratio").toLowerCase()} ${fmt.ratio(c.ratio)}</span><br><span class="faint small">${weightNote}</span></dd>
          <dt>${t("shot.time")}</dt><dd class="num">${fmt.seconds(c.duration_ms / 1000)}${shot ? ` <span class="muted">(${t("shot.preinfusion")} ${shot.summary.extraction.preinfusion_time_seconds.toFixed(0)} s)</span>` : ""}</dd>
          <dt>${t("shot.temp")}</dt><dd class="num">${shot ? fmt.temp(shot.summary.temperature.average_celsius) : "–"} <span class="muted">· ${t("machine.target")} ${shot?.summary.temperature.target_average ?? "–"}</span></dd>
          <dt>${t("shot.peak")}</dt><dd class="num">${fmt.bar(peak)}${dec != null ? ` <span class="muted">· ${t("shot.decline")} ${dec.toFixed(1)}</span>` : ""}</dd>
          <dt>${t("shot.era")}</dt><dd>${data.era ? `<span class="pill accent">${t("events.kind." + data.era.kind)}</span> ${t("shot.era_since", { title: data.era.title, n: data.era.shots_since })}` : `<span class="faint">${t("shot.era_none")}</span>`}</dd>
          <dt>${t("shot.machine")}</dt><dd>${m ? `<span class="num">${t("machine.heating_for")} ${fmt.duration(m.heating_for_s)}</span> <span class="pill ${readiness}">${fmt.pct(m.settledness)}</span>` : `<span class="faint">${t("machine.unknown")}</span>`}</dd>
          <dt>${t("anomaly.title")}</dt><dd>${(data.analysis?.flags || []).length ? data.analysis.flags.map((f) => `<span class="pill ${f === "off_pattern" ? "warn" : "bad"}" title="${t("anomaly.hint." + f)}">${t("anomaly." + f)}</span>`).join(" ") : `<span class="${data.analysis ? "ok" : "faint"}">${data.analysis ? t("anomaly.none") : t("anomaly.pending")}</span>`}${data.analysis?.deviation != null ? ` <span class="faint small num">${t("anomaly.deviation", { pct: Math.round(data.analysis.deviation * 100), n: data.analysis.baseline_shots })}</span>` : ""}</dd>
          <dt>${t("dialin.next")}</dt><dd>${verdictText(data.verdict) ? `<span class="pill ${verdictTone(data.verdict)}">${verdictText(data.verdict)}</span>` : `<span class="faint">${data.verdict?.coffee ? t("dialin.no_targets") : t("shot.era_none")}</span>`}</dd>
        </dl>
      </section>
      <section class="card">
        <div class="card-head"><h2>${t("shot.rating")}</h2></div>
        <div class="row" id="stars" style="font-size:1.8rem;gap:4px;cursor:pointer">${[1,2,3,4,5].map((n) => `<span data-n="${n}" style="color:${(c.rating ?? 0) >= n ? "var(--accent)" : "var(--line-2)"}">★</span>`).join("")}</div>
        <div class="field" style="margin-top:12px"><label>${t("shot.note")}</label><textarea id="note" rows="3" placeholder="${t("shot.note_placeholder")}">${c.taste_note ?? ""}</textarea></div>
        <div class="row" style="margin-top:10px"><button class="btn primary sm" id="save">${t("shot.save")}</button></div>
      </section>
    </div>`;

  let rating = c.rating ?? 0;
  const stars = view.querySelector("#stars");
  stars.onclick = (e) => {
    const n = Number(e.target.dataset.n); if (!n) return;
    rating = n === rating ? 0 : n;
    [...stars.children].forEach((el, i) => (el.style.color = rating > i ? "var(--accent)" : "var(--line-2)"));
  };
  view.querySelector("#save").onclick = async () => {
    await api.rate(c.id, rating || null, view.querySelector("#note").value || null);
    toast(t("shot.saved"));
  };

  let destroy = null;
  const container = view.querySelector("#chart");
  const draw = (compare) => { if (destroy) destroy(); destroy = shot ? shotChart(container, shot, compare, { stableWeight: c.stable_weight_g }) : null; };
  draw(null);

  // Comparison candidates: same bean if any, else the neighbours.
  const list = await api.shots({ limit: 40, ...(c.bean ? { bean: c.bean } : {}) });
  // Printing is paper and a minute of the printer's time, and the button sits
  // next to "Receipt" and "Previous" where a stray tap lands easily — so it
  // asks first, like the other actions that cannot be undone. While the job
  // runs the label says so; a bare greyed-out button read as "broken".
  view.querySelector("#print").onclick = async (e) => {
    if (!confirm(t("shot.print_confirm", { id: c.id }))) return;
    const button = e.currentTarget; const label = button.textContent;
    button.disabled = true; button.textContent = t("shot.printing");
    try { const r = await api.printShot(c.id); toast(r.completed ? t("printer.printed") : t("printer.printed_unconfirmed")); } catch (err) { toast(t("printer.failed") + " " + err.message, "bad"); }
    button.disabled = false; button.textContent = label;
  };
  const sel = view.querySelector("#cmp");
  const table = view.querySelector("#cmp-table");
  for (const s of list.shots) if (s.id !== c.id) sel.insertAdjacentHTML("beforeend", `<option value="${s.id}">#${s.id} · ${fmt.date(s.started_at)} · ${fmt.ratio(s.ratio)}</option>`);
  sel.onchange = async () => {
    if (!sel.value) { table.innerHTML = ""; return draw(null); }
    const other = await api.shot(sel.value);
    draw(other.shot);
    table.innerHTML = compareTable(data, other);
  };
  return () => destroy && destroy();
}
