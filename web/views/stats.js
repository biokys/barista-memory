import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt } from "../lib/fmt.js";
import { scatterChart, bandChart, fitChart, controlChart, colors } from "../lib/charts.js";

export async function renderStats(view) {
  const s = await api.stats();
  const tot = s.totals;
  const beans = [...new Set(s.points.map((p) => p.bean ?? "?"))];
  const groups = s.points.map((p) => beans.indexOf(p.bean ?? "?"));
  const labels = Object.fromEntries(beans.map((b, i) => [i, b]));
  view.innerHTML = `
    <h1>${t("stats.title")}</h1>
    <div class="grid cols-3">
      <div class="card stat"><span class="v num">${tot.shots}</span><span class="l">${t("stats.shots")}</span></div>
      <div class="card stat"><span class="v num">${tot.beans}</span><span class="l">${t("stats.beans")}</span></div>
      <div class="card stat"><span class="v num">${tot.since ? fmt.date(tot.since) : "–"}</span><span class="l">${t("stats.since")}</span></div>
      <div class="card stat"><span class="v num">${tot.weight_from_curve}</span><span class="l">${t("stats.weight_fixed")}</span></div>
    </div>
    ${s.points.length < 3 ? `<p class="empty">${t("stats.empty")}</p>` : `
    <section class="card"><div class="card-head"><h2>${t("stats.ratio_time")}</h2><span class="faint small">${t("stats.ratio_time_hint")}</span></div><div class="chart chart-stat" id="c1"></div></section>
    <section class="card"><div class="card-head"><h2>${t("stats.settledness")}</h2><span class="faint small">${t("stats.settledness_hint")}</span></div><div class="chart chart-stat" id="c2"></div></section>`}
    <section class="card"><div class="card-head"><h2>${t("stats.control")}</h2><span class="faint small">${t("stats.control_hint")}</span></div>
      ${s.control.segments.some((g) => g.seconds) ? `
      <div class="row spread" style="margin-bottom:8px"><div class="seg" id="spc-metric"><button data-m="seconds" class="active">${t("stats.m.seconds")}</button><button data-m="ratio">${t("stats.m.ratio")}</button></div></div>
      <div class="chart chart-stat" id="c5"></div>
      <div class="small muted" id="spc-note" style="margin-top:8px"></div>` : `<p class="empty">${t("stats.control_short")}</p>`}
    </section>
    <section class="card"><div class="card-head"><h2>${t("stats.reference")}</h2><span class="faint small">${t("stats.reference_hint")}</span></div>
      ${s.reference.length ? `
      <div class="row spread" style="margin-bottom:8px">
        <select id="ref-group" class="btn sm">${s.reference.map((g, i) => `<option value="${i}">${g.bean} · ${g.grind_setting} (n ${g.n})</option>`).join("")}</select>
        <div class="seg" id="ref-q"><button data-q="pressure" class="active">${t("stats.q.pressure")}</button><button data-q="flow">${t("stats.q.flow")}</button><button data-q="weight">${t("stats.q.weight")}</button></div>
      </div>
      <div class="chart chart-stat" id="c3"></div>
      <p class="small muted" id="ref-note" style="margin-top:8px"></p>` : `<p class="empty">${t("stats.reference_short")}</p>`}
    </section>
    <section class="card"><div class="card-head"><h2>${t("stats.ageing")}</h2><span class="faint small">${t("stats.ageing_hint")}</span></div>
      ${s.ageing.length ? s.ageing.map((a, i) => `
        <div class="row spread" style="margin-top:${i ? 14 : 0}px"><b>${a.bean}</b><span class="faint small">${a.roast_date ? t("stats.ageing_since_roast", { date: a.roast_date }) : t("stats.ageing_since_first")}</span></div>
        <div class="chart chart-stat" id="age-${i}"></div>
        <div class="small muted" style="margin-top:8px">${a.fits.length ? a.fits.map((f) => t("stats.ageing_fit", { grind: f.grind_setting, slope: (f.slope >= 0 ? "+" : "") + f.slope.toFixed(2), se: f.slope_se.toFixed(2), r2: f.r2.toFixed(2), n: f.n, days: f.days })).join("<br>") : t("stats.ageing_short")}</div>`).join("") : `<p class="empty">${t("stats.ageing_short")}</p>`}
    </section>
    ${s.perEra?.length ? `<section class="card"><div class="card-head"><h2>${t("stats.per_era")}</h2><span class="faint small">${t("stats.per_era_hint")}</span></div>
      <table><thead><tr><th>${t("stats.col.era")}</th><th class="r">${t("stats.col.shots")}</th><th class="r">${t("stats.col.ratio")}</th><th class="r">${t("stats.col.seconds")}</th><th class="r">${t("stats.col.rating")}</th></tr></thead>
      <tbody>${s.perEra.map((e) => `<tr><td><span class="pill accent">${t("events.kind." + e.kind)}</span> ${e.title}<br><span class="faint small">${fmt.dateTime(e.at)}</span></td><td class="r num">${e.shots}</td><td class="r num">${e.avg_ratio != null ? "1:" + e.avg_ratio.toFixed(2) : "–"}</td><td class="r num">${e.avg_seconds ?? "–"} s</td><td class="r num">${e.avg_rating ?? "–"}</td></tr>`).join("")}</tbody></table></section>` : ""}
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>${t("stats.per_bean")}</h2></div>
        <table><thead><tr><th>${t("stats.col.bean")}</th><th class="r">${t("stats.col.shots")}</th><th class="r">${t("stats.col.ratio")}</th><th class="r">${t("stats.col.seconds")}</th><th class="r">${t("stats.col.rating")}</th></tr></thead>
        <tbody>${s.perBean.map((b) => `<tr><td>${b.bean || "–"}<br><span class="faint small">${b.roaster || ""} · ${fmt.date(b.first_at)}–${fmt.date(b.last_at)}</span></td><td class="r num">${b.shots}</td><td class="r num">${b.avg_ratio != null ? "1:" + b.avg_ratio.toFixed(2) : "–"}</td><td class="r num">${b.avg_seconds ?? "–"} s</td><td class="r num">${b.avg_rating ?? "–"}</td></tr>`).join("")}</tbody></table>
      </section>
      <section class="card"><div class="card-head"><h2>${t("stats.consistency")}</h2><span class="faint small">${t("stats.consistency_hint")}</span></div>
        ${s.consistency.length ? `<table><thead><tr><th>${t("stats.col.bean")}</th><th class="r">${t("stats.col.grind")}</th><th class="r">${t("stats.col.shots")}</th><th class="r">${t("stats.col.seconds")}</th><th class="r">${t("stats.col.sd")}</th></tr></thead>
        <tbody>${s.consistency.map((c) => `<tr><td>${c.bean}</td><td class="r num">${c.grind_setting}</td><td class="r num">${c.n}</td><td class="r num">${c.mean_s} s</td><td class="r num">${c.sd_s} s</td></tr>`).join("")}</tbody></table>` : `<p class="empty">${t("stats.empty")}</p>`}
      </section>
    </div>`;
  const cleanups = [];
  if (s.points.length >= 3) {
    cleanups.push(scatterChart(view.querySelector("#c1"), s.points.map((p) => p.started_at), s.points.map((p) => p.seconds), groups, labels, { time: true, yLabel: "s" }));
    const withWarm = s.points.filter((p) => p.settledness != null);
    if (withWarm.length >= 2) {
      cleanups.push(scatterChart(view.querySelector("#c2"), withWarm.map((p) => p.settledness), withWarm.map((p) => p.seconds), withWarm.map((p) => beans.indexOf(p.bean ?? "?")), labels, { xLabel: "%", yLabel: "s" }));
    } else view.querySelector("#c2").innerHTML = `<p class="empty">${t("stats.settledness_hint")}</p>`;
  }

  // Control chart: one metric at a time, the stretches' figures under it.
  if (s.control.segments.some((g) => g.seconds)) {
    let spc = null;
    const spcNote = view.querySelector("#spc-note");
    const drawSpc = (metric) => {
      spc?.();
      const unit = metric === "seconds" ? "s" : "";
      spc = controlChart(view.querySelector("#c5"), s.control.points, s.control.segments, metric, { unit, digits: metric === "seconds" ? 1 : 2, label: t("stats.m." + metric), dateOf: fmt.date });
      spcNote.innerHTML = s.control.segments.filter((g) => g[metric]).map((g) => t("stats.control_segment", {
        bean: g.bean, grind: g.grind_setting, center: g[metric].center.toFixed(metric === "seconds" ? 1 : 2), sigma: g[metric].sigma.toFixed(metric === "seconds" ? 1 : 2), unit, cv: g[metric].cv_pct.toFixed(0), out: g[metric].outside, n: g.n,
      })).join("<br>");
    };
    drawSpc("seconds");
    view.querySelector("#spc-metric").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      view.querySelectorAll("#spc-metric button").forEach((x) => x.classList.toggle("active", x === b));
      drawSpc(b.dataset.m);
    };
    cleanups.push(() => spc?.());
  }

  // Reference curve: a group and a quantity at a time.
  if (s.reference.length) {
    const UNITS = { pressure: "bar", flow: "ml/s", weight: "g" };
    let ref = null, group = 0, quantity = "pressure";
    const refNote = view.querySelector("#ref-note");
    const drawRef = () => {
      ref?.();
      const g = s.reference[group];
      const c = colors();
      const xs = g[quantity].median.map((_, i) => i * g.step_s);
      ref = bandChart(view.querySelector("#c3"), xs, g[quantity], g.latest[quantity], { color: c[quantity === "pressure" ? "pressure" : quantity], unit: UNITS[quantity], medianLabel: t("stats.reference_median"), latestLabel: `#${g.latest_id}`, digits: quantity === "flow" ? 2 : 1 });
      refNote.textContent = t("stats.reference_note", { n: g.n, id: g.latest_id, date: fmt.date(g.latest_at) });
    };
    drawRef();
    view.querySelector("#ref-group").onchange = (e) => { group = Number(e.target.value); drawRef(); };
    view.querySelector("#ref-q").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      view.querySelectorAll("#ref-q button").forEach((x) => x.classList.toggle("active", x === b));
      quantity = b.dataset.q; drawRef();
    };
    cleanups.push(() => ref?.());
  }

  // Ageing: one chart per bag, points by grind, a fitted line where there is enough.
  s.ageing.forEach((a, i) => {
    const c = colors();
    const palette = [c.accent, c.flow, c.weight, c.temp, "#c9a0dc", "#8fb8a8"];
    const grinds = [...new Set(a.points.map((p) => p.grind_setting))].sort((x, y) => x - y);
    const groupsOf = grinds.map((grind, gi) => {
      const pts = a.points.filter((p) => p.grind_setting === grind);
      return { label: `${t("stats.col.grind")} ${grind}`, color: palette[gi % palette.length], xs: pts.map((p) => p.days), ys: pts.map((p) => p.seconds), fit: a.fits.find((f) => f.grind_setting === grind) ?? null };
    });
    cleanups.push(fitChart(view.querySelector(`#age-${i}`), groupsOf, { xLabel: t("stats.ageing_days"), yLabel: "s", unit: "s" }));
  });

  return () => cleanups.forEach((c) => c && c());
}
