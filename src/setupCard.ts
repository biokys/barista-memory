import type { DatabaseSync } from "node:sqlite";
import { currentSetup } from "./db/db.js";
import { getCoffee, findCoffee, createCoffee, type CoffeeRow } from "./coffees.js";
import { recordSetup } from "./setups.js";
import { getSetting } from "./settings.js";
import { listProfiles, getProfile, type Profile } from "./device/client.js";
import { saveProfileMerged } from "./profiles.js";

/**
 * A setup as one file another barista-memory can take in: the coffee, how it
 * is ground and dosed, and the machine's brewing profile. Grind settings do
 * not travel between grinders, so the grinder's name goes with the number;
 * the profile does travel, and is the part worth sharing.
 */

export const SETUP_CARD_FORMAT = "barista-memory/setup-card";
export const SETUP_CARD_VERSION = 1;

export interface SetupCard {
  format: typeof SETUP_CARD_FORMAT;
  version: typeof SETUP_CARD_VERSION;
  exported_at: number;
  app_version: string;
  coffee: {
    name: string;
    roaster: string | null;
    origin: string | null;
    process: string | null;
    roast_level: string | null;
    bag_g: number | null;
    target_time_min_s: number | null;
    target_time_max_s: number | null;
    target_ratio: number | null;
    note: string | null;
  };
  brewing: {
    grinder: string | null;
    grind_setting: string | null;
    dose_g: number | null;
    basket: string | null;
    /** What the period's shots averaged, so the reader knows what to expect. */
    avg_ratio: number | null;
    avg_seconds: number | null;
    shots: number;
  };
  /** The profile selected on the machine at export, whole; null when the machine did not answer. */
  profile: Profile | null;
}

export type ExportResult = { ok: true; card: SetupCard } | { ok: false; code: "NO_SETUP" | "NO_COFFEE"; message: string };

export async function exportSetupCard(db: DatabaseSync, appVersion: string): Promise<ExportResult> {
  const setup = currentSetup(db);
  if (!setup) return { ok: false, code: "NO_SETUP", message: "No brewing context recorded yet" };
  const coffee = setup.coffee_id != null ? getCoffee(db, setup.coffee_id) : null;
  if (!coffee) return { ok: false, code: "NO_COFFEE", message: "The current setup names no coffee" };

  const stats = db
    .prepare("SELECT COUNT(*) AS shots, ROUND(AVG(ratio), 2) AS avg_ratio, ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_seconds FROM shot_context WHERE setup_id = ?")
    .get(setup.id) as { shots: number; avg_ratio: number | null; avg_seconds: number | null };

  let profile: Profile | null = null;
  try {
    const profiles = await listProfiles();
    const selected = profiles?.find((p) => p.selected) ?? null;
    if (selected) profile = (await getProfile(selected.id)) ?? selected;
  } catch { /* machine off: the card goes out without a profile */ }

  return {
    ok: true,
    card: {
      format: SETUP_CARD_FORMAT,
      version: SETUP_CARD_VERSION,
      exported_at: Math.floor(Date.now() / 1000),
      app_version: appVersion,
      coffee: {
        name: coffee.name, roaster: coffee.roaster, origin: coffee.origin, process: coffee.process, roast_level: coffee.roast_level,
        bag_g: coffee.bag_g, target_time_min_s: coffee.target_time_min_s, target_time_max_s: coffee.target_time_max_s, target_ratio: coffee.target_ratio, note: coffee.note,
      },
      brewing: {
        grinder: getSetting(db, "grinder", "") || null,
        grind_setting: setup.grind_setting,
        dose_g: setup.dose_g,
        basket: setup.basket,
        avg_ratio: stats.shots ? stats.avg_ratio : null,
        avg_seconds: stats.shots ? stats.avg_seconds : null,
        shots: stats.shots,
      },
      profile,
    },
  };
}

export interface ImportOptions {
  /** Write the card's profile to the machine (merged by label, created when new). Off by default: it touches the machine. */
  write_profile?: boolean;
  /** Take the grind number over even though it came from another grinder. */
  take_grind?: boolean;
}

export interface ImportResult {
  ok: true;
  coffee: CoffeeRow;
  coffee_created: boolean;
  setup_id: number;
  profile: "written" | "skipped" | "absent" | "failed";
  profile_message?: string;
  /** The card's grinder differs from this one's, so the grind number was not taken. */
  grind_skipped: boolean;
}

function isCard(value: unknown): value is SetupCard {
  const v = value as SetupCard;
  return !!v && v.format === SETUP_CARD_FORMAT && typeof v.version === "number" && !!v.coffee && typeof v.coffee.name === "string" && !!v.brewing;
}

export async function importSetupCard(db: DatabaseSync, value: unknown, options: ImportOptions = {}): Promise<ImportResult> {
  if (!isCard(value)) throw new Error("Not a barista-memory setup card");
  if (value.version > SETUP_CARD_VERSION) throw new Error(`Setup card version ${value.version} is newer than this archive understands`);
  const card = value;

  // The coffee, by identity: an existing one keeps its own details and
  // targets — the card's are a suggestion, not an overwrite.
  let coffee = findCoffee(db, card.coffee.name.trim(), card.coffee.roaster?.trim() || null);
  const created = !coffee;
  if (!coffee) coffee = createCoffee(db, { ...card.coffee, name: card.coffee.name });

  // A grind number only means something on the same grinder.
  const ownGrinder = getSetting(db, "grinder", "") || null;
  const sameGrinder = !card.brewing.grinder || !ownGrinder || card.brewing.grinder.trim().toLowerCase() === ownGrinder.trim().toLowerCase();
  const takeGrind = card.brewing.grind_setting != null && (sameGrinder || options.take_grind === true);

  const setup = recordSetup(db, {
    coffee_id: coffee.id,
    ...(takeGrind ? { grind_setting: card.brewing.grind_setting! } : {}),
    ...(card.brewing.dose_g != null ? { dose_g: card.brewing.dose_g } : {}),
    ...(card.brewing.basket ? { basket: card.brewing.basket } : {}),
    note: `imported setup card${card.brewing.grinder ? ` (${card.brewing.grinder}${card.brewing.grind_setting != null ? ` ${card.brewing.grind_setting}` : ""})` : ""}`,
  });

  let profile: ImportResult["profile"] = card.profile ? "skipped" : "absent";
  let profileMessage: string | undefined;
  if (card.profile && options.write_profile) {
    const p = card.profile;
    const result = await saveProfileMerged({ label: p.label, temperature: p.temperature, phases: p.phases, type: p.type, description: p.description });
    profile = result.ok ? "written" : "failed";
    if (!result.ok) profileMessage = result.message;
  }

  return { ok: true, coffee, coffee_created: created, setup_id: setup.id, profile, profile_message: profileMessage, grind_skipped: card.brewing.grind_setting != null && !takeGrind };
}
