import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { usage, tone } from "../lib/maintenance.js";

/**
 * The kiosk: a fixed 800×480 touch display next to the machine. Screens sit
 * side by side and are switched by a swipe this page handles itself — touch
 * scrolling in WPE (the kiosk's browser) is unreliable and turns many drags
 * into taps, so nothing here scrolls and a drag never reaches a button.
 *
 * Everything it shows comes from the archive (api/kiosk), never from the
 * machine: it runs all day, and the machine's Wi-Fi is the weakest link.
 */

/** Grind changes are saved once the presses stop, as one setup period, not one per step. */
const GRIND_SAVE_MS = 1500;
/** How far a finger moves before a touch is a swipe and no longer a tap. */
const DRAG_PX = 12;
/** Past this share of the width, a released swipe moves to the next screen. */
const SWIPE_SHARE = 0.18;
/** Nothing on screen changes faster than a coffee is made. */
const REFRESH_MS = 60_000;

function brewingCard(data, grind) {
  const s = data.setup;
  if (!s) return `<section class="card"><div class="card-head"><h2>${t("now.brewing")}</h2></div><p class="muted">${t("now.no_setup")}</p></section>`;
  return `
    <section class="card brewing-card">
      <h2>${t("now.brewing")}</h2>
      <div class="bean">${s.bean ?? "?"}</div>
      <div class="roaster">${s.roaster ?? ""}${s.roast_date ? " · " + s.roast_date : ""}</div>
      <p class="since">${t("setup.since")} ${fmt.dateTime(s.valid_from)}</p>
      ${data.stock?.remaining_g != null ? `<p class="stock">${data.stock.low ? `<span class="pill warn">${t("now.stock_low")}</span> ` : ""}${t("now.stock", { g: data.stock.remaining_g, days: data.stock.days_left != null ? t("coffees.days", { n: data.stock.days_left }) : "–" })}</p>` : ""}
      <div class="label grind-label">${t("now.grind")}</div>
      <div class="stepper">
        <button type="button" data-grind="-1" aria-label="${t("kiosk.finer")}">−</button>
        <span class="value num" data-grind-value>${grind ?? "–"}</span>
        <button type="button" data-grind="1" aria-label="${t("kiosk.coarser")}">+</button>
      </div>
      <div class="dose num">${s.dose_g != null ? s.dose_g + " g" : "–"}</div>
      <div class="label">${t("now.dose")}</div>
    </section>`;
}

function dueText(m) {
  if (m.due_in_days == null) return "–";
  return m.due_in_days === 0 ? t("kiosk.due_now") : t("kiosk.due_in", { n: m.due_in_days });
}

function maintenanceCard(data) {
  const rows = data.maintenance ?? [];
  return `
    <section class="card maint-card">
      <h2>${t("maint.title")}</h2>
      ${rows.length ? rows.map((m) => `
        <div class="kiosk-maint ${tone(m)}">
          <div class="head">
            <b>${t("maint.type." + m.key)}</b>
            <span class="due ${tone(m)}">${dueText(m)}</span>
          </div>
          <div class="gauge"><i style="width:${Math.min(100, Math.round((m.fraction ?? 0) * 100))}%"></i></div>
          <div class="usage num">${usage(m)}</div>
        </div>`).join("") : `<p class="muted">${t("maint.log_empty")}</p>`}
    </section>`;
}

export async function renderKiosk(view) {
  const root = document.documentElement;
  root.classList.add("kiosk");
  const themeBefore = root.dataset.theme;
  root.dataset.theme = "dark";

  const [first, prefs] = await Promise.all([api.kiosk(), api.preferences().catch(() => null)]);
  const scale = { min: prefs?.grind_min ?? 0, max: prefs?.grind_max ?? 90, step: prefs?.grind_step ?? 0.5 };

  let latest = first;
  let index = 0;
  /** A grind value pressed but not saved yet; it wins over what the server says. */
  let pendingGrind = null;
  let saveTimer = null;

  view.innerHTML = `
    <div class="kiosk-frame">
      <div class="kiosk-track"><div class="kiosk-screen"></div><div class="kiosk-screen"></div></div>
      <div class="kiosk-dots"><i></i><i></i></div>
    </div>`;
  const frame = view.querySelector(".kiosk-frame");
  const track = view.querySelector(".kiosk-track");
  const screens = [...view.querySelectorAll(".kiosk-screen")];
  const dots = [...view.querySelectorAll(".kiosk-dots i")];

  const draw = () => {
    screens[0].innerHTML = brewingCard(latest, pendingGrind ?? latest.setup?.grind_setting);
    screens[1].innerHTML = maintenanceCard(latest);
  };
  const place = (offsetPx = 0) => {
    track.style.transform = `translateX(calc(${-index * 100}% + ${offsetPx}px))`;
    dots.forEach((d, i) => d.classList.toggle("active", i === index));
  };
  draw(); place();

  const refresh = async () => {
    try { latest = await api.kiosk(); draw(); } catch { /* the next poll tries again */ }
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
  const onClick = (e) => {
    const grind = e.target.closest("[data-grind]");
    if (grind) stepGrind(Number(grind.dataset.grind));
  };

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
  const timer = setInterval(refresh, REFRESH_MS);

  return () => {
    clearInterval(timer);
    // A pressed grind is saved on the way out, not dropped.
    if (saveTimer) { clearTimeout(saveTimer); saveGrind(); }
    view.removeEventListener("click", onClick);
    root.classList.remove("kiosk");
    if (themeBefore) root.dataset.theme = themeBefore;
  };
}
