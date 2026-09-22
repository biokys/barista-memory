import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { toast } from "../lib/fmt.js";

/**
 * Everything that is configured rather than observed: the receipt printer,
 * what the receipt says, and the machine's Bluetooth scale. Kept off the
 * Machine page so that one stays a reading, not a form.
 */
export async function renderSettings(view) {
  const load = async () => {
    const [printer, scales, latest] = await Promise.all([
      api.printer().catch(() => null),
      api.scales().catch(() => null),
      api.shots({ limit: 1 }).catch(() => ({ shots: [] })),
    ]);
    const ps = printer?.settings;
    const rc = ps?.receipt;
    const lastId = latest.shots?.[0]?.id ?? null;
    view.innerHTML = `
      <h1>${t("settings.title")}</h1>
      <p class="muted" style="max-width:70ch">${t("settings.hint")}</p>
      <div class="grid cols-2 settings-grid">
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
      </div>` : ""};
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
  };
  await load();
}
