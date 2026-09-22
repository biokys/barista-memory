import { fetchStatus, wsSend } from "./device/client.js";
import { MODE_NAMES } from "./machineState.js";

/**
 * Modes a person may switch the machine into from the dashboard. Grind (4)
 * is left out: it starts a grinder relay, not a boiler target.
 */
export const SWITCHABLE_MODES = ["standby", "brew", "steam", "water"] as const;
export type SwitchableMode = (typeof SWITCHABLE_MODES)[number];

const MODE_NUMBERS: Record<SwitchableMode, number> = { standby: 0, brew: 1, steam: 2, water: 3 };

/** How long the machine gets to reflect the new mode in /api/status. */
const CONFIRM_TIMEOUT_MS = 4000;
const CONFIRM_POLL_MS = 400;

export type ModeChange =
  | { ok: true; mode: SwitchableMode; previous: string | null }
  | { ok: false; code: "INVALID_MODE" | "MACHINE_UNREACHABLE" | "NOT_CONFIRMED"; message: string };

/**
 * Switch the machine's mode the way its own touch UI does: `req:change-mode`
 * over the WebSocket. The firmware sends no reply and ignores the request
 * unless the controller is ready (it deactivates any running process first),
 * so the change is confirmed by watching /api/status. Note the firmware
 * refuses the request while it is not SYSTEM_READY, e.g. right after boot.
 */
export async function changeMode(mode: string): Promise<ModeChange> {
  if (!(SWITCHABLE_MODES as readonly string[]).includes(mode)) {
    return { ok: false, code: "INVALID_MODE", message: `Mode must be one of ${SWITCHABLE_MODES.join(", ")}` };
  }
  const target = MODE_NUMBERS[mode as SwitchableMode];
  const before = await fetchStatus();
  if (!before) return { ok: false, code: "MACHINE_UNREACHABLE", message: "No answer from the machine" };
  const previous = MODE_NAMES[before.mode] ?? String(before.mode);
  if (before.mode === target) return { ok: true, mode: mode as SwitchableMode, previous };

  if (!(await wsSend({ tp: "req:change-mode", mode: target }))) {
    return { ok: false, code: "MACHINE_UNREACHABLE", message: "Could not send the request to the machine" };
  }

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
    const now = await fetchStatus();
    if (now?.mode === target) return { ok: true, mode: mode as SwitchableMode, previous };
  }
  return {
    ok: false,
    code: "NOT_CONFIRMED",
    message: "The machine did not switch; it ignores mode changes while not ready (e.g. just after boot)",
  };
}
