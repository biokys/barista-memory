import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import QRCode from "qrcode";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { loadArchivedShot } from "./shots.js";
import { maintenanceStatus } from "./maintenance.js";
import { verdictFor } from "./dialin.js";
import { getAnalysis } from "./anomaly.js";
import { getSetting } from "./settings.js";
import { getCaption } from "./captions.js";

/**
 * A receipt for one shot, as a 384 px wide image: what a cat-printer class
 * thermal printer takes one to one. Built as SVG (the same curves the web
 * draws) and rasterised with resvg in WebAssembly, so it needs no native
 * module and prints identically from the Pi, a container or the add-on.
 * Everything is black on white with no greys: the printer is 1-bit and a
 * thresholded grey would either vanish or turn to noise.
 */

export const RECEIPT_WIDTH = 384;
const M = 12; // side margin

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = ["Inter-Regular.ttf", "Inter-SemiBold.ttf"].map((f) => join(ROOT, "assets", "fonts", f));

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    const require = createRequire(import.meta.url);
    const wasmPath = join(dirname(require.resolve("@resvg/resvg-wasm")), "index_bg.wasm");
    wasmReady = initWasm(readFileSync(wasmPath)).catch((error) => {
      // "already initialized" is fine when two callers race; anything else is not.
      if (!String(error).includes("already")) throw error;
    });
  }
  return wasmReady;
}

const GREETINGS: Record<"cs" | "en", string[]> = {
  cs: [
    "Život je příliš krátký na špatné espresso.",
    "Nejdřív káva, pak povinnosti.",
    "9 barů tlaku, nula stresu.",
    "Melu, tedy jsem.",
    "Espresso: malé balení velkého štěstí.",
    "Dobrý shot pozná barista, skvělý i host.",
    "Káva je odpověď. Na otázku se neptej.",
    "Dekaf je jen teplá, hnědá lež.",
    "Víc dat než váš poslední pohovor.",
    "Barista byl robot. Chuť je vaše starost.",
    "Účtenka delší než seznam mých koníčků.",
    "Espresso se nepije. Espresso se zažije.",
    "Kdyby to bylo snadné, byl by to čaj.",
    "Měříme tlak, teplotu a průtok. Vás ne.",
  ],
  en: [
    "Life is too short for bad espresso.",
    "Coffee first, duties later.",
    "9 bars of pressure, zero stress.",
    "I grind, therefore I am.",
    "Espresso: a small package of great happiness.",
    "A barista knows a good shot; a guest knows a great one.",
    "Coffee is the answer. Don't ask the question.",
    "Decaf is just warm brown regret.",
    "More data than your last job interview.",
    "The barista was a robot. Taste is your problem.",
    "A receipt longer than my list of hobbies.",
    "If it were easy, it would be tea.",
    "We measure pressure, temperature and flow. Not you.",
  ],
};

const T: Record<"cs" | "en", Record<string, string>> = {
  cs: { title: "ESPRESSO", grind: "Mletí", dose: "Dávka", cup: "V šálku", ratio: "poměr", time: "Čas", preinf: "preinfuze", temp: "Teplota", target: "cíl", peak: "Špička", decline: "pokles", machine: "Stroj", warm: "nahřátí", pressure: "tlak (bar)", flow: "průtok (ml/s)", thanks: "Děkujeme za návštěvu!", due: "Údržba po termínu:", backflush: "proplach", cafiza: "Cafiza", descale: "odvápnění", water_filter: "filtr vody", gasket: "těsnění", test: "Zkušební tisk", unrated: "",
    next: "Příště", on_target: "tak akorát, nic neměň", too_fast_small: "o kousek jemněji", too_fast_large: "výrazně jemněji", too_slow_small: "o kousek hruběji", too_slow_large: "výrazně hruběji", ratio_low: "nech téct o něco déle", ratio_high: "zastav o něco dřív",
    watch: "Pozor", channeling: "channeling", choked: "ucpaný puk", low_pressure: "nízký tlak", temperature_unstable: "kolísá teplota", off_pattern: "jiný průběh než obvykle" },
  en: { title: "ESPRESSO", grind: "Grind", dose: "Dose", cup: "In the cup", ratio: "ratio", time: "Time", preinf: "preinfusion", temp: "Temperature", target: "target", peak: "Peak", decline: "decline", machine: "Machine", warm: "warm-up", pressure: "pressure (bar)", flow: "flow (ml/s)", thanks: "Thank you for visiting!", due: "Maintenance overdue:", backflush: "backflush", cafiza: "Cafiza", descale: "descaling", water_filter: "water filter", gasket: "gasket", test: "Test print", unrated: "",
    next: "Next time", on_target: "spot on, change nothing", too_fast_small: "a touch finer", too_fast_large: "much finer", too_slow_small: "a touch coarser", too_slow_large: "much coarser", ratio_low: "let it run a little longer", ratio_high: "stop a little earlier",
    watch: "Watch out", channeling: "channeling", choked: "choked puck", low_pressure: "low pressure", temperature_unstable: "unstable temperature", off_pattern: "unlike the usual curve" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toFixed(d));

/** Rough wrap for centred lines; Inter averages ~0.5 em per character. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const perChar = size * 0.52;
  const max = Math.max(8, Math.floor(maxWidth / perChar));
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > max && line) { lines.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

class Svg {
  parts: string[] = [];
  y = 0;
  text(x: number, y: number, s: string, size: number, opts: { weight?: number; anchor?: "start" | "middle" | "end" } = {}) {
    this.parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${opts.weight ?? 400}" text-anchor="${opts.anchor ?? "start"}">${esc(s)}</text>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, w = 2, dash?: string) {
    this.parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  }
  rule(gap = 8) { this.y += gap; this.line(M + 4, this.y, RECEIPT_WIDTH - M - 4, this.y, 2); this.y += gap; }
  raw(s: string) { this.parts.push(s); }
  centered(s: string, size: number, weight = 400, lineGap = 6) {
    for (const l of wrap(s, size, RECEIPT_WIDTH - 2 * M)) { this.y += size; this.text(RECEIPT_WIDTH / 2, this.y, l, size, { weight, anchor: "middle" }); this.y += lineGap; }
  }
  render(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${RECEIPT_WIDTH}" height="${Math.ceil(this.y)}" viewBox="0 0 ${RECEIPT_WIDTH} ${Math.ceil(this.y)}" font-family="Inter" fill="#000"><rect width="100%" height="100%" fill="#fff"/>${this.parts.join("")}</svg>`;
  }
}

function cup(svg: Svg, cx: number, top: number) {
  // A café logo the printer can reproduce: cup, saucer, three wisps of steam.
  const w = 46, h = 30;
  svg.raw(`<path d="M${cx - w / 2} ${top + 22} h${w} v${h - 10} a10 10 0 0 1 -10 10 h${-(w - 20)} a10 10 0 0 1 -10 -10 z" fill="none" stroke="#000" stroke-width="3"/>`);
  svg.raw(`<path d="M${cx + w / 2} ${top + 28} a9 9 0 0 1 0 18" fill="none" stroke="#000" stroke-width="3"/>`);
  svg.line(cx - w / 2 - 8, top + h + 28, cx + w / 2 + 8, top + h + 28, 3);
  for (const dx of [-12, 0, 12]) svg.raw(`<path d="M${cx + dx} ${top + 16} c -4 -5 4 -8 0 -14" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>`);
}

function stars(svg: Svg, rating: number | null) {
  if (!rating) return;
  const size = 22, gap = 8, total = 5 * size + 4 * gap;
  let x = (RECEIPT_WIDTH - total) / 2;
  svg.y += 6;
  for (let i = 1; i <= 5; i++) {
    const cx = x + size / 2, cy = svg.y + size / 2, r = size / 2, r2 = r * 0.42;
    const pts: string[] = [];
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5; const rr = k % 2 ? r2 : r; pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`); }
    svg.raw(`<polygon points="${pts.join(" ")}" fill="${i <= rating ? "#000" : "#fff"}" stroke="#000" stroke-width="1.5"/>`);
    x += size + gap;
  }
  svg.y += size + 6;
}

function chart(svg: Svg, curve: Array<{ time_seconds: number; pressure_bar: number; flow_ml_s: number }>, phases: Array<{ name: string; start_time_seconds: number }>, t: Record<string, string>) {
  if (curve.length < 2) return;
  const left = 30, right = 8, plotH = 170, top = svg.y + 18;
  const plotW = RECEIPT_WIDTH - left - right;
  const tMax = Math.max(1, curve[curve.length - 1].time_seconds);
  const vMax = Math.max(10, Math.ceil(Math.max(...curve.map((p) => Math.max(p.pressure_bar, p.flow_ml_s))) / 2) * 2);
  const px = (s: number) => left + (plotW * s) / tMax;
  const py = (v: number) => top + plotH - (plotH * v) / vMax;
  for (let g = 0; g <= vMax; g += 2) { svg.line(left, py(g), left + plotW, py(g), 1, g === 0 ? undefined : "1,3"); svg.text(left - 5, py(g) + 4, String(g), 12, { anchor: "end" }); }
  const step = tMax <= 25 ? 5 : 10;
  for (let s = 0; s <= tMax; s += step) { svg.line(px(s), top, px(s), top + plotH, 1, "1,3"); svg.text(px(s), top + plotH + 14, String(s), 12, { anchor: "middle" }); }
  svg.raw(`<rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="none" stroke="#000" stroke-width="1"/>`);
  for (const ph of phases) {
    if (ph.start_time_seconds <= 0) continue;
    svg.line(px(ph.start_time_seconds), top, px(ph.start_time_seconds), top + plotH, 1, "3,3");
    svg.text(px(ph.start_time_seconds) + 2, top + 11, ph.name.slice(0, 12), 10);
  }
  const pl = (key: "pressure_bar" | "flow_ml_s") => curve.map((p) => `${px(p.time_seconds).toFixed(1)},${py(Math.max(0, p[key])).toFixed(1)}`).join(" ");
  svg.raw(`<polyline points="${pl("pressure_bar")}" fill="none" stroke="#000" stroke-width="2.2" stroke-linejoin="round"/>`);
  svg.raw(`<polyline points="${pl("flow_ml_s")}" fill="none" stroke="#000" stroke-width="2" stroke-dasharray="6,4" stroke-linejoin="round"/>`);
  const ly = top + plotH + 34;
  svg.line(left, ly, left + 24, ly, 2.2); svg.text(left + 30, ly + 4, t.pressure, 13);
  svg.line(left + 160, ly, left + 184, ly, 2, "6,4"); svg.text(left + 190, ly + 4, t.flow, 13);
  svg.y = ly + 14;
}

async function qr(svg: Svg, url: string) {
  const code = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = code.modules.size, box = 4, side = n * box, x0 = (RECEIPT_WIDTH - side) / 2, y0 = svg.y + 10;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (code.modules.get(r, c)) d += `M${x0 + c * box} ${y0 + r * box}h${box}v${box}h-${box}z`;
  svg.raw(`<path d="${d}" fill="#000"/>`);
  svg.y = y0 + side + 10;
}

/** What the receipt says about the place; all optional, all from the UI. */
export interface ReceiptOptions {
  cafe_name: string;
  cafe_tagline: string;
  thanks: string;
  /** Own greeting lines; empty = the built-in list for the language. */
  greetings: string[];
  web_url: string;
  show_chart: boolean;
  show_qr: boolean;
  /** Ask the assistant for a caption on every new coffee, before the automatic print. */
  auto_caption: boolean;
}

export function receiptOptions(db: DatabaseSync): ReceiptOptions {
  return {
    cafe_name: getSetting(db, "cafe_name", ""),
    cafe_tagline: getSetting(db, "cafe_tagline", ""),
    thanks: getSetting(db, "receipt_thanks", ""),
    greetings: getSetting(db, "receipt_greetings", "").split("\n").map((l) => l.trim()).filter(Boolean),
    web_url: getSetting(db, "web_url", config.webUrl).replace(/\/$/, ""),
    show_chart: getSetting(db, "receipt_chart", "1") === "1",
    show_qr: getSetting(db, "receipt_qr", "1") === "1",
    auto_caption: getSetting(db, "receipt_auto_caption", "0") === "1",
  };
}

export interface Receipt {
  svg: string;
  png: Uint8Array;
  /** 1-bit raster, row-major, true = black. */
  raster: { black: Uint8Array; width: number; height: number };
}

async function rasterise(svgText: string): Promise<Receipt> {
  await ensureWasm();
  const resvg = new Resvg(svgText, {
    fitTo: { mode: "width", value: RECEIPT_WIDTH },
    background: "#ffffff",
    font: { fontBuffers: FONTS.map((f) => readFileSync(f)), defaultFontFamily: "Inter", loadSystemFonts: false },
  });
  const image = resvg.render();
  const { width, height } = image;
  const rgba = image.pixels;
  const black = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const lum = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    black[i] = lum < 140 ? 1 : 0;
  }
  return { svg: svgText, png: image.asPng(), raster: { black, width, height } };
}

/** The receipt for an archived shot. */
export async function renderShotReceipt(db: DatabaseSync, shotId: number, lang: "cs" | "en" = config.lang): Promise<Receipt | null> {
  const loaded = loadArchivedShot(db, shotId, true);
  if (!loaded) return null;
  const { context: c, shot } = loaded;
  const t = T[lang];
  const o = receiptOptions(db);
  const locale = lang === "cs" ? "cs-CZ" : "en-GB";
  const svg = new Svg();

  svg.y = 4;
  cup(svg, RECEIPT_WIDTH / 2, svg.y);
  svg.y += 104;
  if (o.cafe_name) {
    // The café's name is the headline; the shot number moves under it.
    svg.text(RECEIPT_WIDTH / 2, svg.y, o.cafe_name, o.cafe_name.length > 16 ? 24 : 30, { weight: 600, anchor: "middle" });
    if (o.cafe_tagline) { svg.y += 20; svg.text(RECEIPT_WIDTH / 2, svg.y, o.cafe_tagline, 14, { anchor: "middle" }); }
    svg.y += 26;
    svg.text(RECEIPT_WIDTH / 2, svg.y, `${t.title} #${c.id}`, 20, { weight: 600, anchor: "middle" });
  } else {
    svg.text(RECEIPT_WIDTH / 2, svg.y, `${t.title} #${c.id}`, 30, { weight: 600, anchor: "middle" });
  }
  svg.y += 22;
  const when = new Date(c.started_at * 1000);
  svg.text(RECEIPT_WIDTH / 2, svg.y, `${when.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "long" })} · ${when.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`, 15, { anchor: "middle" });
  svg.y += 6;
  svg.rule();

  if (c.bean) {
    svg.y += 20; svg.text(RECEIPT_WIDTH / 2, svg.y, c.bean, 22, { weight: 600, anchor: "middle" });
    if (c.roaster) { svg.y += 18; svg.text(RECEIPT_WIDTH / 2, svg.y, c.roaster, 15, { anchor: "middle" }); }
    svg.y += 6;
  }

  const weight = c.stable_weight_g ?? c.final_weight_g;
  const summary = shot.summary;
  const curveAll = (shot.full_curve ?? []) as Array<{ time_seconds: number; pressure_bar: number; flow_ml_s: number }>;
  // Same figure as the shot page: the floor of the "Decline" phase, not the
  // last sample, which is the pressure spike when the valve closes.
  const phasesAll = (shot.phases ?? []) as Array<{ name: string; start_time_seconds: number; duration_seconds: number }>;
  const decline = phasesAll.find((p) => p.name === "Decline");
  const declineSamples = decline
    ? curveAll.filter((p) => p.time_seconds >= decline.start_time_seconds && p.time_seconds <= decline.start_time_seconds + decline.duration_seconds).map((p) => p.pressure_bar)
    : [];
  const lastPressure = declineSamples.length ? Math.min(...declineSamples) : null;
  const preinfusion = summary.extraction.preinfusion_time_seconds;
  const rows: Array<[string, string]> = [
    [t.grind, c.grind_setting != null ? `${c.grind_setting}` : "–"],
    [t.dose, c.dose_g != null ? `${c.dose_g} g` : "–"],
    [t.cup, `${num(weight)} g · ${t.ratio} ${c.ratio != null ? "1:" + c.ratio.toFixed(2) : "–"}`],
    [t.time, `${num(c.duration_ms != null ? c.duration_ms / 1000 : null)} s${preinfusion > 0 ? ` (${t.preinf} ${num(preinfusion, 0)} s)` : ""}`],
    [t.temp, `${num(summary.temperature.average_celsius)} °C${summary.temperature.target_average > 0 ? ` · ${t.target} ${num(summary.temperature.target_average, 0)}` : ""}`],
    [t.peak, `${num(summary.pressure.max_bar)} bar${lastPressure != null ? ` · ${t.decline} ${num(lastPressure)}` : ""}`],
  ];
  if (c.machine_settledness != null) rows.push([t.machine, `${t.warm} ${c.machine_settledness} %`]);
  svg.y += 10;
  for (const [label, value] of rows) {
    svg.y += 22;
    svg.text(M, svg.y, label, 16);
    svg.text(RECEIPT_WIDTH - M, svg.y, value, 17, { weight: 600, anchor: "end" });
  }
  svg.y += 8;

  const curve = curveAll;
  const phases = (shot.phases ?? []) as Array<{ name: string; start_time_seconds: number }>;
  if (o.show_chart && curve.length >= 2) { svg.rule(); chart(svg, curve, phases, t); }

  stars(svg, c.rating ?? null);

  // One line of advice, from the coffee's targets; nothing when it has none.
  const verdict = verdictFor(db, c);
  const phrase = verdict.code === "too_fast" || verdict.code === "too_slow" ? t[`${verdict.code}_${verdict.step ?? "small"}`] : t[verdict.code];
  const flags = getAnalysis(db, c.id)?.flags ?? [];
  if (phrase || flags.length) svg.rule();
  if (flags.length) svg.centered(`${t.watch}: ${flags.map((f) => t[f] ?? f).join(", ")}`, 15, 600);
  if (phrase) svg.centered(`${t.next}: ${phrase}`, 16, 600);

  // The user's own line (or the assistant's), after the advice and before
  // the housekeeping: it is about this cup, not about the machine.
  const caption = getCaption(db, c.id);
  if (caption) { svg.rule(); svg.centered(caption.text, 16); }

  const due = maintenanceStatus(db).filter((m) => m.enabled && m.state === "due");
  if (due.length) { svg.rule(); svg.centered(`${t.due} ${due.map((m) => t[m.key] ?? m.key).join(", ")}`, 15, 600); }

  svg.rule();
  const greetings = o.greetings.length ? o.greetings : GREETINGS[lang];
  svg.centered(greetings[c.id % greetings.length], 16);
  svg.y += 4;
  svg.centered(o.thanks || t.thanks, 19, 600);
  if (o.show_qr && o.web_url) await qr(svg, `${o.web_url}/#/shots/${c.id}`);
  svg.y += 12;

  return rasterise(svg.render());
}

/** A short strip to check the printer without a shot. */
export async function renderTestReceipt(lang: "cs" | "en" = config.lang, db?: DatabaseSync): Promise<Receipt> {
  const name = db ? receiptOptions(db).cafe_name : "";
  const svg = new Svg();
  svg.y = 4;
  cup(svg, RECEIPT_WIDTH / 2, svg.y);
  svg.y += 104;
  svg.text(RECEIPT_WIDTH / 2, svg.y, name || "barista-memory", 26, { weight: 600, anchor: "middle" });
  svg.y += 24;
  svg.text(RECEIPT_WIDTH / 2, svg.y, `${T[lang].test} · ${new Date().toLocaleString(lang === "cs" ? "cs-CZ" : "en-GB")}`, 14, { anchor: "middle" });
  svg.y += 12;
  svg.rule();
  svg.centered(GREETINGS[lang][Math.floor(Date.now() / 1000) % GREETINGS[lang].length], 16);
  svg.y += 12;
  return rasterise(svg.render());
}
