import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt } from "../lib/fmt.js";
import { scatterChart } from "../lib/charts.js";

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
    <section class="card"><div class="card-head"><h2>${t("stats.ratio_time")}</h2><span class="faint small">${t("stats.ratio_time_hint")}</span></div><div class="chart" id="c1"></div></section>
    <section class="card"><div class="card-head"><h2>${t("stats.settledness")}</h2><span class="faint small">${t("stats.settledness_hint")}</span></div><div class="chart" id="c2"></div></section>`}
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
  return () => cleanups.forEach((c) => c && c());
}
