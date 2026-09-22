import type { StateRow } from "./machineState.js";

/**
 * How warm the machine's slow thermal mass is — the group, the brass around
 * the boiler — as opposed to the boiler sensor, which is what we can read.
 *
 * The sensor reaches setpoint in ~90 s from 25 °C and from 41 °C alike; it
 * sits on the boiler shell and says nothing about the group. A machine woken
 * from 60 °C is much closer to ready than one woken from 20 °C, and one woken
 * five minutes ago is not ready at all even though the sensor has said 94 for
 * four of them. This model tracks the part the sensor cannot see.
 *
 * One state, two first-order laws:
 *  - heating (target > 0): the mass relaxes towards the setpoint with TAU_HEAT
 *  - otherwise: it relaxes towards the room with TAU_COOL
 *
 * TAU_COOL is fitted, not guessed: 58 min from the 95.8 → 38.9 °C standby
 * curve recorded on 2026-09-20 (46 samples, residuals under 3 °C). TAU_HEAT is
 * the one free parameter — group-head warm-up on a Gaggia Classic is quoted at
 * 15–25 min — and is meant to be calibrated against shots; see
 * calibration notes in README.
 */
export const TAU_COOL_MIN = 58;
export const TAU_HEAT_MIN = Number(process.env.GAGGIMATE_TAU_HEAT_MIN ?? 20);
export const ROOM_TEMP_C = Number(process.env.GAGGIMATE_ROOM_TEMP_C ?? 22);

/** Fraction of the way from room to setpoint the mass has come, 0–100. */
export function settledness(massTemp: number, setpoint: number): number {
  if (setpoint <= ROOM_TEMP_C) return 0;
  const frac = (massTemp - ROOM_TEMP_C) / (setpoint - ROOM_TEMP_C);
  return Math.round(Math.max(0, Math.min(1, frac)) * 100);
}

function relax(current: number, towards: number, minutes: number, tauMin: number): number {
  return towards + (current - towards) * Math.exp(-minutes / tauMin);
}

/**
 * Estimated mass temperature at `at`, from the recorded state samples.
 *
 * Steps through every sample up to `at`, applying whichever law was in force
 * during each interval. The starting value is the first sample's own sensor
 * reading: with no earlier history that is the best available guess, and its
 * error decays with the same τ as everything else, so it is gone within an
 * hour of sampling starting.
 *
 * Returns null when no sample precedes `at` — unknown, never cold.
 */
export function massTemperatureAt(samples: StateRow[], at: number): number | null {
  let mass: number | null = null;
  let prev: StateRow | null = null;

  for (const row of samples) {
    if (row.sampled_at > at) break;
    if (mass === null) {
      mass = row.reachable === 1 && row.current_temp != null ? row.current_temp : ROOM_TEMP_C;
      prev = row;
      continue;
    }
    mass = step(mass, prev!, row.sampled_at - prev!.sampled_at);
    prev = row;
  }

  if (mass === null || prev === null) return null;
  return step(mass, prev, at - prev.sampled_at);
}

/**
 * Advance the mass through `seconds` under the regime `during` describes.
 *
 * "Heating" is decided by what the boiler is actually doing, not by the
 * target alone: on 2026-09-21 17:00 the machine sat in brew mode with target
 * 94 while its sensor fell from 90 to 49 °C over an hour — the element was
 * off. A boiler that is not itself near setpoint cannot be warming the mass
 * towards it, so the mass is relaxed towards the boiler's own reading instead,
 * and the machine is treated as cooling once the boiler drops well below
 * target.
 */
function step(mass: number, during: StateRow, seconds: number): number {
  if (seconds <= 0) return mass;
  const minutes = seconds / 60;
  const target = during.target_temp ?? 0;
  const boiler = during.current_temp;
  const heating =
    during.reachable === 1 && target > 0 && boiler != null && boiler >= target - HEATING_TOLERANCE_C;
  if (heating) {
    return relax(mass, target, minutes, TAU_HEAT_MIN);
  }
  // Not heating: the mass drifts towards wherever the boiler is, which is the
  // room for a machine that is off, and the boiler's reading otherwise.
  const towards = during.reachable === 1 && boiler != null ? Math.max(ROOM_TEMP_C, boiler) : ROOM_TEMP_C;
  return relax(mass, towards, minutes, TAU_COOL_MIN);
}

/**
 * How far below target the boiler may read and still count as heating. The
 * PID cycles within a degree or two of setpoint; a boiler ten degrees under it
 * is either still coming up (fine — the mass tracks it) or has no power.
 */
const HEATING_TOLERANCE_C = 8;
