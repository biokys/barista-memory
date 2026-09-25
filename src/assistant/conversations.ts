import type Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";

/**
 * Conversations and their messages, stored as the API sees them so a
 * thread continues from any browser and the MCP can read it later.
 */

export interface ConversationRow {
  id: number;
  shot_id: number | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: Anthropic.ContentBlockParam[];
  text: string | null;
  created_at: number;
}

/** What the UI shows: the user's words, the assistant's text and which tools it used. */
export interface DisplayMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools: Array<{ name: string; input: unknown }>;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export function listConversations(db: DatabaseSync, shotId: number | null | undefined, limit = 30): ConversationRow[] {
  const sql = shotId != null
    ? "SELECT * FROM conversations WHERE shot_id = ? ORDER BY updated_at DESC LIMIT ?"
    : "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?";
  return (shotId != null ? db.prepare(sql).all(shotId, limit) : db.prepare(sql).all(limit)) as unknown as ConversationRow[];
}

export function getConversation(db: DatabaseSync, id: number): ConversationRow | null {
  return (db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined) ?? null;
}

export function createConversation(db: DatabaseSync, shotId: number | null): ConversationRow {
  if (shotId != null && !db.prepare("SELECT 1 FROM shots WHERE id = ?").get(shotId)) throw new Error(`Shot ${shotId} is not in the archive`);
  const t = now();
  const { lastInsertRowid } = db.prepare("INSERT INTO conversations (shot_id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)").run(shotId, t, t);
  return getConversation(db, Number(lastInsertRowid))!;
}

export function deleteConversation(db: DatabaseSync, id: number): boolean {
  return db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
}

export function messagesFor(db: DatabaseSync, conversationId: number): StoredMessage[] {
  const rows = db.prepare("SELECT id, role, content, text, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY id").all(conversationId) as unknown as Array<Omit<StoredMessage, "content"> & { content: string }>;
  return rows.map((row) => ({ ...row, content: JSON.parse(row.content) as Anthropic.ContentBlockParam[] }));
}

/** The first user message, shortened, becomes the title of a thread that has none. */
const TITLE_MAX_CHARS = 60;

export function appendMessage(db: DatabaseSync, conversationId: number, role: "user" | "assistant", content: Anthropic.ContentBlockParam[], text: string | null): StoredMessage {
  const t = now();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO conversation_messages (conversation_id, role, content, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, role, JSON.stringify(content), text, t);
  db.prepare("UPDATE conversations SET updated_at = ?, title = COALESCE(title, ?) WHERE id = ?").run(
    t,
    role === "user" && text ? (text.length > TITLE_MAX_CHARS ? text.slice(0, TITLE_MAX_CHARS - 1) + "…" : text) : null,
    conversationId
  );
  return { id: Number(lastInsertRowid), role, content, text, created_at: t };
}

/** Messages as the UI shows them: tool results are folded into the assistant's turn that asked for them. */
export function displayMessages(messages: StoredMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      // A user row without text carries tool results; the UI shows the call, not the payload.
      if (m.text == null) continue;
      out.push({ id: m.id, role: "user", text: m.text, tools: [], created_at: m.created_at });
      continue;
    }
    const text = m.content.filter((b): b is Anthropic.TextBlockParam => b.type === "text").map((b) => b.text).join("");
    const tools = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input }));
    // Several assistant rows make one turn when tools were used; merge them so the UI shows one answer.
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      last.text = [last.text, text].filter(Boolean).join("\n\n");
      last.tools.push(...tools);
      last.created_at = m.created_at;
    } else {
      out.push({ id: m.id, role: "assistant", text, tools, created_at: m.created_at });
    }
  }
  return out;
}

// ---- usage -----------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

export function usageOf(usage: Anthropic.Usage | Anthropic.MessageDeltaUsage): TokenUsage {
  return {
    input_tokens: usage.input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export const NO_USAGE: TokenUsage = { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 };

export function recordUsage(db: DatabaseSync, conversationId: number | null, purpose: "chat" | "caption", model: string, usage: TokenUsage): void {
  db.prepare(
    "INSERT INTO assistant_usage (conversation_id, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(conversationId, purpose, model, usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.output_tokens, now());
}

/**
 * List prices in USD per million tokens, from the Anthropic price list as of
 * 2026-06; cache reads are a tenth of input, cache writes a quarter more.
 * A model not listed here shows token counts and no money.
 */
const PRICE_PER_MTOK: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: "claude-opus-5-5", input: 4, output: 20 },
  { prefix: "claude-opus-5", input: 5, output: 25 },
  { prefix: "claude-opus-4", input: 5, output: 25 },
  { prefix: "claude-sonnet-5", input: 2, output: 10 },
  { prefix: "claude-sonnet-4", input: 3, output: 15 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5 },
  { prefix: "claude-fable-5", input: 10, output: 50 },
];

export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICE_PER_MTOK.find((p) => model.startsWith(p.prefix));
  if (!price) return null;
  const perTok = (usd: number) => usd / 1_000_000;
  return (
    usage.input_tokens * perTok(price.input) +
    usage.cache_read_tokens * perTok(price.input) * 0.1 +
    usage.cache_write_tokens * perTok(price.input) * 1.25 +
    usage.output_tokens * perTok(price.output)
  );
}

export interface UsageWindow {
  calls: number;
  usage: TokenUsage;
  cost_usd: number | null;
}

function windowSince(db: DatabaseSync, since: number): UsageWindow {
  const rows = db
    .prepare("SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(cache_read_tokens) AS r, SUM(cache_write_tokens) AS w, SUM(output_tokens) AS o FROM assistant_usage WHERE created_at >= ? GROUP BY model")
    .all(since) as unknown as Array<{ model: string; calls: number; i: number; r: number; w: number; o: number }>;
  let calls = 0, usage = NO_USAGE, cost: number | null = 0;
  for (const row of rows) {
    const u = { input_tokens: row.i, cache_read_tokens: row.r, cache_write_tokens: row.w, output_tokens: row.o };
    calls += row.calls;
    usage = addUsage(usage, u);
    const c = estimateCostUsd(row.model, u);
    cost = cost == null || c == null ? null : cost + c;
  }
  return { calls, usage, cost_usd: cost };
}

/** Today and the last 30 days, in the server's local time. */
export function usageSummary(db: DatabaseSync): { today: UsageWindow; month: UsageWindow } {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const t = now();
  return { today: windowSince(db, Math.floor(startOfDay.getTime() / 1000)), month: windowSince(db, t - 30 * 86400) };
}
