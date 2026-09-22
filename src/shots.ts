import type { DatabaseSync } from "node:sqlite";
import type { ShotContextRow } from "./db/db.js";
import { parseSlog } from "./device/client.js";
import { transformShotForAI } from "./device/shotTransformer.js";

/** The machine's thermal context for a shot, or null when the record started after it. */
export function machineContextOf(context: ShotContextRow) {
  return context.machine_powered_for_s == null
    ? null
    : {
        powered_for_s: context.machine_powered_for_s,
        heating_for_s: context.machine_heating_for_s,
        heatup_s: context.machine_heatup_s,
        settled: context.machine_settled == null ? null : context.machine_settled === 1,
        settledness: context.machine_settledness,
      };
}

/**
 * One archived shot, shaped exactly like a shot read live from the device so
 * the same reasoning applies whether it is still on the machine or not.
 * Shared by the MCP and the web API so both answer identically.
 */
export function loadArchivedShot(db: DatabaseSync, shotId: number, fullCurve: boolean) {
  const context = db.prepare("SELECT * FROM shot_context WHERE id = ?").get(shotId) as unknown as
    | ShotContextRow
    | undefined;
  if (!context) return null;

  const row = db.prepare("SELECT raw_slog FROM shots WHERE id = ?").get(shotId) as
    | { raw_slog: Uint8Array | null }
    | undefined;
  const shot = row?.raw_slog ? transformShotForAI(parseSlog(Buffer.from(row.raw_slog), shotId), fullCurve) : null;

  return { context, machine: machineContextOf(context), shot };
}

/**
 * A downsampled pressure trace for a list row's sparkline: enough points to
 * see the shape (preinfusion, ramp, decline, a glitch), not the whole log.
 */
export function pressureSparkline(db: DatabaseSync, shotId: number, points = 48): number[] {
  const row = db.prepare("SELECT raw_slog FROM shots WHERE id = ?").get(shotId) as
    | { raw_slog: Uint8Array | null }
    | undefined;
  if (!row?.raw_slog) return [];
  const samples = parseSlog(Buffer.from(row.raw_slog), shotId).samples;
  const pressures = samples.map((s: any) => (typeof s.cp === "number" ? s.cp : 0));
  if (pressures.length <= points) return pressures;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const a = Math.floor((i * pressures.length) / points);
    const b = Math.floor(((i + 1) * pressures.length) / points);
    out.push(Math.max(...pressures.slice(a, Math.max(b, a + 1))));
  }
  return out;
}
