import type Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import { TOOLS, callTool } from "../mcp/tools.js";

/**
 * The assistant's tools are the MCP's, adapted to the Messages API shape
 * (only the schema field is spelled differently) and filtered. The web UI
 * has no login, and the chat sits on it, so tools that change the machine
 * or rewrite the archive wholesale are not offered to the model at all —
 * a description that says "the assistant may not" is a request, an absent
 * tool is a fact.
 */
const WITHHELD = new Set([
  "save_profile",
  "select_profile",
  "set_machine_mode",
  "import_setup_card",
  "recompute_stable_weights",
  "recompute_machine_context",
  "ingest_now",
]);

export const ASSISTANT_TOOLS: Anthropic.Tool[] = TOOLS.filter((tool) => !WITHHELD.has(tool.name)).map((tool) => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
}));

const ALLOWED = new Set(ASSISTANT_TOOLS.map((tool) => tool.name));

/**
 * Longest tool result handed to the model. A full curve is a few hundred
 * samples and fits; a runaway query does not, and the cut is announced
 * rather than silent so the model knows the JSON is incomplete.
 */
const RESULT_MAX_CHARS = 200_000;

export interface AssistantToolOutcome {
  text: string;
  isError: boolean;
}

export async function runAssistantTool(db: DatabaseSync, name: string, input: unknown): Promise<AssistantToolOutcome> {
  if (!ALLOWED.has(name)) {
    return { text: JSON.stringify({ error: true, code: "TOOL_WITHHELD", message: `${name} is not available to the assistant` }), isError: true };
  }
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const result = await callTool(db, name, args);
  let text = result.content[0].text;
  if (text.length > RESULT_MAX_CHARS) text = text.slice(0, RESULT_MAX_CHARS) + `\n[truncated: ${text.length} characters in total; ask with a smaller limit]`;
  return { text, isError: result.isError === true };
}
