// uPlot wrappers with the app's dark theme. uPlot is a global (IIFE build).
import { t } from "./i18n.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const colors = () => ({
  pressure: css("--pressure"), flow: css("--flow"), temp: css("--temp"), weight: css("--weight"),
  text: css("--text-2"), grid: css("--line"), faint: css("--text-3"), accent: css("--accent"),
});

function axis(extra = {}) {
  const c = colors();
  return {
    stroke: c.faint, grid: { stroke: c.grid, width: 1 }, ticks: { stroke: c.grid, width: 1, size: 4 },
    font: "11px " + css("--font"), labelFont: "11px " + css("--font"), gap: 6, ...extra,
  };
}

/**
 * A readout row under the plot instead of uPlot's legend.
 *
 * uPlot's live legend is empty until the cursor is over the chart, which
 * reads as broken. This one shows the values under the cursor while hovering
 * and each series' `idle` figure (a peak, a mean, a last value) otherwise, so
 * the row always says something.
 */
function readout(plot, container, meta) {
  const row = document.createElement("div");
  row.className = "readout";
  row.innerHTML = `<span class="x"></span>` + meta.map((m, i) =>
    `<span class="s" data-i="${i}"><em style="color:${m.color}">${m.name}</em><b></b><u>${m.label}</u></span>`).join("");
  container.appendChild(row);
  const cells = [...row.querySelectorAll(".s b")];
  const xCell = row.querySelector(".x");
  const idle = () => { xCell.textContent = ""; xCell.hidden = true; meta.forEach((m, i) => (cells[i].textContent = m.idle ?? "–")); };
  idle();
  plot.hooks.setCursor = plot.hooks.setCursor || [];
  plot.hooks.setCursor.push((u) => {
    const idx = u.cursor.idx;
    if (idx == null) return idle();
    xCell.textContent = meta[0].x ? meta[0].x(u.data[0][idx]) : ""; xCell.hidden = !xCell.textContent;
    meta.forEach((m, i) => { const v = u.data[m.series][idx]; cells[i].textContent = v == null ? "–" : m.fmt(v); });
  });
  return row;
}

/** Responsive: re-size on container width changes. Returns a cleanup fn. */
function responsive(plot, container) {
  const ro = new ResizeObserver(() => plot.setSize({ width: container.clientWidth, height: plot.height }));
  ro.observe(container);
  return () => { ro.disconnect(); plot.destroy(); container.querySelector(".readout")?.remove(); };
}

/** Extend the first and last non-null values to the ends of the series. */
function holdEdges(values) {
  const first = values.findIndex((v) => v != null);
  if (first < 0) return values;
  let last = values.length - 1;
  while (last > first && values[last] == null) last--;
  return values.map((v, i) => (i < first ? values[first] : i > last ? values[last] : v));
}

/**
 * Shot curves: pressure + flow on the left axis (bar / ml·s share a 0–12
 * range naturally), temperature on the right, weight on a third hidden scale.
 * Phases drawn as faint bands behind everything. `compare` overlays a second
 * shot's pressure and flow, dimmed.
 */
export function shotChart(container, shot, compare = null, { stableWeight = null } = {}) {
  const c = colors();
  const pts = shot.full_curve;
  const x = pts.map((p) => p.time_seconds);
  const data = [
    x,
    pts.map((p) => p.pressure_bar),
    pts.map((p) => p.flow_ml_s),
    pts.map((p) => p.temperature_c),
    // Cleaned weight: null before the self-tare and where the scale glitched,
    // so the green line neither starts at 180 g nor dives when the cup is lifted.
    // The edges are held out to the ends of the shot — the first good reading
    // back to 0 s, the last one to the cut-off — so the line does not simply
    // stop short; interior gaps are spanned by the series itself.
    holdEdges(pts.map((p) => (p.weight_clean_g === undefined ? p.weight_g : p.weight_clean_g))),
  ];
  const series = [
    {},
    { label: "bar", stroke: c.pressure, width: 2, scale: "y", value: (u, v) => (v == null ? "" : v.toFixed(1)) },
    { label: "ml/s", stroke: c.flow, width: 1.5, dash: [5, 4], scale: "y", value: (u, v) => (v == null ? "" : v.toFixed(2)) },
    { label: "°C", stroke: c.temp, width: 1.5, scale: "t", value: (u, v) => (v == null ? "" : v.toFixed(1)) },
    { label: "g", stroke: c.weight, width: 1.5, scale: "w", spanGaps: true, value: (u, v) => (v == null ? "" : v.toFixed(1)) },
  ];
  if (compare?.full_curve) {
    // Comparison is resampled onto this shot's time axis by nearest neighbour.
    const cx = compare.full_curve.map((p) => p.time_seconds);
    const pick = (key) => x.map((t) => {
      let lo = 0, hi = cx.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cx[mid] < t) lo = mid + 1; else hi = mid; }
      return t > cx[cx.length - 1] + 0.5 ? null : compare.full_curve[lo][key];
    });
    data.push(pick("pressure_bar"), pick("flow_ml_s"));
    series.push(
      { label: "bar ⁽²⁾", stroke: c.pressure, width: 1.5, alpha: 0.4, scale: "y", value: (u, v) => (v == null ? "" : v.toFixed(1)) },
      { label: "ml/s ⁽²⁾", stroke: c.flow, width: 1, dash: [3, 4], alpha: 0.4, scale: "y", value: (u, v) => (v == null ? "" : v.toFixed(2)) },
    );
  }

  const phases = shot.phases || [];
  const bandColors = ["#4d6b8a", "#5c7b57", "#8a6a3a", c.accent, "#a06a4e"];

  const plot = new uPlot({
    width: container.clientWidth, height: 300,
    cursor: { drag: { x: true, y: false } },
    legend: { show: false },
    scales: { x: { time: false }, y: { range: [0, 12] }, t: { range: (u, min, max) => [Math.floor(Math.min(min, 88) - 1), Math.ceil(Math.max(max, 96) + 1)] }, w: { range: [0, Math.max(50, ...data[4].filter((v) => v != null)) * 1.05] } },
    axes: [
      axis({ scale: "x", values: (u, v) => v.map((n) => n + " s") }),
      axis({ scale: "y", side: 3, values: (u, v) => v.map((n) => n) }),
      axis({ scale: "t", side: 1, grid: { show: false }, values: (u, v) => v.map((n) => n + "°") }),
    ],
    series,
    hooks: {
      drawClear: [(u) => {
        const ctx = u.ctx; ctx.save();
        phases.forEach((ph, i) => {
          const x0 = u.valToPos(ph.start_time_seconds, "x", true);
          const x1 = u.valToPos(ph.start_time_seconds + ph.duration_seconds, "x", true);
          ctx.fillStyle = bandColors[i % bandColors.length]; ctx.globalAlpha = 0.09;
          ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
          ctx.globalAlpha = 0.5; ctx.fillStyle = c.faint; ctx.font = "10px " + css("--font");
          ctx.fillText(ph.name, x0 + 4, u.bbox.top + 12);
        });
        ctx.restore();
      }],
    },
  }, data, container);
  const sm = shot.summary || {};
  // Idle figures: peak pressure, mean flow and temperature, and the shot's
  // stable weight — not the curve's maximum, which on a self-taring scale is
  // the pre-tare reading from the first second (181.8 g on shot 415).
  const meta = [
    { series: 1, name: t("shot.pressure"), label: "bar", color: c.pressure, fmt: (v) => v.toFixed(1), idle: sm.pressure ? `⌃ ${sm.pressure.max_bar.toFixed(1)}` : "–", x: (x) => `${x.toFixed(1)} s` },
    { series: 2, name: t("shot.flow"), label: "ml/s", color: c.flow, fmt: (v) => v.toFixed(2), idle: sm.flow ? `⌀ ${sm.flow.average_flow_rate_ml_s.toFixed(2)}` : "–" },
    { series: 3, name: t("shot.temperature"), label: "°C", color: c.temp, fmt: (v) => v.toFixed(1), idle: sm.temperature ? `⌀ ${sm.temperature.average_celsius.toFixed(1)}` : "–" },
    { series: 4, name: t("shot.weight"), label: "g", color: c.weight, fmt: (v) => v.toFixed(1), idle: stableWeight != null ? `→ ${stableWeight.toFixed(1)}` : "–" },
  ];
  if (compare?.full_curve) meta.push(
    { series: 5, name: t("shot.pressure") + " ⁽²⁾", label: "bar", color: c.pressure, fmt: (v) => v.toFixed(1), idle: "" },
    { series: 6, name: t("shot.flow") + " ⁽²⁾", label: "ml/s", color: c.flow, fmt: (v) => v.toFixed(2), idle: "" });
  readout(plot, container, meta);
  return responsive(plot, container);
}

/**
 * Boiler temperature over hours: current temp, target as a faint step,
 * unreachable stretches as grey bands, shots as amber ticks.
 */
export function machineChart(container, samples, shots, sessions, events = []) {
  const c = colors();
  const x = samples.map((s) => s.sampled_at);
  const data = [
    x,
    samples.map((s) => (s.reachable ? s.current_temp : null)),
    samples.map((s) => (s.reachable && s.target_temp > 0 ? s.target_temp : null)),
    // The modelled body temperature is defined while the machine is off too
    // (it is cooling), so it is the one line that crosses the grey bands.
    samples.map((s) => s.mass_temp ?? null),
    samples.map((s) => s.settledness ?? null),
  ];
  const plot = new uPlot({
    width: container.clientWidth, height: 280,
    cursor: { drag: { x: true, y: false } },
    legend: { show: false },
    scales: { x: { time: true }, y: { range: [15, 105] }, pct: { range: [0, 100] } },
    axes: [
      axis({ scale: "x" }),
      axis({ scale: "y", values: (u, v) => v.map((n) => n + "°") }),
    ],
    series: [
      { value: "{HH}:{mm}" },
      { label: "°C", stroke: c.temp, width: 2, spanGaps: false, value: (u, v) => (v == null ? "–" : v.toFixed(1)) },
      { label: "target", stroke: c.faint, width: 1, dash: [3, 4], spanGaps: false, value: (u, v) => (v == null ? "–" : v) },
      // No point markers: the body temperature is a model evaluated at the
      // sample times, not a measurement, and dots would say otherwise.
      { label: "body", stroke: c.accent, width: 1.5, dash: [6, 4], spanGaps: true, points: { show: false }, value: (u, v) => (v == null ? "–" : v.toFixed(1)) },
      { label: "warm-up", show: false, scale: "pct" },
    ],
    hooks: {
      drawClear: [(u) => {
        const ctx = u.ctx; ctx.save();
        // Off periods: between a session's end and the next start.
        const sorted = [...sessions].sort((a, b) => a.started_at - b.started_at);
        for (let i = 0; i < sorted.length; i++) {
          const end = sorted[i].ended_at; const next = sorted[i + 1]?.started_at;
          if (end && next) {
            ctx.fillStyle = c.faint; ctx.globalAlpha = 0.08;
            ctx.fillRect(u.valToPos(end, "x", true), u.bbox.top, u.valToPos(next, "x", true) - u.valToPos(end, "x", true), u.bbox.height);
          }
        }
        for (const e of events) {
          const px = u.valToPos(e.at, "x", true);
          ctx.globalAlpha = 0.7; ctx.strokeStyle = c.flow; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(px, u.bbox.top); ctx.lineTo(px, u.bbox.top + u.bbox.height); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = c.flow; ctx.font = "10px " + css("--font"); ctx.fillText(e.title, px + 4, u.bbox.top + 12);
        }
        ctx.globalAlpha = 0.9;
        for (const s of shots) {
          const px = u.valToPos(s.started_at, "x", true);
          ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px, u.bbox.top); ctx.lineTo(px, u.bbox.top + u.bbox.height); ctx.stroke();
        }
        ctx.restore();
      }],
    },
  }, data, container);
  const last = [...samples].reverse().find((s) => s.reachable && s.current_temp != null);
  const lastMass = [...samples].reverse().find((s) => s.mass_temp != null);
  readout(plot, container, [
    { series: 1, name: t("shot.temperature"), label: "°C", color: c.temp, fmt: (v) => v.toFixed(1), idle: last ? `${last.current_temp.toFixed(1)}` : "–", x: (x) => new Date(x * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
    { series: 2, name: t("machine.target"), label: "°C", color: c.faint, fmt: (v) => String(v), idle: last && last.target_temp > 0 ? String(last.target_temp) : "–" },
    { series: 3, name: t("machine.body"), label: "°C", color: c.accent, fmt: (v) => v.toFixed(1), idle: lastMass?.mass_temp != null ? lastMass.mass_temp.toFixed(1) : "–" },
    { series: 4, name: t("machine.settledness"), label: "%", color: c.accent, fmt: (v) => String(v), idle: lastMass?.settledness != null ? String(lastMass.settledness) : "–" },
  ]);
  return responsive(plot, container);
}

/** Scatter: x values, y values, per-point colour group index. */
export function scatterChart(container, xs, ys, groups, labels, { xLabel, yLabel, time = false, yRange } = {}) {
  const c = colors();
  const palette = [c.accent, c.flow, c.weight, c.temp, "#c9a0dc", "#8fb8a8"];
  const uniq = [...new Set(groups)];
  const series = [{}];
  const data = [xs];
  for (const g of uniq) {
    data.push(ys.map((y, i) => (groups[i] === g ? y : null)));
    series.push({ label: labels?.[g] ?? String(g), stroke: palette[uniq.indexOf(g) % palette.length], paths: uPlot.paths.points({ size: 7 }), points: { show: true, size: 7 }, value: (u, v) => (v == null ? "" : v) });
  }
  const plot = new uPlot({
    width: container.clientWidth, height: 260,
    cursor: { drag: { x: false, y: false } },
    legend: { show: false },
    scales: { x: { time }, y: yRange ? { range: yRange } : {} },
    axes: [axis({ scale: "x", label: xLabel }), axis({ scale: "y", label: yLabel })],
    series,
  }, data, container);
  const row = document.createElement("div"); row.className = "readout";
  row.innerHTML = uniq.map((g, i) => `<span class="s"><em style="color:${palette[i % palette.length]}">${labels?.[g] ?? g}</em></span>`).join("");
  container.appendChild(row);
  return responsive(plot, container);
}
