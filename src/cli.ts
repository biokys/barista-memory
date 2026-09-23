#!/usr/bin/env node
/**
 * Command line access to the archive, for callers with no MCP client — the
 * Robion controls panel, a shell, a cron job.
 *
 * Keeping this separate from the MCP server means changing the brewing context
 * at the grinder never depends on a model being in the loop.
 */
import { config } from "./config.js";
import { openDatabase, currentSetup } from "./db/db.js";
import { recordSetup, updateSetup, type SetupChange } from "./setups.js";
import { ingestOnce, recomputeStableWeights, recomputeMachineContext } from "./ingest.js";
import { fetchStatus, parseSlog } from "./device/client.js";
import { TAU_HEAT_MIN } from "./thermalModel.js";
import { recordEvent, listEvents } from "./events.js";
import { maintenanceStatus, logMaintenance } from "./maintenance.js";
import { changeMode } from "./machineControl.js";
import { printShot, printTest, printerStatus, findPrinters } from "./printer/index.js";
import { closeBus } from "./printer/bluez.js";
import { currentConditions } from "./machineState.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  cli set-setup [--bean B] [--roaster R] [--roast-date YYYY-MM-DD]",
      "                [--grind G] [--dose G] [--basket B] [--note N]",
      "      Opens a new brewing context period. Fields left out keep their current value.",
      "  cli fix-setup --id N [same fields as set-setup] [--valid-from UNIX]",
      "      Corrects an existing period instead of opening a new one.",
      "  cli show          Print the context currently in force",
      "  cli status        One line on the machine: temperature, mode, how long on",
      "  cli mode <standby|brew|steam|water>   Switch the machine's mode",
      "  cli print [id]    Print a receipt for a shot (default: the latest) on the Bluetooth printer",
      "  cli printer-test | printer-status | printer-scan",
      "  cli last          One line on the most recent archived shot",
      "  cli ingest        Run one archive pass",
      "  cli event --title T [--kind equipment|technique|maintenance|beans|other] [--note N] [--at UNIX]",
      "      Record a turning point (new WDT, puck screen, basket...). Later shots belong to its era.",
      "  cli events        List turning points",
      "  cli maintenance   Where each cleaning routine stands",
      "  cli maintenance-done <backflush|cafiza|descale|water_filter|gasket> [--note N] [--at UNIX]",
      "  cli stats         Print archive counts",
      "  cli recompute-weights [--all]",
      "      Re-derive the stable weight from the stored logs; --all redoes every shot.",
      "  cli calibrate     Bloom temperature vs. modelled settledness, per shot (for tuning TAU_HEAT)",
      "  cli recompute-context [--all]",
      "      Re-derive each shot's machine warm-up context from machine_state.",
    ].join("\n")
  );
  process.exit(2);
}


/** Seconds as "1h 23m" or "45m", for a status badge. */
function human(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const db = openDatabase(config.databasePath);

try {
  switch (command) {
    case "set-setup": {
      const change: SetupChange = {};
      // Only fields actually passed are carried into the change, so the rest
      // are inherited rather than cleared.
      if (args.bean !== undefined) change.bean = args.bean;
      if (args.roaster !== undefined) change.roaster = args.roaster;
      if (args["roast-date"] !== undefined) change.roast_date = args["roast-date"];
      if (args.grind !== undefined) change.grind_setting = args.grind;
      if (args.dose !== undefined) {
        const dose = Number(args.dose);
        if (!Number.isFinite(dose) || dose <= 0) {
          console.error(`--dose must be a positive number, got ${JSON.stringify(args.dose)}`);
          process.exit(2);
        }
        change.dose_g = dose;
      }
      if (args.basket !== undefined) change.basket = args.basket;
      if (args.note !== undefined) change.note = args.note;

      if (Object.keys(change).length === 0) {
        console.error("set-setup needs at least one field to change");
        process.exit(2);
      }
      const setup = recordSetup(db, change);
      console.log(
        `setup #${setup.id}: ${setup.bean ?? "?"} | grind ${setup.grind_setting ?? "?"} | dose ${setup.dose_g ?? "?"} g`
      );
      break;
    }

    case "fix-setup": {
      const id = Number(args.id);
      if (!Number.isInteger(id)) {
        console.error("fix-setup needs --id");
        process.exit(2);
      }
      const change: SetupChange = {};
      if (args.bean !== undefined) change.bean = args.bean;
      if (args.roaster !== undefined) change.roaster = args.roaster;
      if (args["roast-date"] !== undefined) change.roast_date = args["roast-date"];
      if (args.grind !== undefined) change.grind_setting = args.grind;
      if (args.dose !== undefined) {
        const dose = Number(args.dose);
        if (!Number.isFinite(dose) || dose <= 0) {
          console.error(`--dose must be a positive number, got ${JSON.stringify(args.dose)}`);
          process.exit(2);
        }
        change.dose_g = dose;
      }
      if (args.basket !== undefined) change.basket = args.basket;
      if (args.note !== undefined) change.note = args.note;
      if (args["valid-from"] !== undefined) {
        const validFrom = Number(args["valid-from"]);
        if (!Number.isInteger(validFrom) || validFrom <= 0) {
          console.error(`--valid-from must be unix seconds, got ${JSON.stringify(args["valid-from"])}`);
          process.exit(2);
        }
        change.valid_from = validFrom;
      }

      const setup = updateSetup(db, id, change);
      if (!setup) {
        console.error(`no setup with id ${id}`);
        process.exit(1);
      }
      console.log(
        `setup #${setup.id}: ${setup.bean ?? "?"} | grind ${setup.grind_setting ?? "?"} | dose ${setup.dose_g ?? "?"} g`
      );
      break;
    }

    case "print": {
      const arg = rest.find((a) => !a.startsWith("--"));
      const id = arg ? Number(arg) : (db.prepare("SELECT id FROM shot_context ORDER BY started_at DESC LIMIT 1").get() as { id: number } | undefined)?.id;
      if (id == null) { console.error("nothing to print"); process.exitCode = 1; break; }
      const result = await printShot(db, id);
      if (!result.ok) { console.error(`${result.code}: ${result.message}`); process.exitCode = 1; break; }
      console.log(`printed shot ${id}: ${result.lines} lines${result.completed ? "" : " (completion not confirmed)"}`);
      break;
    }

    case "printer-test": {
      const result = await printTest(db);
      console.log(result.ok ? `test strip printed (${result.lines} lines)` : `${result.code}: ${result.message}`);
      if (!result.ok) process.exitCode = 1;
      break;
    }

    case "printer-status": {
      const result = await printerStatus(db);
      console.log(result.ok ? JSON.stringify(result.status) : `${result.code}: ${result.message}`);
      if (!result.ok) process.exitCode = 1;
      break;
    }

    case "printer-scan": {
      const found = await findPrinters();
      if (!found.bluetooth) { console.error("no Bluetooth adapter"); process.exitCode = 1; break; }
      for (const d of found.devices) console.log(`  ${d.address}  ${String(d.rssi ?? "").padStart(4)}  ${d.name ?? ""}${d.printer_like ? "  <- printer?" : ""}`);
      break;
    }

    case "mode": {
      const result = await changeMode(rest.find((a) => !a.startsWith("--")) ?? "");
      if (!result.ok) { console.error(result.message); process.exitCode = 1; break; }
      console.log(`mode ${result.previous} -> ${result.mode}`);
      break;
    }

    case "status": {
      // Written for a status badge: one line, the machine's own words first.
      const c = currentConditions(db, await fetchStatus());
      if (!c.reachable) {
        console.log("vypnuto");
        break;
      }
      const temp = `${c.current_temp!.toFixed(1)} C`;
      const target = (c.target_temp ?? 0) > 0 ? ` / ${c.target_temp}` : "";
      const state =
        c.mode_name === "standby" ? "standby" : c.at_target ? "na teplote" : c.trend === "heating" ? "topi" : c.trend ?? "";
      const heating = c.heating_for_s != null ? `, topi ${human(c.heating_for_s)}` : "";
      const warm = c.settledness != null ? `, nahrato ${c.settledness} %` : "";
      const power = c.powered_for_s != null ? `, zapnuto ${human(c.powered_for_s)}` : "";
      console.log(`${temp}${target}  ${state}${heating}${warm}${power}`);
      break;
    }

    case "last": {
      const r = db
        .prepare("SELECT * FROM shot_context ORDER BY started_at DESC LIMIT 1")
        .get() as any;
      if (!r) {
        console.log("zadny shot");
        break;
      }
      const when = new Date(r.started_at * 1000).toLocaleString("cs-CZ", {
        timeZone: "Europe/Prague",
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "numeric",
      });
      const out = r.stable_weight_g != null ? `${r.stable_weight_g} g` : "bez vahy";
      const ratio = r.ratio != null ? ` (1:${r.ratio})` : "";
      const warm =
        r.machine_settledness != null
          ? `, stroj nahraty ${r.machine_settledness} %`
          : r.machine_heating_for_s != null ? `, stroj topil ${human(r.machine_heating_for_s)}` : "";
      console.log(`#${r.id} ${when}  ${(r.duration_ms / 1000).toFixed(1)} s  ${out}${ratio}${warm}`);
      break;
    }

    case "show": {
      const setup = currentSetup(db);
      if (!setup) {
        console.log("no setup recorded yet");
        break;
      }
      console.log(
        `${setup.bean ?? "?"} | grind ${setup.grind_setting ?? "?"} | dose ${setup.dose_g ?? "?"} g`
      );
      break;
    }

    case "ingest": {
      const result = await ingestOnce(db);
      console.log(`archived ${result.archived}, notes ${result.notesSynced}, failures ${result.failures.length}`);
      break;
    }

    case "recompute-weights": {
      const changed = recomputeStableWeights(db, args.all === "true");
      console.log(`re-derived stable weight for ${changed} shot(s)`);
      break;
    }

    case "calibrate": {
      // The bloom phase has no pump flow, so its temperature is the boiler
      // and group talking to each other with no fresh water in between: the
      // cleanest readout of how warm the mass really was. Shots 408/409 on a
      // fresh machine overshot to 98-99 °C there; settled ones sit at 92-93.
      // If settledness tracks that, TAU_HEAT is right; if not, adjust it via
      // GAGGIMATE_TAU_HEAT_MIN and recompute-context --all.
      console.log(`TAU_HEAT = ${TAU_HEAT_MIN} min`);
      console.log("shot  topil     nahrato  bloom °C  cíl   odchylka");
      const rows = db
        .prepare("SELECT id, raw_slog, machine_heating_for_s h, machine_settledness sd FROM shots ORDER BY id")
        .all() as any[];
      for (const row of rows) {
        if (!row.raw_slog) continue;
        const shot = parseSlog(Buffer.from(row.raw_slog), row.id);
        const bloom = shot.samples
          .filter((x: any) => x.t != null && x.t >= 14500 && x.t <= 20000 && x.ct != null)
          .map((x: any) => x.ct as number);
        if (bloom.length === 0) continue;
        const avg = bloom.reduce((a: number, b: number) => a + b, 0) / bloom.length;
        const target = shot.samples.find((x: any) => (x.tt ?? 0) > 0)?.tt ?? 94;
        console.log(
          `${String(row.id).padEnd(5)} ${(row.h == null ? "?" : human(row.h)).padStart(7)}  ` +
            `${(row.sd == null ? "?" : row.sd + " %").padStart(7)}  ${avg.toFixed(1).padStart(8)}  ${String(target).padStart(3)}   ${(avg - target >= 0 ? "+" : "") + (avg - target).toFixed(1)}`
        );
      }
      break;
    }

    case "recompute-context": {
      const changed = recomputeMachineContext(db, args.all === "true");
      console.log(`re-derived machine context for ${changed} shot(s)`);
      break;
    }

    case "event": {
      const ev = recordEvent(db, { title: args.title ?? "", kind: args.kind, note: args.note, at: args.at ? Number(args.at) : undefined });
      console.log(`event #${ev.id}: ${ev.kind} — ${ev.title}`);
      break;
    }

    case "events": {
      for (const ev of listEvents(db)) console.log(`  #${ev.id}  ${new Date(ev.at * 1000).toISOString().slice(0, 16)}  ${ev.kind.padEnd(11)} ${ev.title}${ev.note ? "  (" + ev.note + ")" : ""}`);
      break;
    }

    case "maintenance": {
      for (const m of maintenanceStatus(db)) {
        if (!m.enabled) continue;
        const used = [
          m.interval_shots != null ? `${m.shots_since ?? "?"}/${m.interval_shots} shots` : null,
          m.interval_water_l != null ? `${m.water_l_since ?? "?"}/${m.interval_water_l} l` : null,
          m.interval_days != null ? `${m.days_since ?? "?"}/${m.interval_days} days` : null,
        ].filter(Boolean).join(", ");
        const last = m.last_at ? new Date(m.last_at * 1000).toISOString().slice(0, 16) : "never";
        console.log(`  ${m.key.padEnd(13)} ${m.state.padEnd(6)} ${used}  last ${last}${m.last_auto ? " (detected)" : ""}`);
      }
      break;
    }

    case "maintenance-done": {
      const entry = logMaintenance(db, rest.find((a) => !a.startsWith("--")) ?? "", { note: args.note, at: args.at ? Number(args.at) : undefined });
      console.log(`logged ${entry.type_key} at ${new Date(entry.at * 1000).toISOString().slice(0, 16)}`);
      break;
    }

    case "stats": {
      const row = db
        .prepare("SELECT COUNT(*) AS shots, MIN(started_at) AS first, MAX(started_at) AS last FROM shots")
        .get() as { shots: number; first: number | null; last: number | null };
      const setups = db.prepare("SELECT COUNT(*) AS n FROM setups").get() as { n: number };
      console.log(`${row.shots} shots, ${setups.n} setups`);
      break;
    }

    default:
      usage();
  }
} finally {
  db.close();
  // The printer commands leave a D-Bus connection open, and an open one
  // keeps the process from exiting (a printer-status hung for minutes on
  // the Pi after it had printed its answer).
  closeBus();
}
