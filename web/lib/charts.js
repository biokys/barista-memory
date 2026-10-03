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
 *
 * A series with a `dev` also shows, while hovering, how far it is from its
 * setpoint at that instant — only where the machine was controlling on that
 * quantity (the setpoint is null otherwise), coloured by `dev.ok` / `dev.warn`.
 */
function readout(plot, container, meta) {
  const row = document.createElement("div");
  row.className = "readout";
  row.innerHTML = `<span class="x"></span>` + meta.map((m, i) =>
    `<span class="s" data-i="${i}"><em style="color:${m.color}">${m.name}</em><b></b><u>${m.label}</u><i class="dev"></i></span>`).join("");
  container.appendChild(row);
  const cells = [...row.querySelectorAll(".s b")];
  const devs = [...row.querySelectorAll(".s .dev")];
  const xCell = row.querySelector(".x");
  const clearDev = (i) => { devs[i].textContent = ""; devs[i].className = "dev"; };
  const idle = () => { xCell.textContent = ""; xCell.hidden = true; meta.forEach((m, i) => { cells[i].textContent = m.idle ?? "–"; clearDev(i); }); };
  idle();
  plot.hooks.setCursor = plot.hooks.setCursor || [];
  plot.hooks.setCursor.push((u) => {
    const idx = u.cursor.idx;
    if (idx == null) return idle();
    xCell.textContent = meta[0].x ? meta[0].x(u.data[0][idx]) : ""; xCell.hidden = !xCell.textContent;
    // `alt`: the same quantity drawn as a second series (the tail after the extraction).
    meta.forEach((m, i) => {
      const v = u.data[m.series][idx] ?? (m.alt != null ? u.data[m.alt][idx] : null);
      cells[i].textContent = v == null ? "–" : m.fmt(v);
      const actual = m.dev ? m.dev.actual?.[idx] ?? v : null;
      const target = m.dev?.target[idx];
      if (actual == null || target == null) return clearDev(i);
      const d = actual - target, a = Math.abs(d), r = Number(d.toFixed(m.dev.digits));
      devs[i].textContent = `${r === 0 ? "±" : r > 0 ? "+" : "−"}${Math.abs(r).toFixed(m.dev.digits)}`;
      devs[i].className = `dev ${a <= m.dev.ok ? "ok" : a <= m.dev.warn ? "warn" : "bad"}`;
      devs[i].title = `${t("machine.target")} ${target.toFixed(m.dev.digits)} ${m.label}`;
    });
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
 * shot's pressure and flow, dimmed. `targets` adds what the machine was asked
 * for at each moment, dotted: pressure, temperature, and flow — which is a
 * pump flow target, so the pump's own flow comes with it; the puck flow drawn
 * by default lags it by the whole preinfusion.
 */
export function shotChart(container, shot, compare = null, { stableWeight = null, targets = false } = {}) {
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
  // Archives from before setpoints were exposed have no target fields at all.
  // Deviation from the setpoint, for the hover readout. Tolerances are what
  // reads as on target, a nudge, or a miss: a bar, a degree, a third of a
  // ml/s. The flow setpoint is for the pump, so it is judged on pump flow.
  const setpoint = {
    pressure: { target: pts.map((p) => p.target_pressure_bar ?? null), ok: 0.5, warn: 1.5, digits: 1 },
    temp: { target: pts.map((p) => p.target_temperature_c ?? null), ok: 1, warn: 2, digits: 1 },
    flow: { target: pts.map((p) => p.target_flow_ml_s ?? null), ok: 0.3, warn: 1, digits: 2 },
  };
  const targetMeta = [];
  if (targets && pts.some((p) => "target_pressure_bar" in p)) {
    // The setpoints themselves get no readout cell: the deviation shown beside
    // each measured value says the same, and three more cells crowded the row.
    const add = (values, style, meta = null) => {
      data.push(values);
      series.push({ width: 1.25, dash: [2, 3], value: (u, v) => (v == null ? "" : v.toFixed(1)), ...style });
      if (meta) targetMeta.push({ series: data.length - 1, idle: "", ...meta });
    };
    add(pts.map((p) => p.target_pressure_bar ?? null), { label: "bar ⁽ᵗ⁾", stroke: c.pressure, scale: "y" });
    add(pts.map((p) => p.target_flow_ml_s ?? null), { label: "ml/s ⁽ᵗ⁾", stroke: c.flow, scale: "y" });
    add(pts.map((p) => p.pump_flow_ml_s ?? null), { label: "ml/s ⁽ᵖ⁾", stroke: c.flow, scale: "y", dash: undefined, width: 1, alpha: 0.45 },
      { name: t("shot.pump_flow"), label: "ml/s", color: c.flow, fmt: (v) => v.toFixed(2), dev: setpoint.flow });
    add(pts.map((p) => p.target_temperature_c ?? null), { label: "°C ⁽ᵗ⁾", stroke: c.temp, scale: "t" });
  }

  // After the controller stops, the log runs on for 2–3 s with the pump off
  // and the valve closed; the pressure sensor reads the boiler climbing
  // towards the OPV, not the puck. That pressure is drawn on, but faint and
  // dashed, so it is not read as the shot; flow, temperature and weight are
  // still real (the cup still fills) and stay as they are. The boundary
  // sample belongs to both halves, so the line is continuous.
  const tails = {};
  const end = shot.metadata?.extraction_end_seconds;
  if (end != null && x.some((t) => t > end)) {
    const cut = x.findIndex((t) => t > end) - 1;
    const tailStyle = { width: 1.25, dash: [2, 4], alpha: 0.45 };
    for (const [i, key, scale, label] of [[1, "p", "y", "bar"]]) {
      const whole = data[i];
      data[i] = whole.map((v, k) => (k <= cut ? v : null));
      data.push(whole.map((v, k) => (k >= cut ? v : null)));
      series.push({ label: label + " ⁽…⁾", stroke: series[i].stroke, scale, value: series[i].value, ...tailStyle });
      tails[key] = data.length - 1;
    }
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
    { series: 1, alt: tails.p, name: t("shot.pressure"), label: "bar", color: c.pressure, fmt: (v) => v.toFixed(1), idle: sm.pressure ? `⌃ ${sm.pressure.max_bar.toFixed(1)}` : "–", x: (x) => `${x.toFixed(1)} s`, dev: setpoint.pressure },
    { series: 2, alt: tails.f, name: t("shot.flow"), label: "ml/s", color: c.flow, fmt: (v) => v.toFixed(2), idle: sm.flow ? `⌀ ${sm.flow.average_flow_rate_ml_s.toFixed(2)}` : "–" },
    { series: 3, alt: tails.t, name: t("shot.temperature"), label: "°C", color: c.temp, fmt: (v) => v.toFixed(1), idle: sm.temperature ? `⌀ ${sm.temperature.average_celsius.toFixed(1)}` : "–", dev: setpoint.temp },
    { series: 4, name: t("shot.weight"), label: "g", color: c.weight, fmt: (v) => v.toFixed(1), idle: stableWeight != null ? `→ ${stableWeight.toFixed(1)}` : "–" },
  ];
  if (compare?.full_curve) meta.push(
    { series: 5, name: t("shot.pressure") + " ⁽²⁾", label: "bar", color: c.pressure, fmt: (v) => v.toFixed(1), idle: "" },
    { series: 6, name: t("shot.flow") + " ⁽²⁾", label: "ml/s", color: c.flow, fmt: (v) => v.toFixed(2), idle: "" });
  meta.push(...targetMeta);
  readout(plot, container, meta);
  return responsive(plot, container);
}

/**
 * Boiler temperature over hours: current temp, target as a faint step,
 * unreachable stretches as grey bands, shots as amber ticks.
 */
/**
 * Measurements and the model on one x axis. Samples are stored on change,
 * so a machine holding its setpoint has one every ten minutes while the
 * modelled body is still climbing; the model therefore comes on its own
 * minute grid and the two are merged. Between two reachable samples the
 * sensor line is interpolated at grid times (a straight segment, exactly
 * what uPlot would draw anyway), so inserting points adds no gaps; across an
 * unreachable sample it stays a gap. Point markers are drawn only where a
 * real sample is.
 */
function mergeMachineSeries(samples, model) {
  const times = new Set(samples.map((s) => s.sampled_at));
  const x = [...new Set([...samples.map((s) => s.sampled_at), ...(model?.t ?? [])])].sort((a, b) => a - b);
  const byTime = new Map(samples.map((s) => [s.sampled_at, s]));
  const modelAt = new Map((model?.t ?? []).map((t, i) => [t, i]));
  const temp = [], target = [], mass = [], settled = [], real = [];
  let prev = null; let nextIdx = 0;
  for (const t of x) {
    const s = byTime.get(t);
    if (s) { prev = s; while (nextIdx < samples.length && samples[nextIdx].sampled_at <= t) nextIdx++; }
    const next = samples[nextIdx];
    if (s) {
      real.push(true);
      temp.push(s.reachable ? s.current_temp : null);
      target.push(s.reachable && s.target_temp > 0 ? s.target_temp : null);
    } else {
      real.push(false);
      const bridge = prev && next && prev.reachable && next.reachable;
      const f = bridge ? (t - prev.sampled_at) / (next.sampled_at - prev.sampled_at) : 0;
      temp.push(bridge ? prev.current_temp + (next.current_temp - prev.current_temp) * f : null);
      target.push(bridge && prev.target_temp > 0 && next.target_temp > 0 ? prev.target_temp + (next.target_temp - prev.target_temp) * f : null);
    }
    const mi = modelAt.get(t);
    mass.push(mi != null ? model.mass[mi] : (s?.mass_temp ?? null));
    settled.push(mi != null ? model.settledness[mi] : (s?.settledness ?? null));
  }
  return { x, temp, target, mass, settled, real };
}

export function machineChart(container, samples, shots, sessions, events = [], model = null) {
  const c = colors();
  const merged = mergeMachineSeries(samples, model);
  const x = merged.x;
  const realIdx = merged.real.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  const onlyReal = (u, seriesIdx, show) => (show ? realIdx : null);
  const data = [x, merged.temp, merged.target, merged.mass, merged.settled];
  const plot = new uPlot({
    width: container.clientWidth, height: 280,
    cursor: { drag: { x: true, y: false } },
    legend: { show: false },
    // Down to 5 °C: the cold level the machine reports is room minus its
    // temperature offset, 14 °C here, and the model rests there overnight.
    // The top follows the data: brewing stays under 105 °C, but a steam
    // session reads 140 °C and more, and a fixed ceiling cut it off.
    scales: { x: { time: true }, y: { range: (u, min, max) => [5, Number.isFinite(max) ? Math.max(105, Math.ceil(max / 10) * 10 + 5) : 105] }, pct: { range: [0, 100] } },
    axes: [
      axis({ scale: "x" }),
      axis({ scale: "y", values: (u, v) => v.map((n) => n + "°") }),
    ],
    series: [
      { value: "{HH}:{mm}" },
      { label: "°C", stroke: c.temp, width: 2, spanGaps: false, points: { filter: onlyReal }, value: (u, v) => (v == null ? "–" : v.toFixed(1)) },
      { label: "target", stroke: c.faint, width: 1, dash: [3, 4], spanGaps: false, points: { filter: onlyReal }, value: (u, v) => (v == null ? "–" : v) },
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
  // uPlot takes x as ascending and finds the visible range by binary search
  // on it; points arrive in shot order, which for a scatter by settledness is
  // not ascending, and the chart then showed one point (2026-10-03).
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  xs = order.map((i) => xs[i]);
  ys = order.map((i) => ys[i]);
  groups = order.map((i) => groups[i]);
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

/** A hex colour with alpha, for band fills. */
const alpha = (hex, a) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, "0") : hex);

/** A series drawn only to carry a band's edge: no stroke of its own. */
const edge = () => ({ stroke: "transparent", width: 1, points: { show: false } });

/**
 * A median curve with its interquartile band and one shot drawn over it.
 * `band` is {median, lo, hi} on the grid `xs`; `latest` the overlaid curve.
 */
export function bandChart(container, xs, band, latest, { color, unit, medianLabel, latestLabel, digits = 1 }) {
  const c = colors();
  const fmt = (v) => `${v.toFixed(digits)} ${unit}`;
  const plot = new uPlot({
    width: container.clientWidth, height: 260,
    cursor: { drag: { x: false, y: false } },
    legend: { show: false },
    scales: { x: { time: false }, y: { range: (u, min, max) => [0, max == null ? 1 : max * 1.08] } },
    axes: [axis({ scale: "x", label: "s" }), axis({ scale: "y", label: unit })],
    bands: [{ series: [1, 2], fill: alpha(color, 0.2) }],
    series: [
      {},
      { ...edge(), label: "hi" },
      { ...edge(), label: "lo" },
      { label: medianLabel, stroke: color, width: 2, points: { show: false } },
      { label: latestLabel, stroke: c.text, width: 1.5, dash: [4, 3], points: { show: false } },
    ],
  }, [xs, band.hi, band.lo, band.median, latest], container);
  const last = (values) => { for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]; return null; };
  readout(plot, container, [
    { name: medianLabel, color, series: 3, fmt, label: "", idle: last(band.median) == null ? "–" : fmt(last(band.median)), x: (v) => `${v.toFixed(1)} s` },
    { name: latestLabel, color: c.text, series: 4, fmt, label: "", idle: last(latest) == null ? "–" : fmt(last(latest)) },
  ]);
  return responsive(plot, container);
}

/**
 * Points by group with, per group, a least-squares line and its 95 % band
 * for the mean. `groups`: [{label, color, xs, ys, fit}] where `fit` carries
 * slope, intercept, resid_sd, n, x_mean, sxx, t_crit, x_min, x_max, or null.
 * uPlot wants one ascending x, so every point and every fit sample becomes
 * an entry of a merged x and the fits are evaluated at each entry inside
 * their range: no gaps inside a band, nothing to span.
 */
export function fitChart(container, groups, { xLabel, yLabel, unit, digits = 1 }) {
  const entries = [];
  groups.forEach((g, gi) => g.xs.forEach((x, i) => entries.push({ x, gi, y: g.ys[i] })));
  for (const g of groups) {
    if (!g.fit) continue;
    for (let k = 0; k <= 12; k++) entries.push({ x: g.fit.x_min + ((g.fit.x_max - g.fit.x_min) * k) / 12, gi: -1, y: null });
  }
  entries.sort((a, b) => a.x - b.x);
  const xs = entries.map((e) => e.x);
  const data = [xs];
  const series = [{}];
  const bands = [];
  const meta = [];
  const evaluate = (fit, x) => {
    const y = fit.intercept + fit.slope * x;
    const se = fit.resid_sd * Math.sqrt(1 / fit.n + (x - fit.x_mean) ** 2 / fit.sxx);
    return { y, lo: y - fit.t_crit * se, hi: y + fit.t_crit * se };
  };
  groups.forEach((g, gi) => {
    data.push(entries.map((e) => (e.gi === gi ? e.y : null)));
    series.push({ label: g.label, stroke: g.color, paths: uPlot.paths.points({ size: 7 }), points: { show: true, size: 7 } });
    meta.push({ name: g.label, color: g.color, series: data.length - 1, fmt: (v) => `${v.toFixed(digits)} ${unit}`, label: "", idle: g.fit ? `${g.fit.slope >= 0 ? "+" : ""}${g.fit.slope.toFixed(2)} ${unit}/${xLabel}` : `n ${g.xs.length}` });
    if (!g.fit) return;
    const inRange = (x) => x >= g.fit.x_min - 1e-9 && x <= g.fit.x_max + 1e-9;
    const hi = xs.map((x) => (inRange(x) ? evaluate(g.fit, x).hi : null));
    const lo = xs.map((x) => (inRange(x) ? evaluate(g.fit, x).lo : null));
    const line = xs.map((x) => (inRange(x) ? evaluate(g.fit, x).y : null));
    data.push(hi, lo, line);
    const at = data.length - 1;
    series.push({ ...edge(), label: "hi" }, { ...edge(), label: "lo" }, { label: g.label + " fit", stroke: g.color, width: 1.5, points: { show: false } });
    bands.push({ series: [at - 2, at - 1], fill: alpha(g.color, 0.14) });
  });
  if (meta.length) meta[0].x = (v) => `${xLabel} ${v.toFixed(1)}`;
  const plot = new uPlot({
    width: container.clientWidth, height: 260,
    cursor: { drag: { x: false, y: false } },
    legend: { show: false },
    scales: { x: { time: false }, y: {} },
    axes: [axis({ scale: "x", label: xLabel }), axis({ scale: "y", label: yLabel })],
    bands, series,
  }, data, container);
  readout(plot, container, meta);
  return responsive(plot, container);
}

/**
 * Individuals control chart: one value per shot in sequence, with the centre
 * line and ±kσ limits of each stretch pulled the same way, and the points
 * outside them marked. `points` and `segments` as the stats endpoint returns
 * them; `metric` is "seconds" or "ratio".
 */
export function controlChart(container, points, segments, metric, { unit, digits = 1, label, dateOf }) {
  const c = colors();
  // A null entry half a step after each stretch, so the limits of one do
  // not join those of the next with a slanted line; the value line spans it.
  const rows = [];
  points.forEach((p, i) => {
    rows.push({ x: p.seq, p });
    if (i + 1 < points.length && points[i + 1].segment !== p.segment) rows.push({ x: p.seq + 0.5, p: null });
  });
  const seq = rows.map((r) => r.x);
  const value = rows.map((r) => (r.p ? r.p[metric] : null));
  const limits = (key) => rows.map((r) => {
    const s = r.p?.segment == null ? null : segments[r.p.segment]?.[metric];
    return s ? s[key] : null;
  });
  const outside = rows.map((r) => (r.p && r.p[metric] != null && r.p[`out_${metric}`] ? r.p[metric] : null));
  const pointAt = (x) => points[Math.round(x) - 1];
  const fmt = (v) => `${v.toFixed(digits)}${unit ? " " + unit : ""}`;
  const plot = new uPlot({
    width: container.clientWidth, height: 260,
    cursor: { drag: { x: false, y: false } },
    legend: { show: false },
    scales: { x: { time: false }, y: {} },
    axes: [axis({ scale: "x", label: "#", values: (u, vals) => vals.map((v) => (Number.isInteger(v) && pointAt(v) ? "#" + pointAt(v).id : "")) }), axis({ scale: "y", label: unit })],
    bands: [{ series: [1, 2], fill: alpha(c.accent, 0.1) }],
    series: [
      {},
      { ...edge(), label: "ucl" },
      { ...edge(), label: "lcl" },
      { label: "center", stroke: c.accent, width: 1, points: { show: false } },
      { label, stroke: c.text, width: 1, spanGaps: true, points: { show: true, size: 5 } },
      { label: "outside", stroke: c.temp, fill: c.temp, paths: uPlot.paths.points({ size: 9 }), points: { show: true, size: 9 } },
    ],
  }, [seq, limits("ucl"), limits("lcl"), limits("center"), value, outside], container);
  readout(plot, container, [
    { name: label, color: c.text, series: 4, fmt, label: "", idle: points.length ? fmt(points[points.length - 1][metric]) : "–", x: (v) => (Number.isInteger(v) && pointAt(v) ? `#${pointAt(v).id} · ${dateOf(pointAt(v).started_at)}` : "") },
    { name: "±" + String.fromCharCode(963), color: c.accent, series: 3, fmt, label: "", idle: "" },
  ]);
  return responsive(plot, container);
}
