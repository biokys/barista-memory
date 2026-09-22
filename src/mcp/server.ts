#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { openDatabase, currentSetup, type ShotContextRow } from "../db/db.js";
import { fetchStatus, listProfiles, getProfile, fetchRawSettings } from "../device/client.js";
import { loadArchivedShot } from "../shots.js";
import { saveProfileMerged, selectProfileOnMachine } from "../profiles.js";
import { recordEvent, listEvents, eraOf, EVENT_KINDS } from "../events.js";
import { changeMode, SWITCHABLE_MODES } from "../machineControl.js";
import { maintenanceStatus, logMaintenance, listMaintenanceLog, markLastFlushAsCafiza, MAINTENANCE_KEYS } from "../maintenance.js";
import { groupSettings } from "../device/machineSettings.js";
import { PHASE_ARRAY_SCHEMA } from "./profileSchema.js";
import { recordSetup, moveSetup, updateSetup } from "../setups.js";
import { ingestOnce, recomputeStableWeights, recomputeMachineContext } from "../ingest.js";
import { powerSessions, currentConditions, MODE_NAMES } from "../machineState.js";

const db = openDatabase(config.databasePath);

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(message: string, code: string) {
  return ok({ error: true, message, code });
}

const TOOLS: Tool[] = [
  {
    name: "get_current_setup",
    description:
      "Get the brewing context currently in force: beans, roaster, roast date, grind setting, dose and basket. " +
      "This is what new shots inherit, so it is the answer to 'what am I pulling right now'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_current_setup",
    description:
      "Record a change to the brewing context — new beans, a grind adjustment, a different dose. " +
      "Only pass what changed: every field left out keeps its current value. This opens a new period, so " +
      "shots already archived keep the context they were actually pulled under.",
    inputSchema: {
      type: "object",
      properties: {
        bean: { type: "string", description: "Bean name, e.g. 'Rwanda Kinini'" },
        roaster: { type: "string", description: "Roaster name" },
        roast_date: { type: "string", description: "Roast date as YYYY-MM-DD" },
        grind_setting: { type: "string", description: "Grinder setting, free text (e.g. '3.2')" },
        dose_g: { type: "number", description: "Dose in grams of dry coffee" },
        basket: { type: "string", description: "Basket, e.g. '18g VST'" },
        note: { type: "string", description: "Why this changed; stored with this period only" },
        valid_from: {
          type: "number",
          description: "Unix seconds when the change took effect. Defaults to now; pass an earlier time to backdate it.",
        },
      },
    },
  },
  {
    name: "list_setups",
    description: "List brewing context periods, newest first, to see when beans or grind changed.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Maximum periods to return (default 20)" } },
    },
  },
  {
    name: "move_setup",
    description:
      "Correct when a setup period started. Use when a grind or bean change is realised to have happened " +
      "before or after it was recorded; every shot in the moved range re-derives its context automatically.",
    inputSchema: {
      type: "object",
      properties: {
        setup_id: { type: "number", description: "Setup id from list_setups" },
        valid_from: { type: "number", description: "New start, unix seconds" },
      },
      required: ["setup_id", "valid_from"],
    },
  },
  {
    name: "update_setup",
    description:
      "Correct the values of an existing setup period — a typo, or a value entered on the wrong scale. " +
      "Unlike set_current_setup this does not open a new period: it fixes one that was recorded wrong, and " +
      "every shot in that period re-derives.",
    inputSchema: {
      type: "object",
      properties: {
        setup_id: { type: "number", description: "Setup id from list_setups" },
        bean: { type: "string" },
        roaster: { type: "string" },
        roast_date: { type: "string", description: "YYYY-MM-DD" },
        grind_setting: { type: "string" },
        dose_g: { type: "number" },
        basket: { type: "string" },
        note: { type: "string" },
        valid_from: { type: "number", description: "Unix seconds; same effect as move_setup" },
      },
      required: ["setup_id"],
    },
  },
  {
    name: "record_event",
    description:
      "Record a one-off turning point that is not a setup value: a new WDT tool, a puck screen, a different " +
      "basket or portafilter, a change of technique, descaling. Every later shot belongs to its era, so shots " +
      "before and after can be compared. Backdate with `at` when it actually happened earlier.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "e.g. 'WDT tool', 'puck screen', '18g VST basket'" },
        kind: { type: "string", enum: [...EVENT_KINDS], description: "Default 'other'" },
        note: { type: "string" },
        at: { type: "number", description: "Unix seconds; defaults to now" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_events",
    description: "Turning points recorded with record_event, newest first.",
    inputSchema: { type: "object", properties: { since: { type: "number" } } },
  },
  {
    name: "maintenance_status",
    description:
      "Where each cleaning routine stands: backflush and Cafiza are worn down by coffees pulled, descaling by " +
      "litres of water pumped. Backflushes are detected automatically from runs on the machine's utility " +
      "profile; Cafiza and descaling must be recorded with record_maintenance. state is never|ok|soon|due.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "record_maintenance",
    description: "Record that a routine was done just now (or at `at`). Use 'cafiza' for a chemical backflush.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...MAINTENANCE_KEYS] },
        note: { type: "string" },
        at: { type: "number", description: "Unix seconds; defaults to now" },
        last_flush_was_cafiza: {
          type: "boolean",
          description: "Instead of a new entry, mark the most recent auto-detected backflush as a Cafiza run",
        },
      },
    },
  },
  {
    name: "query_shots",
    description:
      "List archived shots with the brewing context they were pulled under (bean, dose, grind, ratio, rating). " +
      "Covers shots the machine itself has already rotated away. Filters combine with AND.",
    inputSchema: {
      type: "object",
      properties: {
        bean: { type: "string", description: "Only shots pulled with this bean (exact match)" },
        grind_setting: { type: "string", description: "Only shots at this grind setting" },
        profile_name: { type: "string", description: "Only shots on this brewing profile" },
        since: { type: "number", description: "Only shots started at or after this unix time" },
        until: { type: "number", description: "Only shots started at or before this unix time" },
        min_rating: { type: "number", description: "Only shots rated at least this" },
        limit: { type: "number", description: "Maximum shots to return (default 50)" },
      },
    },
  },
  {
    name: "get_archived_shot",
    description:
      "Get one archived shot in full: its curve (temperature, pressure, flow, weight over time), its phases, " +
      "and the brewing context. Works for shots no longer on the machine.",
    inputSchema: {
      type: "object",
      properties: {
        shot_id: { type: "number", description: "Shot id" },
        include_full_curve: {
          type: "boolean",
          description: "Include every sample rather than the per-phase summary. Default false.",
        },
      },
      required: ["shot_id"],
    },
  },
  {
    name: "list_profiles",
    description: "List the brewing profiles on the machine: id, label, temperature, which one is selected.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_profile",
    description: "One brewing profile in full, with every phase's pressure, flow, transition and stop targets.",
    inputSchema: {
      type: "object",
      properties: { profile_id: { type: "string", description: "Profile id from list_profiles" } },
      required: ["profile_id"],
    },
  },
  {
    name: "save_profile",
    description:
      "Create or update a brewing profile on the machine. To update, pass profile_id (or a label that already " +
      "exists): fields left out keep their current value, so changing one phase's transition does not touch the " +
      "description, favourite flag or the other phases. To create, pass a new label with temperature and phases. " +
      "Set utility: true for maintenance profiles such as backflush.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "string", description: "Update this exact profile. Omit to match by label or create." },
        label: { type: "string", description: "Profile name; also used to find an existing profile when profile_id is omitted." },
        temperature: { type: "number", description: "Target water temperature in °C. Default for phases that set none." },
        phases: PHASE_ARRAY_SCHEMA,
        type: { type: "string", enum: ["standard", "pro"] },
        description: { type: "string" },
        favorite: { type: "boolean" },
        utility: { type: "boolean" },
      },
    },
  },
  {
    name: "get_machine_settings",
    description:
      "The machine's own configuration: temperature offset, PID constants, pressure calibration, pump model, " +
      "timings, paired scale. Read-only, and credentials are withheld by an allowlist — the raw endpoint " +
      "returns wifi and Home Assistant passwords in cleartext.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "One of: temperature, pressure, pump, timing, hardware, behavior, warnings (optional)" },
      },
    },
  },
  {
    name: "select_profile",
    description: "Make a profile the machine's current one (what the next shot will use). Confirmed by reading the list back.",
    inputSchema: { type: "object", properties: { profile_id: { type: "string" } }, required: ["profile_id"] },
  },
  {
    name: "set_machine_mode",
    description:
      "Switch the machine between standby, brew, steam and hot water, as its own touch UI does. " +
      "Any running process is stopped by the firmware first. Confirmed against /api/status.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: [...SWITCHABLE_MODES] } },
      required: ["mode"],
    },
  },
  {
    name: "machine_now",
    description:
      "The machine's operating conditions right now: temperature and target, mode, whether it is heating, " +
      "cooling or holding and at what rate, how long it has had power, how long it has been heating and how " +
      "long the boiler took to get there. Answers 'what temperature is it' and 'how long has it been on'. " +
      "Note that the sensor reaches target long before the group and portafilter do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "machine_temperature_history",
    description:
      "The recorded temperature samples over a window, for looking at a heat-up or a cool-down curve. " +
      "Samples are stored on change, so they are dense while the temperature moves and sparse while it holds.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Unix seconds; defaults to the last 6 hours" },
        until: { type: "number", description: "Unix seconds; defaults to now" },
        limit: { type: "number", description: "Maximum samples to return (default 200)" },
      },
    },
  },
  {
    name: "machine_timeline",
    description:
      "When the machine was switched on and off, how long the boiler took to reach temperature, and how many " +
      "shots each session produced. The machine records none of this itself — it is reconstructed from polling " +
      "its status, where no answer means powered off. Use it to tell a shot pulled on a settled machine from " +
      "one pulled while it was still coming up to temperature.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Only sessions from this unix time onwards (optional)" },
        limit: { type: "number", description: "Most recent sessions to return (default 10)" },
      },
    },
  },
  {
    name: "rate_shot",
    description: "Record how a shot actually tasted. Kept separate from anything the machine measured.",
    inputSchema: {
      type: "object",
      properties: {
        shot_id: { type: "number", description: "Shot id" },
        rating: { type: "number", description: "0-5" },
        note: { type: "string", description: "What it tasted like" },
      },
      required: ["shot_id"],
    },
  },
  {
    name: "set_shot_override",
    description:
      "Record that one shot deviated from the setup — a different dose or grind for that pull only. " +
      "Use this instead of set_current_setup when the change was a one-off.",
    inputSchema: {
      type: "object",
      properties: {
        shot_id: { type: "number", description: "Shot id" },
        bean: { type: "string" },
        grind_setting: { type: "string" },
        dose_g: { type: "number" },
        note: { type: "string" },
      },
      required: ["shot_id"],
    },
  },
  {
    name: "recompute_stable_weights",
    description:
      "Re-derive every shot's stable weight from the stored sample logs. Use after the derivation rules " +
      "change: the raw logs are kept precisely so the whole archive can be corrected without re-reading " +
      "the machine, which no longer holds most of these shots.",
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "Redo every shot rather than only those without a derived weight. Default false.",
        },
      },
    },
  },
  {
    name: "recompute_machine_context",
    description:
      "Re-derive each shot's machine warm-up context (how long it had power, how long it had been heating, " +
      "whether the boiler had settled) from the recorded machine state. Shots older than the state record " +
      "stay NULL rather than being guessed.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Redo every shot rather than only those without a value. Default false." },
      },
    },
  },
  {
    name: "ingest_now",
    description:
      "Run an archive pass immediately instead of waiting for the poll: copy any shot the machine holds but " +
      "the archive does not, and push brewing context into the machine's own notes.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server({ name: "gaggimate-archive", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_current_setup": {
        const setup = currentSetup(db);
        return ok({ setup, source: config.deviceHost });
      }

      case "set_current_setup": {
        const setup = recordSetup(db, (args ?? {}) as any);
        return ok({ setup, message: "New brewing context period recorded" });
      }

      case "list_setups": {
        const limit = (args?.limit as number | undefined) ?? 20;
        const setups = db.prepare("SELECT * FROM setups ORDER BY valid_from DESC LIMIT ?").all(limit);
        return ok({ setups, count: setups.length });
      }

      case "move_setup": {
        const setup = moveSetup(db, args!.setup_id as number, args!.valid_from as number);
        if (!setup) return fail(`No setup with id ${args!.setup_id}`, "SETUP_NOT_FOUND");
        return ok({ setup, message: "Setup moved; affected shots re-derive their context" });
      }

      case "update_setup": {
        const { setup_id, ...change } = (args ?? {}) as any;
        const setup = updateSetup(db, setup_id as number, change);
        if (!setup) return fail(`No setup with id ${setup_id}`, "SETUP_NOT_FOUND");
        return ok({ setup, message: "Setup corrected; shots in that period re-derive their context" });
      }

      case "record_event": {
        try {
          return ok({ event: recordEvent(db, args as any) });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), "INVALID");
        }
      }

      case "list_events": {
        const events = listEvents(db, args?.since as number | undefined);
        return ok({ events, count: events.length });
      }

      case "maintenance_status": {
        return ok({ status: maintenanceStatus(db), log: listMaintenanceLog(db, 20) });
      }

      case "record_maintenance": {
        if (args?.last_flush_was_cafiza) {
          const entry = markLastFlushAsCafiza(db);
          return entry ? ok({ entry, status: maintenanceStatus(db) }) : fail("No detected backflush to promote", "NO_DETECTED_FLUSH");
        }
        try {
          const entry = logMaintenance(db, String(args?.type ?? ""), { note: args?.note as string | undefined, at: args?.at as number | undefined });
          return ok({ entry, status: maintenanceStatus(db) });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), "INVALID");
        }
      }

      case "query_shots": {
        const where: string[] = [];
        const params: Array<string | number> = [];
        const add = (clause: string, value: unknown) => {
          if (value !== undefined && value !== null) {
            where.push(clause);
            params.push(value as string | number);
          }
        };
        add("bean = ?", args?.bean);
        add("grind_setting = ?", args?.grind_setting);
        add("profile_name = ?", args?.profile_name);
        add("started_at >= ?", args?.since);
        add("started_at <= ?", args?.until);
        add("rating >= ?", args?.min_rating);

        const limit = (args?.limit as number | undefined) ?? 50;
        const sql =
          "SELECT * FROM shot_context" +
          (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
          " ORDER BY started_at DESC LIMIT ?";
        const shots = db.prepare(sql).all(...params, limit);
        return ok({ shots, count: shots.length });
      }

      case "get_archived_shot": {
        const loaded = loadArchivedShot(db, args!.shot_id as number, (args?.include_full_curve as boolean) ?? false);
        if (!loaded) return fail(`Shot ${args!.shot_id} is not in the archive`, "SHOT_NOT_FOUND");
        return ok({ ...loaded, era: eraOf(db, loaded.context.started_at) });
      }

      case "list_profiles": {
        const profiles = await listProfiles();
        if (!profiles) return fail(`No answer from ${config.deviceHost}`, "MACHINE_UNREACHABLE");
        return ok({
          profiles: profiles.map((p) => ({
            id: p.id, label: p.label, type: p.type, temperature: p.temperature,
            selected: p.selected, favorite: p.favorite, utility: p.utility, phases: p.phases?.length ?? 0,
          })),
          count: profiles.length,
        });
      }

      case "get_profile": {
        const profile = await getProfile(args!.profile_id as string);
        if (!profile) return fail(`No profile "${args!.profile_id}" on the machine`, "PROFILE_NOT_FOUND");
        return ok({ profile });
      }

      case "save_profile": {
        const result = await saveProfileMerged({
          profile_id: args?.profile_id as string | undefined, label: args?.label as string | undefined,
          temperature: args?.temperature as number | undefined, phases: args?.phases as any[] | undefined,
          type: args?.type as string | undefined, description: args?.description as string | undefined,
          favorite: args?.favorite as boolean | undefined, utility: args?.utility as boolean | undefined,
        });
        if (!result.ok) return fail(result.message, result.code);
        return ok({ profile: result.profile, action: result.action });
      }

      case "get_machine_settings": {
        const grouped = groupSettings(await fetchRawSettings());
        const requested = args?.group as string | undefined;
        if (requested && !(requested in grouped.settings)) {
          return fail(`Unknown group "${requested}". Available: ${Object.keys(grouped.settings).join(", ")}`, "UNKNOWN_GROUP");
        }
        return ok({
          settings: requested ? { [requested]: grouped.settings[requested] } : grouped.settings,
          withheld_key_count: grouped.withheld_key_count,
          note: grouped.note,
          source: config.deviceHost,
        });
      }

      case "select_profile": {
        const result = await selectProfileOnMachine(String(args?.profile_id ?? ""));
        return result.ok ? ok(result) : fail(result.message, result.code);
      }

      case "set_machine_mode": {
        const result = await changeMode(String(args?.mode ?? ""));
        return result.ok ? ok(result) : fail(result.message, result.code);
      }

      case "machine_now": {
        const live = await fetchStatus();
        const conditions = currentConditions(db, live);
        return ok({
          ...conditions,
          note:
            "at_target reflects the boiler sensor. The group head and portafilter lag it by a long way, " +
            "so a shot pulled just after the target is reached is not the same as one on a settled machine.",
          source: config.deviceHost,
        });
      }

      case "machine_temperature_history": {
        const now = Math.floor(Date.now() / 1000);
        const since = (args?.since as number | undefined) ?? now - 6 * 3600;
        const until = (args?.until as number | undefined) ?? now;
        const limit = (args?.limit as number | undefined) ?? 200;
        const samples = db
          .prepare(
            "SELECT sampled_at, reachable, mode, target_temp, current_temp FROM machine_state " +
              "WHERE sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at ASC LIMIT ?"
          )
          .all(since, until, limit);
        return ok({ samples, count: samples.length, since, until });
      }

      case "machine_timeline": {
        const sessions = powerSessions(db, args?.since as number | undefined);
        const limit = (args?.limit as number | undefined) ?? 10;
        return ok({
          sessions: sessions.slice(-limit).reverse(),
          note:
            "Reconstructed from status polling, not from the machine, which keeps no uptime. " +
            "A session boundary is a poll that got no answer, so resolution is the poll interval.",
        });
      }

      case "rate_shot": {
        const shotId = args!.shot_id as number;
        if (!db.prepare("SELECT 1 FROM shots WHERE id = ?").get(shotId)) {
          return fail(`Shot ${shotId} is not in the archive`, "SHOT_NOT_FOUND");
        }
        db.prepare(
          "INSERT INTO tastings (shot_id, rating, note, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(shot_id) DO UPDATE SET rating = excluded.rating, note = excluded.note"
        ).run(shotId, (args?.rating as number | undefined) ?? null, (args?.note as string | undefined) ?? null, Math.floor(Date.now() / 1000));
        return ok({ shot: db.prepare("SELECT * FROM shot_context WHERE id = ?").get(shotId) });
      }

      case "set_shot_override": {
        const shotId = args!.shot_id as number;
        if (!db.prepare("SELECT 1 FROM shots WHERE id = ?").get(shotId)) {
          return fail(`Shot ${shotId} is not in the archive`, "SHOT_NOT_FOUND");
        }
        db.prepare(
          "INSERT INTO shot_overrides (shot_id, bean, grind_setting, dose_g, note) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(shot_id) DO UPDATE SET bean = excluded.bean, grind_setting = excluded.grind_setting, " +
            "dose_g = excluded.dose_g, note = excluded.note"
        ).run(
          shotId,
          (args?.bean as string | undefined) ?? null,
          (args?.grind_setting as string | undefined) ?? null,
          (args?.dose_g as number | undefined) ?? null,
          (args?.note as string | undefined) ?? null
        );
        return ok({ shot: db.prepare("SELECT * FROM shot_context WHERE id = ?").get(shotId) });
      }

      case "recompute_stable_weights": {
        const changed = recomputeStableWeights(db, (args?.all as boolean) ?? false);
        return ok({ recomputed: changed });
      }

      case "recompute_machine_context": {
        const changed = recomputeMachineContext(db, (args?.all as boolean) ?? false);
        return ok({ recomputed: changed });
      }

      case "ingest_now": {
        const result = await ingestOnce(db);
        return ok(result);
      }

      default:
        return fail(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), "TOOL_FAILED");
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`gaggimate-archive MCP ready (db: ${config.databasePath}, device: ${config.deviceHost})`);
