import { locale, t } from "./i18n.js";

export const fmt = {
  time: (unix) => new Date(unix * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }),
  date: (unix) => new Date(unix * 1000).toLocaleDateString(locale(), { day: "numeric", month: "numeric" }),
  dateTime: (unix) => new Date(unix * 1000).toLocaleString(locale(), { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }),
  dateLong: (unix) => new Date(unix * 1000).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "long" }),
  /** "1 h 05 min" / "12 min" / "45 s" */
  duration: (s) => {
    if (s == null) return "–";
    if (s < 90) return `${Math.round(s)} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  },
  seconds: (s) => (s == null ? "–" : `${s.toFixed(1)} s`),
  g: (g) => (g == null ? "–" : `${g.toFixed(1)} g`),
  ratio: (r) => (r == null ? "–" : `1:${r.toFixed(2)}`),
  temp: (c) => (c == null ? "–" : `${c.toFixed(1)} °C`),
  bar: (b) => (b == null ? "–" : `${b.toFixed(1)} bar`),
  pct: (p) => (p == null ? "–" : `${p} %`),
  stars: (n) => {
    if (n == null || n === 0) return `<span class="stars faint">${t("shot.unrated")}</span>`;
    return `<span class="stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
  },
  settledTone: (p) => (p == null ? "" : p >= 85 ? "ok" : p >= 60 ? "warn" : "bad"),
};

/** Inline SVG sparkline of a pressure trace: 0–10 bar, no axes. */
export function sparkline(values, w = 76, h = 26) {
  if (!values || values.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const max = 10;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - Math.min(v, max) / max * (h - 4)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="var(--pressure)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export function toast(message, tone = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${tone}`; el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function el(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/** The dial-in verdict as one sentence, from fixed phrases. Empty for no targets/data. */
export function verdictText(v) {
  if (!v || v.code === "no_targets" || v.code === "no_data") return "";
  const key = v.code === "too_fast" || v.code === "too_slow" ? `${v.code}_${v.step ?? "small"}` : v.code;
  return t("dialin." + key);
}
export function verdictTone(v) {
  if (!v) return "";
  if (v.code === "on_target") return "ok";
  if (v.code === "no_targets" || v.code === "no_data") return "";
  return "warn";
}
