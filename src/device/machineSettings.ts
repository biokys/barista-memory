/**
 * Machine settings exposure for the Gaggimate MCP server.
 *
 * GET /api/settings on the device returns every stored setting in one flat JSON
 * object, including `wifiPassword`, `apPassword` and `haPassword` in cleartext
 * and without authentication. Handing that straight to a model would leak
 * credentials into its context on every call, so this module exposes an
 * explicit allowlist instead: anything not named here is dropped, which means a
 * future firmware key is excluded by default rather than leaked by default.
 *
 * The allowlist is grouped by what the value actually influences, so a model
 * analysing a shot can relate a setting to the curve it is looking at.
 */

/** Allowlisted keys, grouped by the part of the machine they affect. */
export const SETTINGS_GROUPS: Record<string, readonly string[]> = {
  temperature: [
    "targetWaterTemp",
    "targetSteamTemp",
    "temperatureOffset",
    "pid",
  ],
  pressure: ["pressureOffset", "pressureScaling"],
  pump: [
    "pumpModelCoeffs",
    "pumpSlipCoeffs",
    "maxPumpPower",
    "commutationGain",
    "convergenceGain",
    "integralGain",
    "steamPumpPercentage",
    "steamPumpCutoff",
  ],
  timing: [
    "brewDelay",
    "grindDelay",
    "delayAdjust",
    "flushDuration",
    "startupFillTime",
    "steamFillTime",
    "boilerFillActive",
  ],
  hardware: [
    "savedScale",
    "momentaryButtons",
    "buttonBehavior",
    "altRelayFunction",
    "emptyTankDistance",
    "fullTankDistance",
    "smartGrindActive",
    "smartGrindMode",
  ],
  behavior: [
    "startupMode",
    "startupProfile",
    "standbyTimeout",
    "autowakeupEnabled",
    "autowakeupSchedules",
  ],
  warnings: [
    "warnWaterLevel",
    "warnFlush",
    "warnSteamSwitch",
    "warnScaleConnected",
    "warnScaleBattery",
    "warnTemperature",
  ],
} as const;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(
  Object.values(SETTINGS_GROUPS).flat()
);

export interface GroupedSettings {
  settings: Record<string, Record<string, unknown>>;
  /** Keys present on the device but not allowlisted, reported as a count only. */
  withheld_key_count: number;
  note: string;
}

/**
 * Split a raw /api/settings payload into the allowlisted groups.
 *
 * Keys the device does not report are simply absent from their group rather
 * than emitted as null, so the output reflects the firmware actually in use.
 */
export function groupSettings(raw: Record<string, unknown>): GroupedSettings {
  const settings: Record<string, Record<string, unknown>> = {};

  for (const [group, keys] of Object.entries(SETTINGS_GROUPS)) {
    const values: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        values[key] = raw[key];
      }
    }
    if (Object.keys(values).length > 0) {
      settings[group] = values;
    }
  }

  const withheld = Object.keys(raw).filter((key) => !ALLOWED_KEYS.has(key));

  return {
    settings,
    withheld_key_count: withheld.length,
    note:
      "Only brewing-relevant settings are exposed. Credentials (wifi, AP, Home Assistant) " +
      "and network configuration are withheld by an allowlist and never leave the device.",
  };
}
