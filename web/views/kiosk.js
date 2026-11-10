import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { machineCard, onModeClick, onPlanChange } from "./now.js";

/**
 * The kiosk: a fixed 800×480 touch display next to the machine. Screens sit
 * side by side and are switched by a swipe this page handles itself — touch
 * scrolling in WPE (the kiosk's browser) is unreliable and turns many drags
 * into taps, so nothing here scrolls and a drag never reaches a button.
 */

/** Grind changes are saved once the presses stop, as one setup period, not one per step. */
const GRIND_SAVE_MS = 1500;
/** How far a finger moves before a touch is a swipe and no longer a tap. */
const DRAG_PX = 12;
/** Past this share of the width, a released swipe moves to the next screen. */
const SWIPE_SHARE = 0.18;
const REFRESH_MS = 10_000;

function brewingCard(now, grind) {
  const s = now.setup;
  if (!s) return `<section class="card"><div class="card-head"><h2>${t("now.brewing")}</h2></div><p class="muted">${t("now.no_setup")}</p></section>`;
  return `
    <section class="card brewing-card">
      <div class="card-head"><h2>${t("now.brewing")}</h2></div>
      <div class="bean">${s.bean ?? "?"}</div>
      <div class="muted">${s.roaster ?? ""}${s.roast_date ? " · " + s.roast_date : ""}</div>
      <p class="faint small" style="margin-top:14px">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</p>
      ${now.stock?.remaining_g != null ? `<p class="small" style="margin-top:6px">${now.stock.low ? `<span class="pill warn">${t("now.stock_low")}</span> ` : ""}${t("now.stock", { g: now.stock.remaining_g, days: now.stock.days_left != null ? t("coffees.days", { n: now.stock.days_left }) : "–" })}</p>` : ""}
      <div class="stat-l">${t("now.grind")}</div>
      <div class="stepper">
        <button type="button" data-grind="-1" aria-label="${t("kiosk.finer")}">−</button>
        <span class="value num" data-grind-value>${grind ?? "–"}</span>
        <button type="button" data-grind="1" aria-label="${t("kiosk.coarser")}">+</button>
      </div>
      <div class="stat" style="margin-top:14px"><span class="v num">${s.dose_g != null ? s.dose_g + " g" : "–"}</span><span class="l">${t("now.dose")}</span></div>
    </section>`;
}

export async function renderKiosk(view) {
  const root = document.documentElement;
  root.classList.add("kiosk");
  const themeBefore = root.dataset.theme;
  root.dataset.theme = "dark";

  const [first, prefs] = await Promise.all([api.now(), api.preferences().catch(() => null)]);
  const scale = { min: prefs?.grind_min ?? 0, max: prefs?.grind_max ?? 90, step: prefs?.grind_step ?? 0.5 };

  let latest = first;
  let index = 0;
  /** A grind value pressed but not saved yet; it wins over what the server says. */
  let pendingGrind = null;
  let saveTimer = null;

  view.innerHTML = `
    <div class="kiosk-frame">
      <div class="kiosk-track"><div class="kiosk-screen" data-screen="brewing"></div><div class="kiosk-screen" data-screen="machine"></div></div>
      <div class="kiosk-dots"><i></i><i></i></div>
    </div>`;
  const frame = view.querySelector(".kiosk-frame");
  const track = view.querySelector(".kiosk-track");
  const screens = [...view.querySelectorAll(".kiosk-screen")];
  const dots = [...view.querySelectorAll(".kiosk-dots i")];

  const draw = () => {
    screens[0].innerHTML = brewingCard(latest, pendingGrind ?? latest.setup?.grind_setting);
    screens[1].innerHTML = machineCard(latest.machine);
  };
  const place = (offsetPx = 0) => {
    track.style.transform = `translateX(calc(${-index * 100}% + ${offsetPx}px))`;
    dots.forEach((d, i) => d.classList.toggle("active", i === index));
  };
  draw(); place();

  const refresh = async () => {
    try { latest = await api.now(); draw(); } catch { /* the next poll tries again */ }
  };

  // ---- grind -------------------------------------------------------------
  const saveGrind = async () => {
    saveTimer = null;
    const value = pendingGrind;
    try {
      const r = await api.recordSetup({ grind_setting: value });
      toast(t("setup.saved", { bean: r.setup.bean ?? "?", grind: r.setup.grind_setting ?? "?", dose: r.setup.dose_g ?? "?" }));
    } catch (err) {
      toast(err.message, "bad");
    }
    // A press during the save started a new wait; that value is still pending.
    if (pendingGrind === value) pendingGrind = null;
    await refresh();
  };
  const stepGrind = (dir) => {
    const current = pendingGrind ?? latest.setup?.grind_setting;
    if (current == null) return;
    const next = Math.round((Number(current) + dir * scale.step) / scale.step) * scale.step;
    pendingGrind = Math.min(scale.max, Math.max(scale.min, next));
    const el = view.querySelector("[data-grind-value]");
    if (el) el.textContent = pendingGrind;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveGrind, GRIND_SAVE_MS);
  };

  // ---- swipe -------------------------------------------------------------
  // Touch events with touch-action: none — the page, not the browser, decides
  // what a drag is (mouse too, for a desktop browser; WPE also sends a mouse
  // event after each tap, so mouse input right after a touch is ignored).
  // A touch that moved past DRAG_PX swallows the click that may follow it,
  // so a swipe that starts on a button never presses it.
  let start = null;
  let swallowClick = false;
  let lastTouch = 0;
  const point = (e) => (e.changedTouches ? e.changedTouches[0] : e);
  const isEcho = (e) => !e.changedTouches && Date.now() - lastTouch < 800;
  const onDown = (e) => {
    if (e.changedTouches) lastTouch = Date.now();
    else if (isEcho(e) || e.button !== 0) return;
    const p = point(e);
    start = { x: p.clientX, y: p.clientY, dragging: false };
  };
  const onMove = (e) => {
    if (!start || isEcho(e)) return;
    const p = point(e);
    const dx = p.clientX - start.x, dy = p.clientY - start.y;
    if (!start.dragging && Math.abs(dx) > DRAG_PX && Math.abs(dx) > Math.abs(dy)) {
      start.dragging = true;
      track.classList.add("dragging");
    }
    if (start.dragging) {
      // Resistance at either end: there is no screen to pull in.
      const edge = (index === 0 && dx > 0) || (index === screens.length - 1 && dx < 0);
      place(edge ? dx / 4 : dx);
    }
  };
  const onUp = (e) => {
    if (!start || isEcho(e)) return;
    if (e.changedTouches) lastTouch = Date.now();
    const dx = point(e).clientX - start.x;
    if (start.dragging) {
      // Not every drag is followed by a click; one that is not must not
      // leave the next real tap swallowed.
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 400);
      track.classList.remove("dragging");
      if (Math.abs(dx) > frame.clientWidth * SWIPE_SHARE) index = Math.min(screens.length - 1, Math.max(0, index - Math.sign(dx)));
      place();
    }
    start = null;
  };
  const onCancel = () => { if (start?.dragging) { track.classList.remove("dragging"); place(); } start = null; };
  const onClickCapture = (e) => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); }
  };

  // ---- taps --------------------------------------------------------------
  const onClick = (e) => {
    const grind = e.target.closest("[data-grind]");
    if (grind) { stepGrind(Number(grind.dataset.grind)); return; }
    onModeClick(view, e, refresh);
  };
  const onChange = (e) => { if (onPlanChange(e)) draw(); };

  // ---- live temperature ----------------------------------------------------
  // api/now every few seconds carries everything; the stream only moves the
  // big number between polls, so it reads as live on the screen.
  const live = new EventSource("api/live");
  live.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    const el = view.querySelector("[data-live-temp]");
    if (el && s.temperature?.current != null && latest.machine?.reachable) el.textContent = s.temperature.current.toFixed(1);
  });
  live.addEventListener("online", refresh);
  live.addEventListener("offline", refresh);

  frame.addEventListener("touchstart", onDown, { passive: true });
  frame.addEventListener("touchmove", onMove, { passive: true });
  frame.addEventListener("touchend", onUp);
  frame.addEventListener("touchcancel", onCancel);
  frame.addEventListener("mousedown", onDown);
  frame.addEventListener("mousemove", onMove);
  frame.addEventListener("mouseup", onUp);
  frame.addEventListener("mouseleave", onCancel);
  frame.addEventListener("click", onClickCapture, true);
  view.addEventListener("click", onClick);
  view.addEventListener("change", onChange);
  const timer = setInterval(refresh, REFRESH_MS);

  return () => {
    clearInterval(timer);
    live.close();
    // A pressed grind is saved on the way out, not dropped.
    if (saveTimer) { clearTimeout(saveTimer); saveGrind(); }
    view.removeEventListener("click", onClick);
    view.removeEventListener("change", onChange);
    root.classList.remove("kiosk");
    if (themeBefore) root.dataset.theme = themeBefore;
  };
}
