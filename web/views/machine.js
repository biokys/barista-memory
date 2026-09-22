import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { machineChart } from "../lib/charts.js";

const RANGES = { "6h": 6 * 3600, "24h": 24 * 3600, "3d": 3 * 86400, "7d": 7 * 86400 };

export async function renderMachine(view) {
  let range = localStorage.getItem("machine.range") || "24h";
  let destroy = null;
  const load = async () => {
    const now = Math.floor(Date.now() / 1000);
    const [state, settings, printer, scales, latest] = await Promise.all([
      api.machineState(now - RANGES[range], now),
      api.machineSettings().catch(() => null),
      api.printer().catch(() => null),
      api.scales().catch(() => null),
      api.shots({ limit: 1 }).catch(() => ({ shots: [] })),
    ]);
    const ps = printer?.settings;
    const rc = ps?.receipt;
    const lastId = latest.shots?.[0]?.id ?? null;
    view.innerHTML = `
      <div class="row spread"><h1>${t("machine.title")}</h1>
        <div class="row">${Object.keys(RANGES).map((k) => `<button class="btn sm ${k === range ? "primary" : "ghost"}" data-r="${k}">${t("machine.range." + k)}</button>`).join("")}</div></div>
      <section class="card">
        <div class="card-head"><h2>${t("machine.temperature_history")}</h2></div>
        <div class="chart" id="chart"></div>
        ${state.samples.length ? "" : `<p class="empty">${t("machine.no_samples")}</p>`}
      </section>
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head"><h2>${t("machine.sessions")}</h2></div>
          <div class="timeline">${[...state.sessions].reverse().map((s) => `
            <div class="tl-item ${s.ended_at ? "" : "current"}">
              <div class="when">${fmt.dateTime(s.started_at)} → ${s.ended_at ? fmt.time(s.ended_at) : t("machine.session.running")} · ${fmt.duration(s.duration_s ?? (Date.now() / 1000 - s.started_at))}</div>
              <div class="row small"><span class="num">${t("machine.session.from")} ${s.temp_at_start?.toFixed(0) ?? "–"} °C</span>
                ${s.heatup_s != null ? `<span class="pill">${t("machine.heatup")} ${fmt.duration(s.heatup_s)}</span>` : ""}
                <span class="pill">${s.shots} ${t("machine.session.shots")}</span></div>
            </div>`).join("") || `<p class="empty">${t("machine.no_samples")}</p>`}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("machine.settings")}</h2></div>
          ${settings ? Object.entries(settings.settings).map(([g, vals]) => `<h3 class="small muted" style="margin:10px 0 4px;text-transform:capitalize">${g}</h3><dl class="kv small">${Object.entries(vals).map(([k, v]) => `<dt>${k}</dt><dd class="num">${v}</dd>`).join("")}</dl>`).join("") : `<p class="muted">${t("profiles.unreachable")}</p>`}
        </section>
      </div>
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head"><h2>${t("scale.title")}</h2><button class="btn sm ghost" id="scale-scan">${t("scale.scan")}</button></div>
          ${scales ? `
            <p class="muted small">${scales.info?.connected ? `${t("scale.connected")}: <b>${scales.info.name || scales.info.uuid}</b>${scales.info.battery != null ? ` · ${scales.info.battery} %` : ""}` : t("scale.none")}</p>
            <div class="list" style="margin-top:10px">${(scales.candidates || []).map((c) => `
              <div class="row spread" style="padding:6px 0;border-top:1px solid var(--line)">
                <span><b>${c.name || "?"}</b> <span class="faint small num">${c.uuid} · ${c.rssi} dBm</span></span>
                <button class="btn sm" data-scale="${c.uuid}" ${scales.info?.uuid === c.uuid && scales.info?.connected ? "disabled" : ""}>${t("scale.connect")}</button>
              </div>`).join("") || `<p class="faint small">${t("scale.no_candidates")}</p>`}</div>
          ` : `<p class="muted">${t("profiles.unreachable")}</p>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("printer.title")}</h2>${ps?.mac ? `<button class="btn sm ghost" id="printer-test">${t("printer.test")}</button>` : ""}</div>
          ${printer ? `
            ${printer.bluetooth ? "" : `<p class="muted small">${t("printer.no_bluetooth")}</p>`}
            <div class="form">
              <div class="field"><label>${t("printer.mac")}</label>
                <div class="row"><input id="printer-mac" value="${ps.mac}" placeholder="48:0F:57:…" style="flex:1;font-family:inherit" class="num">
                  <button class="btn sm ghost" id="printer-scan" ${printer.bluetooth ? "" : "disabled"}>${t("printer.scan")}</button></div></div>
              <div id="printer-found"></div>
              <label class="row"><input type="checkbox" id="printer-auto" ${ps.print_each_shot ? "checked" : ""}> ${t("printer.auto")}</label>
              <div class="grid cols-2">
                <div class="field"><label>${t("printer.lang")}</label><select id="printer-lang"><option value="cs" ${ps.lang === "cs" ? "selected" : ""}>Čeština</option><option value="en" ${ps.lang === "en" ? "selected" : ""}>English</option></select></div>
                <div class="field"><label>${t("printer.intensity")}</label><input type="number" id="printer-intensity" min="0" max="255" value="${ps.intensity}"></div>
              </div>
              <div class="row"><button class="btn primary sm" id="printer-save">${t("printer.save")}</button></div>
            </div>
          ` : `<p class="muted">${t("printer.unavailable")}</p>`}
        </section>
      </div>
      ${rc ? `
      <div class="grid cols-2">
        <section class="card">
          <div class="card-head"><h2>${t("receipt.title")}</h2></div>
          <div class="form">
            <div class="grid cols-2">
              <div class="field"><label>${t("receipt.cafe_name")}</label><input id="rc-name" value="${rc.cafe_name}" placeholder="Café Honza"></div>
              <div class="field"><label>${t("receipt.cafe_tagline")}</label><input id="rc-tagline" value="${rc.cafe_tagline}" placeholder="${t("receipt.cafe_tagline_ph")}"></div>
            </div>
            <div class="field"><label>${t("receipt.thanks")}</label><input id="rc-thanks" value="${rc.thanks}" placeholder="${t("receipt.thanks_ph")}"></div>
            <div class="field"><label>${t("receipt.greetings")}</label><textarea id="rc-greetings" rows="4" placeholder="${t("receipt.greetings_ph")}">${rc.greetings.join("\n")}</textarea></div>
            <div class="field"><label>${t("receipt.web_url")}</label><input id="rc-url" value="${rc.web_url}" placeholder="http://192.168.1.20:8080"></div>
            <div class="row">
              <label class="row"><input type="checkbox" id="rc-chart" ${rc.show_chart ? "checked" : ""}> ${t("receipt.show_chart")}</label>
              <label class="row"><input type="checkbox" id="rc-qr" ${rc.show_qr ? "checked" : ""}> ${t("receipt.show_qr")}</label>
            </div>
            <div class="row"><button class="btn primary sm" id="rc-save">${t("printer.save")}</button></div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${t("receipt.preview")}</h2>${lastId ? `<a class="btn sm ghost" href="api/shots/${lastId}/receipt.png" target="_blank" rel="noopener">PNG</a>` : ""}</div>
          ${lastId ? `<img id="rc-preview" class="receipt-preview" src="api/shots/${lastId}/receipt.png?ts=${Date.now()}" alt="">` : `<p class="empty">${t("now.none")}</p>`}
        </section>
      </div>` : ""}`;
    view.querySelector("#rc-save")?.addEventListener("click", async () => {
      try {
        await api.updatePrinter({
          cafe_name: view.querySelector("#rc-name").value,
          cafe_tagline: view.querySelector("#rc-tagline").value,
          thanks: view.querySelector("#rc-thanks").value,
          greetings: view.querySelector("#rc-greetings").value,
          web_url: view.querySelector("#rc-url").value,
          show_chart: view.querySelector("#rc-chart").checked,
          show_qr: view.querySelector("#rc-qr").checked,
        });
        toast(t("printer.saved"));
        const img = view.querySelector("#rc-preview");
        if (img) img.src = img.src.replace(/\?ts=\d+/, "?ts=" + Date.now());
      } catch (err) { toast(String(err.message), "bad"); }
    });
    view.querySelector("#scale-scan")?.addEventListener("click", async () => {
      try { await api.scanScales(); toast(t("scale.scanning")); setTimeout(load, 6000); } catch (err) { toast(String(err.message), "bad"); }
    });
    view.querySelectorAll("[data-scale]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await api.connectScale(b.dataset.scale); toast(t("scale.connecting")); setTimeout(load, 4000); } catch (err) { toast(String(err.message), "bad"); b.disabled = false; }
    }));
    view.querySelector("#printer-scan")?.addEventListener("click", async (e) => {
      const button = e.currentTarget; button.disabled = true; button.textContent = t("printer.scanning");
      try {
        const found = await api.scanPrinters();
        const box = view.querySelector("#printer-found");
        box.innerHTML = found.devices.length ? `<div class="list">${found.devices.slice(0, 12).map((d) => `
          <div class="row spread" style="padding:6px 0;border-top:1px solid var(--line)">
            <span><b>${d.name || "?"}</b> <span class="faint small num">${d.address} · ${d.rssi ?? "–"} dBm</span>${d.printer_like ? ` <span class="pill accent">${t("printer.likely")}</span>` : ""}</span>
            <button class="btn sm" data-use="${d.address}">${t("printer.use")}</button>
          </div>`).join("")}</div>` : `<p class="faint small">${t("printer.none_found")}</p>`;
        box.querySelectorAll("[data-use]").forEach((u) => (u.onclick = () => { view.querySelector("#printer-mac").value = u.dataset.use; }));
      } catch (err) { toast(String(err.message), "bad"); }
      button.disabled = false; button.textContent = t("printer.scan");
    });
    view.querySelector("#printer-save")?.addEventListener("click", async () => {
      try {
        await api.updatePrinter({
          mac: view.querySelector("#printer-mac").value,
          print_each_shot: view.querySelector("#printer-auto").checked,
          lang: view.querySelector("#printer-lang").value,
          intensity: Number(view.querySelector("#printer-intensity").value),
        });
        toast(t("printer.saved")); load();
      } catch (err) { toast(String(err.message), "bad"); }
    });
    view.querySelector("#printer-test")?.addEventListener("click", async (e) => {
      const button = e.currentTarget; button.disabled = true;
      try { const r = await api.testPrint(); toast(r.completed ? t("printer.printed") : t("printer.printed_unconfirmed")); } catch (err) { toast(t("printer.failed") + " " + err.message, "bad"); }
      button.disabled = false;
    });
    view.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => { range = b.dataset.r; localStorage.setItem("machine.range", range); load(); }));
    if (destroy) destroy();
    destroy = state.samples.length ? machineChart(view.querySelector("#chart"), state.samples, state.shots, state.sessions, state.events || []) : null;
  };
  await load();
  return () => destroy && destroy();
}
