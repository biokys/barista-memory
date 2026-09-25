import { t } from "../lib/i18n.js";
import { api } from "../lib/api.js";
import { fmt, toast } from "../lib/fmt.js";
import { mountChat, esc } from "../lib/assistant.js";

/**
 * The assistant on its own page: earlier threads on the left, the chat on
 * the right. Threads started from a shot page appear here too, with a link
 * back to the shot.
 */
export async function renderAsk(view) {
  const status = await api.assistantStatus();
  if (!status.enabled) {
    view.innerHTML = `
      <h1>${t("ask.title")}</h1>
      <section class="card"><p class="muted">${t("ask.off_title")}</p><p class="faint small" style="margin-top:8px">${t("ask.off_hint")}</p></section>`;
    return;
  }
  view.innerHTML = `
    <div class="row spread"><h1>${t("ask.title")}</h1><button class="btn sm" id="new">${t("ask.new")}</button></div>
    <p class="muted" style="max-width:70ch">${t("ask.hint")}</p>
    <div class="ask-layout">
      <aside class="card conv-list" id="list"></aside>
      <section class="card chat-card" id="chat"></section>
    </div>`;
  const list = view.querySelector("#list");
  const chat = mountChat(view.querySelector("#chat"));
  let active = null;

  async function loadList() {
    const { conversations } = await api.conversations();
    list.innerHTML = conversations.length
      ? conversations.map((c) => `
        <div class="conv-row ${c.id === active ? "active" : ""}" data-id="${c.id}">
          <div class="conv-main"><b>${esc(c.title || t("ask.untitled"))}</b><span class="faint small">${fmt.date(c.updated_at)}${c.shot_id ? ` · <a href="#/shots/${c.shot_id}">${t("ask.shot_link", { id: c.shot_id })}</a>` : ""}</span></div>
          <button class="btn sm ghost" data-del="${c.id}" title="${t("ask.delete")}">×</button>
        </div>`).join("")
      : `<p class="empty small">${t("ask.none")}</p>`;
    list.querySelectorAll(".conv-row").forEach((row) => (row.onclick = (e) => {
      if (e.target.closest("[data-del]") || e.target.closest("a")) return;
      active = Number(row.dataset.id); chat.setConversation(active); loadList();
    }));
    list.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm(t("ask.delete_confirm"))) return;
      await api.deleteConversation(Number(b.dataset.del));
      if (active === Number(b.dataset.del)) { active = null; chat.setConversation(null); }
      loadList();
    }));
  }

  view.querySelector("#new").onclick = () => { active = null; chat.setConversation(null); loadList(); };
  view.querySelector("#chat").addEventListener("conversation", (e) => { active = e.detail.id; loadList(); });
  view.querySelector("#chat").addEventListener("turn", (e) => {
    loadList();
    if (e.detail.cost_usd != null) toast(t("ask.cost", { cost: e.detail.cost_usd.toFixed(3) }));
  });
  await loadList();
}
