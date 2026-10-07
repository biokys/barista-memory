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

/**
 * A proposed profile as a card: what the assistant would save, and the
 * button that saves it. The assistant has no save tool; propose_profile
 * returns the merged profile, and only this click writes to the machine.
 */
function proposalCard(proposal, key) {
  const prof = proposal.profile;
  const pump = (ph) => (ph.pump?.target === "flow" ? `${ph.pump.flow} ml/s` : `${ph.pump?.pressure ?? "–"} bar`);
  const exits = (ph) => (ph.targets || []).map((e) => `${e.type} ${e.operator === "lte" ? "≤" : "≥"} ${e.value}`).join(", ");
  return `<div class="proposal" data-key="${esc(key)}">
    <div class="row spread"><b>${esc(prof.label)}</b><span class="pill ${proposal.action === "created" ? "accent" : ""}">${t(proposal.action === "created" ? "ask.proposal_create" : "ask.proposal_update")}</span></div>
    <div class="small muted">${prof.temperature} °C · ${esc(prof.type)}${prof.utility ? " · utility" : ""}${prof.description ? `<br>${esc(prof.description)}` : ""}</div>
    <table><tbody>${(prof.phases || []).map((ph, i) => `<tr><td>${i + 1}. ${esc(ph.name)}</td><td class="faint">${esc(ph.phase)}</td><td class="num">${pump(ph)}</td><td class="num">${ph.duration} s</td><td class="faint">${esc(exits(ph))}${ph.valve === 0 ? ` · ${t("ask.proposal_valve_closed")}` : ""}</td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:8px"><button class="btn primary sm" data-save>${t("ask.proposal_save")}</button><button class="btn sm" data-save data-select>${t("ask.proposal_save_select")}</button><span class="small faint" data-status></span></div>
  </div>`;
}

/** The message the click sends on the user's behalf, so the assistant knows the profile is on the machine. */
const savedMessage = (label) => t("ask.profile_saved_msg", { label });

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

  // Proposals by card key, for the click that saves one.
  const proposals = new Map();
  const renderTools = (tools, prefix) => tools.map((x, i) => {
    const line = `<div class="tool ${x.ok === false ? "bad" : ""}">${esc(x.ok == null ? t("ask.tool_running", { name: toolLabel(x.name) }) : x.ok ? t("ask.tool_done", { name: toolLabel(x.name) }) : t("ask.tool_failed", { name: toolLabel(x.name) }))}</div>`;
    const proposal = x.result?.proposal;
    if (!proposal?.profile) return line;
    const key = `${prefix}-${i}`;
    proposals.set(key, proposal);
    return line + proposalCard(proposal, key);
  }).join("");

  const markSaved = (card) => {
    card.classList.add("saved");
    card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    card.querySelector("[data-status]").textContent = t("ask.proposal_saved");
  };

  async function load() {
    if (convId == null) { log.innerHTML = `<p class="empty small">${t("ask.none")}</p>`; return; }
    try {
      const { messages } = await api.conversation(convId);
      log.innerHTML = messages.length
        ? messages.map((m, mi) => (m.role === "user" ? bubble("user", `<p>${esc(m.text).replace(/\n/g, "<br>")}</p>`) : bubble("assistant", renderTools(m.tools.map((x) => ({ ...x, ok: true })), `m${mi}`) + renderMarkdown(m.text)))).join("")
        : `<p class="empty small">${t("ask.none")}</p>`;
      // A proposal the user already saved: the click left its message in the thread.
      log.querySelectorAll(".proposal").forEach((card) => {
        const mi = Number(card.dataset.key.slice(1).split("-")[0]);
        const label = proposals.get(card.dataset.key)?.profile?.label;
        if (messages.slice(mi + 1).some((m) => m.role === "user" && m.text === savedMessage(label))) markSaved(card);
      });
      scroll();
    } catch (err) {
      log.innerHTML = `<p class="faint small">${esc(err.message)}</p>`;
    }
  }

  log.addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-save]");
    if (!button) return;
    const card = button.closest(".proposal");
    const proposal = proposals.get(card.dataset.key);
    if (!proposal || busy) return;
    const prof = proposal.profile;
    const spec = { label: prof.label, temperature: prof.temperature, phases: prof.phases, type: prof.type, description: prof.description, favorite: prof.favorite, utility: prof.utility };
    const status = card.querySelector("[data-status]");
    card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    status.textContent = t("ask.working");
    try {
      const saved = prof.id ? await api.saveProfile(prof.id, spec) : await api.createProfile(spec);
      if (button.hasAttribute("data-select")) await api.selectProfile(saved.profile.id);
      markSaved(card);
      send(savedMessage(saved.profile.label));
    } catch (err) {
      status.textContent = err.message;
      card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  });

  async function send(given) {
    const text = (given ?? input.value).trim();
    if (!text || busy) return;
    busy = true; button.disabled = true; input.value = ""; input.style.height = "";
    log.querySelector(".empty")?.remove();
    log.insertAdjacentHTML("beforeend", bubble("user", `<p>${esc(text).replace(/\n/g, "<br>")}</p>`));
    log.insertAdjacentHTML("beforeend", bubble("assistant", `<p class="faint">${t("ask.working")}</p>`));
    const body = log.lastElementChild.querySelector(".msg-body");
    scroll();
    let answer = "";
    const tools = [];
    const prefix = `live${Date.now()}`;
    const repaint = () => { body.innerHTML = renderTools(tools, prefix) + (answer ? renderMarkdown(answer) : `<p class="faint">${t("ask.working")}</p>`); scroll(); };
    try {
      if (convId == null) {
        const created = await api.createConversation(shotId != null ? { shot_id: shotId } : {});
        convId = created.id;
        container.dispatchEvent(new CustomEvent("conversation", { detail: created }));
      }
      await api.streamMessage(convId, { text, shot_id: shotId, lang: currentLang() }, (ev) => {
        if (ev.type === "text") { answer += ev.text; repaint(); }
        else if (ev.type === "tool") { tools.push({ name: ev.name, ok: null }); repaint(); }
        else if (ev.type === "tool_result") { const x = [...tools].reverse().find((y) => y.name === ev.name && y.ok == null); if (x) { x.ok = ev.ok; x.result = ev.data; } repaint(); if (ev.ok && onToolDone) onToolDone(ev.name); }
        else if (ev.type === "error") { body.insertAdjacentHTML("beforeend", `<p class="bad small">${esc(ev.message)}</p>`); }
        else if (ev.type === "done") { if (!answer && !tools.length) body.innerHTML = `<p class="faint">${t("ask.error")}</p>`; container.dispatchEvent(new CustomEvent("turn", { detail: ev })); }
      });
    } catch (err) {
      body.innerHTML = renderTools(tools, prefix) + renderMarkdown(answer) + `<p class="bad small">${esc(err.message)}</p>`;
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
