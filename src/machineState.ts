import type { DatabaseSync } from "node:sqlite";
import type { MachineStatus } from "./device/client.js";
import { massTemperatureAt, settledness } from "./thermalModel.js";

/** Temperature move, in °C, that is worth its own row. */
const TEMP_EPSILON = 1.0;
/** Seconds after which a row is written even though nothing changed. */
const HEARTBEAT_S = 600;

export const MODE_NAMES: Record<number, string> = {
  0: "standby",
  1: "brew",
  2: "steam",
  3: "water",
  4: "grind",
};

export interface StateRow {
  sampled_at: number;
  reachable: number;
  mode: number | null;
  target_temp: number | null;
  current_temp: number | null;
}

/**
 * Store a sample, but only when it says something new.
 *
 * Writing every poll would be 2880 rows a day to record a machine that is off
 * most of it. Writing on change instead is dense exactly where the detail
 * matters — the temperature climbing after power-on — and sparse while it sits
 * at setpoint. The heartbeat keeps a long steady stretch from looking like a
 * gap in the record.
 */
export function recordState(db: DatabaseSync, status: MachineStatus | null): boolean {
  const now = Math.floor(Date.now() / 1000);
  const last = db
    .prepare("SELECT * FROM machine_state ORDER BY sampled_at DESC LIMIT 1")
    .get() as unknown as StateRow | undefined;

  const reachable = status ? 1 : 0;
  const worthWriting =
    !last ||
    last.reachable !== reachable ||
    now - last.sampled_at >= HEARTBEAT_S ||
    (status != null &&
      (last.mode !== status.mode ||
        Math.abs((last.current_temp ?? 0) - status.currentTemp) >= TEMP_EPSILON ||
        (last.target_temp ?? 0) !== status.targetTemp));

  if (!worthWriting) return false;

  db.prepare(
    "INSERT OR REPLACE INTO machine_state (sampled_at, reachable, mode, target_temp, current_temp) VALUES (?, ?, ?, ?, ?)"
  ).run(now, reachable, status?.mode ?? null, status?.targetTemp ?? null, status?.currentTemp ?? null);

  return true;
}

export interface PowerSession {
  started_at: number;
  ended_at: number | null;
  /** Null while the machine is still on. */
  duration_s: number | null;
  temp_at_start: number | null;
  /** When the machine was last told to heat, which is not the same as when it got power. */
  heating_started_at: number | null;
  /** Seconds from being told to heat until the boiler first reached its target. */
  heatup_s: number | null;
  /**
   * Every standby→heating transition in the session, in order. A session can
   * hold several — a morning shot, an hour of standby, an afternoon shot — and
   * a shot must be matched to the episode that preceded it, not the latest.
   */
  heating_episodes: HeatingEpisode[];
  max_temp: number | null;
  shots: number;
}

export interface HeatingEpisode {
  started_at: number;
  /** When the boiler first reached target in this episode; null if it never did. */
  reached_at: number | null;
}

/**
 * Reconstruct power-on sessions from the samples.
 *
 * A session is a run of reachable samples; it ends at the last one before an
 * unreachable sample or a gap longer than `gapS`. The gap rule matters because
 * the archiver itself can be down, and a missing sample is not evidence that
 * the machine was off.
 *
 * gapS is derived from HEARTBEAT_S rather than picked independently: a machine
 * sitting at setpoint only emits heartbeats, so any threshold below that
 * interval would chop one quiet session into one session per heartbeat.
 */
export function powerSessions(db: DatabaseSync, sinceS?: number, gapS = HEARTBEAT_S * 3): PowerSession[] {
  const rows = db
    .prepare(
      "SELECT * FROM machine_state" +
        (sinceS ? " WHERE sampled_at >= ?" : "") +
        " ORDER BY sampled_at ASC"
    )
    .all(...(sinceS ? [sinceS] : [])) as unknown as StateRow[];

  const sessions: PowerSession[] = [];
  let current: StateRow[] = [];

  const flush = (stillOn: boolean) => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];

    // Heating is measured from when the machine was told to heat, not from when
    // it got power: a machine can sit powered in standby for an hour, and
    // timing from the session start would report that hour as the heat-up.
    // Every transition is kept, because a shot has to be matched to the one
    // that preceded it — the latest is only right for "now".
    const episodes: HeatingEpisode[] = [];
    for (let i = 0; i < current.length; i++) {
      const heating = (current[i].target_temp ?? 0) > 0;
      const wasHeating = i > 0 && (current[i - 1].target_temp ?? 0) > 0;
      if (heating && !wasHeating) episodes.push({ started_at: current[i].sampled_at, reached_at: null });
    }

    // The boiler is "there" once the reading reaches its own target; before the
    // machine sets a target there is nothing to be heating towards. Each
    // episode looks only at samples before the next one begins.
    for (let e = 0; e < episodes.length; e++) {
      const from = episodes[e].started_at;
      const until = e + 1 < episodes.length ? episodes[e + 1].started_at : Number.POSITIVE_INFINITY;
      const reached = current.find(
        (row) =>
          row.sampled_at >= from &&
          row.sampled_at < until &&
          (row.target_temp ?? 0) > 0 &&
          (row.current_temp ?? 0) >= (row.target_temp ?? 0) - TEMP_EPSILON
      );
      episodes[e].reached_at = reached ? reached.sampled_at : null;
    }
    const latest = episodes.length > 0 ? episodes[episodes.length - 1] : null;

    sessions.push({
      started_at: first.sampled_at,
      ended_at: stillOn ? null : last.sampled_at,
      duration_s: stillOn ? null : last.sampled_at - first.sampled_at,
      temp_at_start: first.current_temp,
      heating_started_at: latest ? latest.started_at : null,
      heatup_s: latest && latest.reached_at != null ? latest.reached_at - latest.started_at : null,
      heating_episodes: episodes,
      max_temp: current.reduce((max, row) => Math.max(max, row.current_temp ?? 0), 0) || null,
      shots: 0,
    });
    current = [];
  };

  for (const row of rows) {
    if (row.reachable === 0) {
      flush(false);
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && row.sampled_at - previous.sampled_at > gapS) {
      flush(false);
    }
    current.push(row);
  }
  flush(true);

  const countShots = db.prepare(
    "SELECT COUNT(*) AS n FROM shots WHERE kind = 'shot' AND started_at >= ? AND started_at <= ?"
  );
  for (const session of sessions) {
    const { n } = countShots.get(session.started_at, session.ended_at ?? Math.floor(Date.now() / 1000)) as {
      n: number;
    };
    session.shots = n;
  }

  return sessions;
}

export interface Conditions {
  reachable: boolean;
  mode: number | null;
  mode_name: string | null;
  target_temp: number | null;
  current_temp: number | null;
  /** Seconds since the machine last started answering, i.e. since it got power. */
  powered_for_s: number | null;
  /** Seconds since it was last told to heat. Null while it sits in standby. */
  heating_for_s: number | null;
  /** How long the boiler took to reach target after being told to heat. */
  heatup_s: number | null;
  /** True once the boiler has reached its target in this heating episode. */
  at_target: boolean;
  /** Thermal mass, 0–100 of the way from room to setpoint; the honest "ready". */
  settledness: number | null;
  /** Degrees per minute over the recent samples: positive heating, negative cooling. */
  trend_c_per_min: number | null;
  trend: "heating" | "cooling" | "holding" | null;
}

/** Samples used to estimate the trend. At a 30 s poll that is a few minutes. */
const TREND_SAMPLES = 4;
/** Below this the machine is considered to be holding rather than moving. */
const TREND_EPSILON = 0.2;

/**
 * The machine's operating conditions right now.
 *
 * `live` is a fresh reading rather than the last stored sample, because the
 * store only gains a row when something changed and may legitimately be minutes
 * old. Everything around it — how long it has been on, whether the boiler has
 * settled — comes from the stored history, which is the only place that exists.
 */
export function currentConditions(db: DatabaseSync, live: MachineStatus | null): Conditions {
  const sessions = powerSessions(db);
  const session = sessions.length > 0 ? sessions[sessions.length - 1] : undefined;
  const open = session && session.ended_at === null ? session : undefined;
  const now = Math.floor(Date.now() / 1000);

  const recent = db
    .prepare("SELECT * FROM machine_state WHERE reachable = 1 ORDER BY sampled_at DESC LIMIT ?")
    .all(TREND_SAMPLES) as unknown as StateRow[];

  let trendPerMin: number | null = null;
  if (recent.length >= 2) {
    const newest = recent[0];
    const oldest = recent[recent.length - 1];
    const minutes = (newest.sampled_at - oldest.sampled_at) / 60;
    if (minutes > 0 && newest.current_temp != null && oldest.current_temp != null) {
      trendPerMin = (newest.current_temp - oldest.current_temp) / minutes;
    }
  }

  const atTarget =
    live != null && live.targetTemp > 0 && live.currentTemp >= live.targetTemp - TEMP_EPSILON;

  const heatingFor =
    live && open?.heating_started_at != null && (live.targetTemp ?? 0) > 0
      ? now - open.heating_started_at
      : null;

  const mass = massTemperatureAt(allStateSamples(db), now);
  const setpoint = live && live.targetTemp > 0 ? live.targetTemp : 94;

  return {
    reachable: live != null,
    settledness: mass == null ? null : settledness(mass, setpoint),
    mode: live?.mode ?? null,
    mode_name: live ? (MODE_NAMES[live.mode] ?? String(live.mode)) : null,
    target_temp: live?.targetTemp ?? null,
    current_temp: live?.currentTemp ?? null,
    powered_for_s: open ? now - open.started_at : null,
    heating_for_s: heatingFor,
    heatup_s: open?.heatup_s ?? null,
    at_target: atTarget,
    trend_c_per_min: trendPerMin != null ? Math.round(trendPerMin * 100) / 100 : null,
    // A boiler sitting on setpoint is not trending anywhere: the PID cycles
    // around it, and since samples are only stored on a 1 degree move, two
    // consecutive ones are always a degree apart and the raw slope flips sign.
    // Being at target therefore wins over the slope.
    trend: atTarget
      ? "holding"
      : trendPerMin == null
        ? null
        : trendPerMin > TREND_EPSILON
          ? "heating"
          : trendPerMin < -TREND_EPSILON
            ? "cooling"
            : "holding",
  };
}

export interface ShotMachineContext {
  powered_for_s: number | null;
  heating_for_s: number | null;
  heatup_s: number | null;
  /** Boiler sensor had reached target. True long before the machine is ready. */
  settled: boolean | null;
  /** Thermal mass, 0–100 of the way from room to setpoint. The useful one. */
  settledness: number | null;
}

/**
 * What the machine's thermal state was when a shot started.
 *
 * Derived from the session that contains the shot's start time. A shot with no
 * covering session yields nulls, not zeros: the sampling started after the shot
 * and nothing is known — the distinction between "cold" and "unrecorded" is
 * exactly what a correlation must not lose.
 *
 * heating_for_s is clamped at 0: a shot pulled within one poll of waking the
 * machine can start before the first sample that shows it heating, and a
 * negative "heating for" would only mean the transition was not seen yet.
 */
export function machineContextForShot(
  sessions: PowerSession[],
  startedAt: number,
  samples: StateRow[] = []
): ShotMachineContext {
  const session = sessions.find(
    (candidate) =>
      candidate.started_at <= startedAt && (candidate.ended_at ?? Number.POSITIVE_INFINITY) >= startedAt
  );
  if (!session) {
    return { powered_for_s: null, heating_for_s: null, heatup_s: null, settled: null, settledness: null };
  }

  const mass = massTemperatureAt(samples, startedAt);
  const setpoint = samples.reduce((last, row) => ((row.target_temp ?? 0) > 0 ? (row.target_temp as number) : last), 94);

  // The episode in force is the last one that began at or before the shot.
  // A shot pulled within one poll of waking can precede the first sample that
  // shows heating; then the next episode is the right one and heating_for_s is
  // clamped at 0 rather than reported negative.
  let episode: HeatingEpisode | null = null;
  for (const candidate of session.heating_episodes) {
    if (candidate.started_at <= startedAt) episode = candidate;
  }
  if (!episode && session.heating_episodes.length > 0) {
    const next = session.heating_episodes[0];
    if (next.started_at - startedAt <= HEARTBEAT_S) episode = next;
  }

  const heatingFor = episode ? Math.max(0, startedAt - episode.started_at) : null;
  const heatupS = episode && episode.reached_at != null ? episode.reached_at - episode.started_at : null;
  const settled = episode && episode.reached_at != null ? startedAt >= episode.reached_at : null;

  return {
    powered_for_s: startedAt - session.started_at,
    heating_for_s: heatingFor,
    heatup_s: heatupS,
    settled,
    settledness: mass == null ? null : settledness(mass, setpoint),
  };
}

/** All state samples, oldest first — the input the thermal model walks. */
export function allStateSamples(db: DatabaseSync): StateRow[] {
  return db.prepare("SELECT * FROM machine_state ORDER BY sampled_at ASC").all() as unknown as StateRow[];
}
