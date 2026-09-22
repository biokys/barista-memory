import { listProfiles, getProfile, saveProfile, selectProfile, type Profile, type ProfilePhase } from "./device/client.js";

export interface ProfileSpec {
  profile_id?: string;
  label?: string;
  temperature?: number;
  phases?: any[];
  type?: string;
  description?: string;
  favorite?: boolean;
  utility?: boolean;
}

export type SaveResult =
  | { ok: true; profile: Profile; action: "created" | "updated" }
  | { ok: false; code: string; message: string };

/**
 * Save a profile by merging the caller's fields onto the existing one.
 *
 * The machine replaces the whole profile on save, so a caller who sends only
 * the field they want to change loses the rest — the old server came back with
 * selected: false after a one-field edit. Shared by the MCP and the web API.
 */
export async function saveProfileMerged(spec: ProfileSpec): Promise<SaveResult> {
  const profiles = await listProfiles();
  if (!profiles) return { ok: false, code: "MACHINE_UNREACHABLE", message: "No answer from the machine" };

  let existing: Profile | null = null;
  if (spec.profile_id) {
    const byId = profiles.find((p) => p.id === spec.profile_id);
    if (!byId) return { ok: false, code: "PROFILE_NOT_FOUND", message: `No profile with id "${spec.profile_id}"` };
    existing = (await getProfile(byId.id)) ?? byId;
  } else if (spec.label) {
    const byLabel = profiles.find((p) => p.label === spec.label);
    if (byLabel) existing = (await getProfile(byLabel.id)) ?? byLabel;
  }
  if (!existing && (!spec.label || spec.temperature == null || !spec.phases)) {
    return { ok: false, code: "MISSING_PARAMETER", message: "Creating a profile needs label, temperature and phases" };
  }

  const temperature = spec.temperature ?? existing?.temperature ?? 94;
  const phases: ProfilePhase[] = (spec.phases ?? existing?.phases ?? []).map((phase: any) => ({
    name: phase.name,
    phase: phase.phase ?? "brew",
    // Per-phase valve state, not a constant: a hardcoded 1 makes backflush
    // impossible, since that cycle is exactly the valve opening and closing.
    valve: phase.valve ?? 1,
    duration: phase.duration,
    temperature: phase.temperature ?? temperature,
    transition: phase.transition ?? { type: "linear", duration: Math.min(phase.duration, 2), adaptive: true },
    pump: phase.pump ?? { target: "pressure", pressure: 9, flow: 0 },
    targets: phase.targets ?? [],
  }));

  const profile: Profile = {
    id: existing?.id ?? "",
    label: spec.label ?? existing!.label,
    type: spec.type ?? existing?.type ?? "pro",
    description: spec.description ?? existing?.description ?? "",
    temperature,
    favorite: spec.favorite ?? existing?.favorite ?? false,
    selected: existing?.selected ?? false,
    utility: spec.utility ?? existing?.utility ?? false,
    phases,
  };

  const result = await saveProfile(profile);
  if (!result.ok) return { ok: false, code: "SAVE_FAILED", message: result.error };
  return { ok: true, profile: result.profile, action: existing ? "updated" : "created" };
}

export type SelectResult =
  | { ok: true; profile: Profile }
  | { ok: false; code: "MACHINE_UNREACHABLE" | "PROFILE_NOT_FOUND" | "NOT_SELECTED"; message: string };

/**
 * Make a profile the current one on the machine and confirm it by reading
 * the list back: the firmware's select handler reports nothing, an unknown
 * id included, so the list is the only evidence the change took.
 */
export async function selectProfileOnMachine(profileId: string): Promise<SelectResult> {
  const before = await listProfiles();
  if (!before) return { ok: false, code: "MACHINE_UNREACHABLE", message: "No answer from the machine" };
  if (!before.some((p) => p.id === profileId)) return { ok: false, code: "PROFILE_NOT_FOUND", message: `No profile with id ${profileId}` };

  if (!(await selectProfile(profileId))) return { ok: false, code: "MACHINE_UNREACHABLE", message: "The machine did not answer the select request" };

  const after = await listProfiles();
  const selected = after?.find((p) => p.selected);
  if (selected?.id !== profileId) return { ok: false, code: "NOT_SELECTED", message: "The machine did not switch profiles" };
  return { ok: true, profile: selected };
}
