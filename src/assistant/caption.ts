import Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { loadArchivedShot } from "../shots.js";
import { verdictFor } from "../dialin.js";
import { getAnalysis } from "../anomaly.js";
import { eraOf } from "../events.js";
import { printerSettings } from "../printer/index.js";
import { setCaption, CAPTION_MAX_CHARS, type Caption } from "../captions.js";
import { CAPTION_PROMPT } from "./prompt.js";
import { anthropicClient, assistantEnabled } from "./chat.js";
import { recordUsage, usageOf } from "./conversations.js";

/**
 * A receipt caption from the assistant: one call with the shot's facts in
 * and a JSON object out, no tools. Kept apart from the chat loop on
 * purpose — the daemon calls this right before an automatic print, so it
 * has to be quick, bounded and easy to skip when the cloud is not there.
 */

export type CaptionResult = { ok: true; caption: Caption } | { ok: false; code: "ASSISTANT_OFF" | "SHOT_NOT_FOUND" | "REFUSED" | "BAD_OUTPUT" | "CAPTION_FAILED"; message: string };

/** How long the daemon waits for a caption before printing without one. */
export const AUTO_CAPTION_TIMEOUT_MS = 20_000;

/** Earlier shots of the same coffee the caption may compare with. */
const PRIOR_SHOTS = 4;

function factsFor(db: DatabaseSync, shotId: number) {
  const loaded = loadArchivedShot(db, shotId, false);
  if (!loaded) return null;
  const c = loaded.context;
  const s = loaded.shot?.summary;
  const prior = c.coffee_id != null
    ? db.prepare("SELECT id, started_at, duration_ms, ratio, rating, grind_setting, dose_g FROM shot_context WHERE coffee_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT ?").all(c.coffee_id, c.started_at, PRIOR_SHOTS)
    : [];
  return {
    shot_id: c.id,
    when: new Date(c.started_at * 1000).toISOString(),
    bean: c.bean, roaster: c.roaster, roast_date: c.roast_date,
    shots_of_this_coffee_before: prior.length,
    grind_setting: c.grind_setting, dose_g: c.dose_g,
    cup_g: c.stable_weight_g, ratio: c.ratio,
    duration_s: c.duration_ms != null ? Math.round(c.duration_ms / 100) / 10 : null,
    preinfusion_s: s?.extraction?.preinfusion_time_seconds ?? null,
    temperature_avg_c: s?.temperature?.average_celsius ?? null,
    peak_pressure_bar: s?.pressure?.max_bar ?? null,
    machine_settledness_pct: c.machine_settledness,
    rating: c.rating, taste_note: c.taste_note,
    era: eraOf(db, c.started_at)?.title ?? null,
    verdict: verdictFor(db, c),
    analysis_flags: getAnalysis(db, c.id)?.flags ?? [],
    previous_shots_same_coffee: prior,
  };
}

export async function suggestCaption(db: DatabaseSync, shotId: number, options: { timeoutMs?: number } = {}): Promise<CaptionResult> {
  if (!assistantEnabled()) return { ok: false, code: "ASSISTANT_OFF", message: "No Anthropic API key configured" };
  const facts = factsFor(db, shotId);
  if (!facts) return { ok: false, code: "SHOT_NOT_FOUND", message: `Shot ${shotId} is not in the archive` };
  const lang = printerSettings(db).lang === "cs" ? "Czech" : "English";
  try {
    const response = await anthropicClient().messages.create(
      {
        model: config.assistantModel,
        max_tokens: 1024,
        system: [{ type: "text", text: CAPTION_PROMPT }],
        messages: [{ role: "user", content: `Language: ${lang}.\nFacts:\n${JSON.stringify(facts)}` }],
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { caption: { type: "string" } }, required: ["caption"], additionalProperties: false },
          },
        },
      },
      { timeout: options.timeoutMs ?? AUTO_CAPTION_TIMEOUT_MS, maxRetries: 0 }
    );
    recordUsage(db, null, "caption", config.assistantModel, usageOf(response.usage));
    if (response.stop_reason === "refusal") return { ok: false, code: "REFUSED", message: response.stop_details?.explanation ?? "The model declined" };
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    let caption: string;
    try { caption = String((JSON.parse(text) as { caption?: unknown }).caption ?? ""); } catch { return { ok: false, code: "BAD_OUTPUT", message: `Not the expected JSON: ${text.slice(0, 80)}` }; }
    // The prompt asks for 120; the column takes 160. Anything longer is cut at a word, not printed as a paragraph.
    if (caption.length > CAPTION_MAX_CHARS) caption = caption.slice(0, CAPTION_MAX_CHARS).replace(/\s+\S*$/, "");
    const stored = setCaption(db, shotId, caption, "assistant");
    if (!stored) return { ok: false, code: "BAD_OUTPUT", message: "The model returned an empty caption" };
    return { ok: true, caption: stored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "CAPTION_FAILED", message };
  }
}
