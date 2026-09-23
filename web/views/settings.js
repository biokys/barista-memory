import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { toast } from "../lib/fmt.js";

/**
 * Everything that is configured rather than observed: the receipt printer
 * and what the receipt says. Kept off the Machine page so that one stays a
 * reading, not a form.
 */
export async function renderSettings(view) {
  const load = async () => {
    const [printer, latest] = await Promise.all([
      api.printer().catch(() => null),
      api.shots({ limit: 1 }).catch(() => ({ shots: [] })),
    ]);
    const ps = printer?.settings;
    const rc = ps?.receipt;
    const lastId = latest.shots?.[0]?.id ?? null;
    view.innerHTML = `
      <h1>${t("settings.title")}</h1>
      <p class="muted" style="max-width:70ch">${t("settings.hint")}</p>
      <div class="cols">
        <div class="col">
        <section class="card">
          <div class="card-head"><h2>${t("printer.title")}</h2><span class="row">${ps?.mac ? `<button class="btn sm ghost" id="printer-status">${t("printer.status")}</button><button class="btn sm ghost" id="printer-test">${t("printer.test")}</button>` : ""}</span></div>
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
        ${rc ? `<section class="card">
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
        </section>` : ""}
        </div>
        <div class="col">
        ${rc ? `<section class="card">
          <div class="card-head"><h2>${t("receipt.preview")}</h2>${lastId ? `<a class="btn sm ghost" href="api/shots/${lastId}/receipt.png" target="_blank" rel="noopener">PNG</a>` : ""}</div>
          ${lastId ? `<img id="rc-preview" class="receipt-preview" src="api/shots/${lastId}/receipt.png?ts=${Date.now()}" alt="">` : `<p class="empty">${t("now.none")}</p>`}
        </section>` : ""}
        </div>
      </div>
      <section class="card">
        <div class="card-head"><h2>${t("transfer.title")}</h2><a class="btn sm ghost" href="api/export">${t("transfer.export")}</a></div>
        <p class="muted small" style="max-width:70ch">${t("transfer.hint")}</p>
        <div class="row" style="margin-top:10px"><input type="file" id="import-file" accept=".db,application/vnd.sqlite3,application/octet-stream"><button class="btn sm" id="import-go">${t("transfer.import")}</button></div>
      </section>`;
    view.querySelector("#import-go")?.addEventListener("click", async (e) => {
      const file = view.querySelector("#import-file").files[0];
      if (!file) return;
      if (!confirm(t("transfer.confirm", { name: file.name }))) return;
      const button = e.currentTarget; button.disabled = true;
      try {
        const r = await api.importArchive(file);
        toast(t("transfer.done", { shots: r.counts.shots }));
        setTimeout(() => location.reload(), 1200);
      } catch (err) { toast(t("transfer.failed") + " " + err.message, "bad"); button.disabled = false; }
    });
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
        box.querySelectorAll("[data-use]").forEach((u) => (u.onclick = () => { view.querySelector("#printer-mac").value = u.dataset.use; box.innerHTML = ""; }));
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
    view.querySelector("#printer-status")?.addEventListener("click", async (e) => {
      const button = e.currentTarget; button.disabled = true; button.textContent = t("printer.checking");
      try {
        const r = await api.printerStatus();
        toast(t("printer.status_line", { battery: r.status.battery ?? "?", ready: r.status.ready ? t("printer.ready") : t("printer.not_ready") }));
      } catch (err) { toast(t("printer.failed") + " " + err.message, "bad"); }
      button.disabled = false; button.textContent = t("printer.status");
    });
    view.querySelector("#printer-test")?.addEventListener("click", async (e) => {
      const button = e.currentTarget; button.disabled = true;
      try { const r = await api.testPrint(); toast(r.completed ? t("printer.printed") : t("printer.printed_unconfirmed")); } catch (err) { toast(t("printer.failed") + " " + err.message, "bad"); }
      button.disabled = false;
    });
  };
  await load();
}
