import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "./settings.js";

/**
 * The grinder's dial as the user described it in the preferences: its name,
 * its range and the smallest step it can be set to. Every grind control is
 * drawn from this, and the assistant is told it on every turn — without it
 * the model once advised "13.5 → 13.4" on a dial marked in halves
 * (2026-10-01).
 *
 * The default is the DF64's dial. It was once hard-coded as 0–90 in 0.1
 * steps, which is wrong for every other grinder and too fine even for that
 * one: nobody sets a DF64 to 12.3, the marks are halves (2026-09-24).
 */
export const GRIND_SCALE_DEFAULT = { min: 0, max: 90, step: 0.5 };

export interface GrindScale {
  grind_min: number;
  grind_max: number;
  grind_step: number;
}

export function grindScale(db: DatabaseSync): GrindScale {
  const num = (key: string, fallback: number) => {
    const n = Number(getSetting(db, key, String(fallback)));
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    grind_min: num("grind_min", GRIND_SCALE_DEFAULT.min),
    grind_max: num("grind_max", GRIND_SCALE_DEFAULT.max),
    grind_step: num("grind_step", GRIND_SCALE_DEFAULT.step),
  };
}

export interface GrinderPreferences extends GrindScale {
  /** Free text, e.g. "DF64"; empty when the user never named it. */
  grinder: string;
}

export function grinderPreferences(db: DatabaseSync): GrinderPreferences {
  return { grinder: getSetting(db, "grinder", ""), ...grindScale(db) };
}

/** One line for a prompt: "DF64, dial 0–90 in steps of 0.5". */
export function describeGrinder(p: GrinderPreferences): string {
  return `${p.grinder || "unnamed grinder"}, dial ${p.grind_min}–${p.grind_max} in steps of ${p.grind_step}`;
}
