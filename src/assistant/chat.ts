import Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { currentSetup } from "../db/db.js";
import { printerSettings } from "../printer/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { ASSISTANT_TOOLS, runAssistantTool } from "./tools.js";
import { appendMessage, getConversation, messagesFor, recordUsage, usageOf, addUsage, estimateCostUsd, NO_USAGE, type TokenUsage } from "./conversations.js";

/**
 * One turn of the chat: the user's words go in, the assistant's text
 * streams out, and any tools it calls run here against the archive. The
 * loop is the plain one — stream, run the tool calls, stream again — with
 * no beta dependency, so it works on any current Claude model.
 */

export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "done"; usage: TokenUsage; cost_usd: number | null }
  | { type: "error"; code: string; message: string };

/** A turn stops here even if the model keeps asking for tools: a loop, not a conversation. */
const MAX_TOOL_ROUNDS = 12;
/** Chat answers are short; the ceiling only matters when a turn goes wrong. */
const MAX_OUTPUT_TOKENS = 16_000;

let client: Anthropic | null = null;
export function anthropicClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 });
  return client;
}

export function assistantEnabled(): boolean {
  return config.anthropicApiKey.length > 0;
}

/** Conversations with a turn in flight: a second message to the same one is refused, not queued. */
const busy = new Set<number>();

export interface TurnContext {
  shotId: number | null;
  lang: "cs" | "en";
}

/**
 * The line that varies per turn, kept out of the system prompt so the
 * cached prefix stays byte-identical: when it is, what the user is looking
 * at, which languages apply, and the context in force.
 */
function contextLine(db: DatabaseSync, ctx: TurnContext): string {
  const when = new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
  const setup = currentSetup(db);
  const inForce = setup
    ? [setup.bean, setup.roaster, setup.grind_setting != null ? `grind ${setup.grind_setting}` : null, setup.dose_g != null ? `dose ${setup.dose_g} g` : null].filter(Boolean).join(", ") || "recorded without values"
    : "none recorded";
  return [
    `Context: now ${when} (server time).`,
    ctx.shotId != null ? `The user is looking at shot #${ctx.shotId}.` : "No shot is open; the user asks from the assistant page.",
    `UI language: ${ctx.lang}. Receipt language: ${printerSettings(db).lang}.`,
    `Setup in force: ${inForce}.`,
  ].join(" ");
}

export async function runTurn(
  db: DatabaseSync,
  conversationId: number,
  userText: string,
  ctx: TurnContext,
  emit: (event: AssistantEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const conversation = getConversation(db, conversationId);
  if (!conversation) { emit({ type: "error", code: "CONVERSATION_NOT_FOUND", message: `No conversation ${conversationId}` }); return; }
  if (busy.has(conversationId)) { emit({ type: "error", code: "CONVERSATION_BUSY", message: "This conversation is still answering" }); return; }
  busy.add(conversationId);
  try {
    const messages: Anthropic.MessageParam[] = messagesFor(db, conversationId).map((m) => ({ role: m.role, content: m.content }));
    const userContent: Anthropic.ContentBlockParam[] = [
      { type: "text", text: contextLine(db, ctx) },
      { type: "text", text: userText },
    ];
    messages.push({ role: "user", content: userContent });
    appendMessage(db, conversationId, "user", userContent, userText);

    let usage = NO_USAGE;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = anthropicClient().messages.stream(
        {
          model: config.assistantModel,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [{ type: "text", text: SYSTEM_PROMPT }],
          tools: ASSISTANT_TOOLS,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: config.assistantEffort },
          // Caches tools, the system prompt and the whole history up to the
          // last block: every later turn pays full price only for what is new.
          cache_control: { type: "ephemeral" },
        },
        { signal }
      );
      stream.on("text", (delta) => emit({ type: "text", text: delta }));
      const message = await stream.finalMessage();
      usage = addUsage(usage, usageOf(message.usage));

      // Stored whole, thinking blocks included: they must go back unchanged
      // when the turn continues after a tool call.
      messages.push({ role: "assistant", content: message.content });
      appendMessage(db, conversationId, "assistant", message.content as Anthropic.ContentBlockParam[], null);

      if (message.stop_reason === "refusal") {
        emit({ type: "error", code: "REFUSED", message: message.stop_details?.explanation ?? "The model declined to answer" });
        break;
      }
      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        if (message.stop_reason === "max_tokens") emit({ type: "error", code: "TRUNCATED", message: "The answer was cut off at the output limit" });
        break;
      }
      if (round === MAX_TOOL_ROUNDS) {
        emit({ type: "error", code: "TOO_MANY_TOOLS", message: `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls` });
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        emit({ type: "tool", name: use.name, input: use.input });
        const outcome = await runAssistantTool(db, use.name, use.input);
        emit({ type: "tool_result", name: use.name, ok: !outcome.isError });
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.text, is_error: outcome.isError || undefined });
      }
      messages.push({ role: "user", content: results });
      appendMessage(db, conversationId, "user", results, null);
    }

    recordUsage(db, conversationId, "chat", config.assistantModel, usage);
    emit({ type: "done", usage, cost_usd: estimateCostUsd(config.assistantModel, usage) });
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError) return; // the browser went away; nothing to tell it
    const message = error instanceof Error ? error.message : String(error);
    console.error(`assistant: conversation ${conversationId}: ${message}`);
    emit({ type: "error", code: error instanceof Anthropic.AuthenticationError ? "BAD_API_KEY" : error instanceof Anthropic.RateLimitError ? "RATE_LIMITED" : "ASSISTANT_FAILED", message });
  } finally {
    busy.delete(conversationId);
  }
}
