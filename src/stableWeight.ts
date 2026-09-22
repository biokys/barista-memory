import type { ShotSample } from "./device/parsers/binaryShot.js";

/**
 * A weight for the cup that can be trusted enough to compute a ratio from.
 *
 * The machine stores whatever its last weight sample happened to be as the
 * shot's volume. When the Bluetooth scale glitches in the final fraction of a
 * second — which it did on four of the first nine archived shots — that value
 * is nonsense and so is every ratio derived from it. Shot 410 was recorded as
 * 58.4 g when the cup held 44.3 g.
 *
 * Every constant here comes from those recorded curves, not from taste.
 */

/**
 * Grams per second above which an increase is not coffee arriving.
 *
 * Peak real flow across the archived shots is about 2.5 g/s. The glitch on shot
 * 410 was 14 g in 0.2 s, i.e. 70 g/s.
 */
const MAX_PLAUSIBLE_RATE_G_S = 5.0;

/**
 * The machine tares the scale itself shortly after the shot starts, so early
 * samples can read whatever was sitting on it — 181.9 g on shots 407 and 408.
 * Everything up to the last near-zero reading inside this window is discarded.
 */
const TARE_WINDOW_S = 12.0;
const TARE_THRESHOLD_G = 1.0;

/**
 * Coffee in the cup does not leave it. A reading this far below what has
 * already accumulated is the scale dropping out, not the weight falling — shot
 * 409 ended 58 → 45.1 → 50.7 → 0.
 *
 * 1.0 rather than 2.0: on a settled plateau the reading moves by tenths, and
 * shot 412's final glitch was 44.4 → 42.6 → 0. At 2.0 the 42.6 slipped through
 * and the ratio came out 1:2.37 instead of 1:2.47.
 */
const MAX_BACKWARD_DROP_G = 1.0;

/**
 * How far the machine's own figure may sit from the curve's end before it is
 * treated as a glitch rather than as a better reading.
 *
 * Within this band the machine wins: on shots still flowing at cutoff its value
 * catches a final drip after the last logged sample and is the more accurate of
 * the two (403 and 404 differ by 0.5-0.7 g that way).
 */
const RECORDED_TRUST_TOLERANCE_G = 1.0;

export type WeightSource = "recorded" | "curve" | "none";

export interface StableWeight {
  weight: number | null;
  source: WeightSource;
  /** Samples discarded as physically impossible. */
  rejected: number;
}

/**
 * The weight trace with the same readings removed that stableWeight() ignores,
 * as one value per input sample: null before the self-tare and for every
 * reading rejected as impossible, so a chart shows a gap there instead of the
 * 181.9 g pre-tare spike or the cup being lifted off the scale at the end.
 */
export function cleanWeightSeries(samples: ShotSample[]): Array<number | null> {
  const out: Array<number | null> = samples.map(() => null);
  const points = samples.map((sample, i) => ({
    i,
    t: typeof sample.t === "number" ? sample.t / 1000 : null,
    v: typeof sample.v === "number" ? sample.v : null,
  }));
  if (points.every((p) => p.v == null || p.v === 0)) return out;

  let start = 0;
  for (const p of points) {
    if (p.t != null && p.v != null && p.t <= TARE_WINDOW_S && p.v <= TARE_THRESHOLD_G) start = p.i;
  }

  let last: { t: number; v: number } | null = null;
  for (const p of points.slice(start)) {
    if (p.t == null || p.v == null) continue;
    if (!last) { last = { t: p.t, v: p.v }; out[p.i] = p.v; continue; }
    const seconds = Math.max(p.t - last.t, 1e-3);
    const rate = (p.v - last.v) / seconds;
    if (rate > MAX_PLAUSIBLE_RATE_G_S || p.v < last.v - MAX_BACKWARD_DROP_G) continue;
    last = { t: p.t, v: p.v };
    out[p.i] = p.v;
  }
  return out;
}

/** The end of the curve, with tare and impossible readings removed. */
function weightFromCurve(samples: ShotSample[]): { weight: number | null; rejected: number } {
  const points = samples
    .filter((sample) => typeof sample.t === "number" && typeof sample.v === "number")
    .map((sample) => ({ t: (sample.t as number) / 1000, v: sample.v as number }));

  if (points.length === 0 || points.every((point) => point.v === 0)) {
    return { weight: null, rejected: 0 };
  }

  // Start after the machine's own tare rather than at the first sample.
  let start = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i].t <= TARE_WINDOW_S && points[i].v <= TARE_THRESHOLD_G) start = i;
  }

  let last: { t: number; v: number } | null = null;
  let rejected = 0;

  for (const point of points.slice(start)) {
    if (!last) {
      last = point;
      continue;
    }
    const seconds = Math.max(point.t - last.t, 1e-3);
    const rate = (point.v - last.v) / seconds;
    if (rate > MAX_PLAUSIBLE_RATE_G_S || point.v < last.v - MAX_BACKWARD_DROP_G) {
      rejected++;
      continue;
    }
    last = point;
  }

  return { weight: last ? Math.round(last.v * 10) / 10 : null, rejected };
}

/**
 * Reconcile the machine's recorded weight with the curve.
 *
 * The machine is believed unless the curve says it cannot be right. That order
 * matters: the curve is the fallback for a broken reading, not a replacement
 * for a working one.
 */
export function stableWeight(samples: ShotSample[], recorded: number | null): StableWeight {
  const { weight: curve, rejected } = weightFromCurve(samples);

  if (recorded == null || recorded <= 0) {
    return curve != null
      ? { weight: curve, source: "curve", rejected }
      : { weight: null, source: "none", rejected };
  }

  if (curve == null) {
    return { weight: recorded, source: "recorded", rejected };
  }

  return Math.abs(recorded - curve) <= RECORDED_TRUST_TOLERANCE_G
    ? { weight: recorded, source: "recorded", rejected }
    : { weight: curve, source: "curve", rejected };
}
