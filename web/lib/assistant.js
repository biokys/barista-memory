import { t, currentLang } from "./i18n.js";
import { api } from "./api.js";

/**
 * The chat with the assistant, mounted into any container: on the shot page
 * bound to that shot, on the assistant page free-standing. The answer
 * streams in as Server-Sent Events; tool calls show as small grey lines so
 * it is visible what the assistant looked at.
 */

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The little markdown the assistant is asked to use: paragraphs, lists, bold, code. */
export function renderMarkdown(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  return String(text ?? "").split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) return "";
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

const toolLabel = (name) => name.replace(/_/g, " ");

function bubble(role, html) {
  return `<div class="msg ${role}"><div class="msg-body">${html}</div></div>`;
}

export function mountChat(container, { shotId = null, conversationId = null, onToolDone = null } = {}) {
  let convId = conversationId;
  let busy = false;
  container.innerHTML = `
    <div class="chat">
      <div class="chat-log"></div>
      <form class="chat-form">
        <textarea rows="1" placeholder="${esc(shotId != null ? t("ask.placeholder_shot", { id: shotId }) : t("ask.placeholder"))}"></textarea>
        <button class="btn primary sm" type="submit">${t("ask.send")}</button>
      </form>
    </div>`;
  const log = container.querySelector(".chat-log");
  const form = container.querySelector(".chat-form");
  const input = container.querySelector("textarea");
  const button = container.querySelector("button");
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  const renderTools = (tools) => tools.map((x) => `<div class="tool ${x.ok === false ? "bad" : ""}">${esc(x.ok == null ? t("ask.tool_running", { name: toolLabel(x.name) }) : x.ok ? t("ask.tool_done", { name: toolLabel(x.name) }) : t("ask.tool_failed", { name: toolLabel(x.name) }))}</div>`).join("");

  async function load() {
    if (convId == null) { log.innerHTML = `<p class="empty small">${t("ask.none")}</p>`; return; }
    try {
      const { messages } = await api.conversation(convId);
      log.innerHTML = messages.length
        ? messages.map((m) => (m.role === "user" ? bubble("user", `<p>${esc(m.text).replace(/\n/g, "<br>")}</p>`) : bubble("assistant", renderTools(m.tools.map((x) => ({ ...x, ok: true }))) + renderMarkdown(m.text)))).join("")
        : `<p class="empty small">${t("ask.none")}</p>`;
      scroll();
    } catch (err) {
      log.innerHTML = `<p class="faint small">${esc(err.message)}</p>`;
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; button.disabled = true; input.value = ""; input.style.height = "";
    log.querySelector(".empty")?.remove();
    log.insertAdjacentHTML("beforeend", bubble("user", `<p>${esc(text).replace(/\n/g, "<br>")}</p>`));
    log.insertAdjacentHTML("beforeend", bubble("assistant", `<p class="faint">${t("ask.working")}</p>`));
    const body = log.lastElementChild.querySelector(".msg-body");
    scroll();
    let answer = "";
    const tools = [];
    const repaint = () => { body.innerHTML = renderTools(tools) + (answer ? renderMarkdown(answer) : `<p class="faint">${t("ask.working")}</p>`); scroll(); };
    try {
      if (convId == null) {
        const created = await api.createConversation(shotId != null ? { shot_id: shotId } : {});
        convId = created.id;
        container.dispatchEvent(new CustomEvent("conversation", { detail: created }));
      }
      await api.streamMessage(convId, { text, shot_id: shotId, lang: currentLang() }, (ev) => {
        if (ev.type === "text") { answer += ev.text; repaint(); }
        else if (ev.type === "tool") { tools.push({ name: ev.name, ok: null }); repaint(); }
        else if (ev.type === "tool_result") { const x = [...tools].reverse().find((y) => y.name === ev.name && y.ok == null); if (x) x.ok = ev.ok; repaint(); if (ev.ok && onToolDone) onToolDone(ev.name); }
        else if (ev.type === "error") { body.insertAdjacentHTML("beforeend", `<p class="bad small">${esc(ev.message)}</p>`); }
        else if (ev.type === "done") { if (!answer && !tools.length) body.innerHTML = `<p class="faint">${t("ask.error")}</p>`; container.dispatchEvent(new CustomEvent("turn", { detail: ev })); }
      });
    } catch (err) {
      body.innerHTML = renderTools(tools) + renderMarkdown(answer) + `<p class="bad small">${esc(err.message)}</p>`;
    }
    busy = false; button.disabled = false; input.focus();
  }

  form.onsubmit = (e) => { e.preventDefault(); send(); };
  // Enter sends, Shift+Enter breaks the line; the box grows with the text.
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  input.oninput = () => { input.style.height = ""; input.style.height = Math.min(160, input.scrollHeight) + "px"; };
  load();

  return {
    setConversation(id) { convId = id; load(); },
    conversationId() { return convId; },
  };
}
