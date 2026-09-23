import mqtt, { type MqttClient } from "mqtt";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { MachineStatus } from "./device/client.js";
import { currentConditions } from "./machineState.js";
import { maintenanceStatus } from "./maintenance.js";
import { changeMode, SWITCHABLE_MODES } from "./machineControl.js";
import { printShot, printerSettings } from "./printer/index.js";
import { currentStock } from "./coffeeStats.js";
import type { ShotContextRow } from "./db/db.js";

/**
 * Home Assistant integration over MQTT.
 *
 * One retained JSON state message per daemon pass and a set of discovery
 * messages that make Home Assistant create the entities on its own: warm-up
 * percent, a "ready" binary sensor (the thing a notification hangs on),
 * boiler and target temperature, mode as both a sensor and a select that
 * switches the machine, the last shot, and whether maintenance is due.
 * Nothing here is required: without GAGGIMATE_MQTT_URL the daemon never
 * loads this module.
 */

/** Below the threshold minus this the ready sensor turns off again: no flapping at 85 %. */
const READY_HYSTERESIS_PCT = 5;

export interface MqttBridge {
  publish(db: DatabaseSync, live: MachineStatus | null): void;
  close(): Promise<void>;
}

interface Device {
  identifiers: string[];
  name: string;
  manufacturer: string;
  model: string;
  sw_version: string;
}

export function startMqtt(db: DatabaseSync, version: string, log: (line: string) => void = console.log): MqttBridge {
  const prefix = config.mqttPrefix;
  const stateTopic = `${prefix}/state`;
  const availabilityTopic = `${prefix}/availability`;
  const modeCommandTopic = `${prefix}/cmd/mode`;
  const printCommandTopic = `${prefix}/cmd/print`;
  let ready = false;
  let latest: { db: DatabaseSync; live: MachineStatus | null } | null = null;

  const client: MqttClient = mqtt.connect(config.mqttUrl, {
    username: config.mqttUser || undefined,
    password: config.mqttPassword || undefined,
    clientId: `${prefix}-${Math.random().toString(16).slice(2, 8)}`,
    will: { topic: availabilityTopic, payload: "offline", retain: true, qos: 0 },
    reconnectPeriod: 5000,
  });

  const device: Device = {
    identifiers: [prefix],
    name: "Barista Memory",
    manufacturer: "barista-memory",
    model: "GaggiMate shot archive",
    sw_version: version,
  };

  /** Entity available only while the machine answers. */
  const liveAvailability = {
    availability_mode: "all",
    availability: [
      { topic: availabilityTopic },
      { topic: stateTopic, value_template: "{{ 'online' if value_json.reachable else 'offline' }}" },
    ],
  };
  const alwaysAvailability = { availability: [{ topic: availabilityTopic }] };

  const entity = (component: string, id: string, extra: Record<string, unknown>) => ({
    topic: `${config.haDiscoveryPrefix}/${component}/${prefix}/${id}/config`,
    payload: {
      unique_id: `${prefix}_${id}`,
      object_id: `${prefix}_${id}`,
      state_topic: stateTopic,
      device,
      ...extra,
    },
  });

  const discovery = [
    entity("sensor", "warmup", {
      name: "Machine warm-up", icon: "mdi:thermometer-lines", unit_of_measurement: "%", state_class: "measurement",
      value_template: "{{ value_json.settledness if value_json.settledness is not none else 'unknown' }}", ...alwaysAvailability,
    }),
    entity("binary_sensor", "ready", {
      name: "Machine ready", icon: "mdi:coffee-maker-check",
      value_template: "{{ 'ON' if value_json.ready else 'OFF' }}", ...alwaysAvailability,
    }),
    entity("binary_sensor", "on", {
      name: "Machine on", device_class: "running",
      value_template: "{{ 'ON' if value_json.reachable else 'OFF' }}", ...alwaysAvailability,
    }),
    entity("sensor", "boiler_temperature", {
      name: "Boiler temperature", device_class: "temperature", unit_of_measurement: "°C", state_class: "measurement",
      suggested_display_precision: 1, value_template: "{{ value_json.boiler_temp }}", ...liveAvailability,
    }),
    entity("sensor", "target_temperature", {
      name: "Target temperature", device_class: "temperature", unit_of_measurement: "°C",
      value_template: "{{ value_json.target_temp }}", ...liveAvailability,
    }),
    entity("sensor", "mode", {
      name: "Machine mode", icon: "mdi:state-machine",
      value_template: "{{ value_json.mode }}", ...liveAvailability,
    }),
    entity("select", "mode_select", {
      name: "Machine mode", icon: "mdi:coffee-maker", options: [...SWITCHABLE_MODES],
      command_topic: modeCommandTopic,
      value_template: "{{ value_json.mode if value_json.mode in ['standby','brew','steam','water'] else 'None' }}",
      ...liveAvailability,
    }),
    entity("button", "print_last", {
      name: "Print last shot", icon: "mdi:printer-pos", command_topic: printCommandTopic, payload_press: "last", ...alwaysAvailability,
    }),
    entity("sensor", "heating_for", {
      name: "Heating for", device_class: "duration", unit_of_measurement: "s", icon: "mdi:timer-outline",
      value_template: "{{ value_json.heating_for_s if value_json.heating_for_s is not none else 'unknown' }}", ...liveAvailability,
    }),
    entity("sensor", "last_shot", {
      name: "Last shot", icon: "mdi:coffee",
      value_template: "{{ value_json.last_shot.id if value_json.last_shot else 'none' }}",
      json_attributes_topic: stateTopic, json_attributes_template: "{{ value_json.last_shot | tojson }}", ...alwaysAvailability,
    }),
    entity("binary_sensor", "maintenance_due", {
      name: "Maintenance due", device_class: "problem",
      value_template: "{{ 'ON' if value_json.maintenance.due else 'OFF' }}",
      json_attributes_topic: stateTopic, json_attributes_template: "{{ value_json.maintenance | tojson }}", ...alwaysAvailability,
    }),
    entity("sensor", "coffee_remaining", {
      name: "Coffee remaining", icon: "mdi:sack", unit_of_measurement: "g", state_class: "measurement",
      value_template: "{{ value_json.coffee.remaining_g if value_json.coffee and value_json.coffee.remaining_g is not none else 'unknown' }}",
      json_attributes_topic: stateTopic, json_attributes_template: "{{ (value_json.coffee or {}) | tojson }}", ...alwaysAvailability,
    }),
    entity("sensor", "coffee_days_left", {
      name: "Coffee days left", icon: "mdi:calendar-clock", unit_of_measurement: "d",
      value_template: "{{ value_json.coffee.days_left if value_json.coffee and value_json.coffee.days_left is not none else 'unknown' }}", ...alwaysAvailability,
    }),
    entity("binary_sensor", "coffee_low", {
      name: "Coffee running low", icon: "mdi:sack-percent",
      value_template: "{{ 'ON' if value_json.coffee and value_json.coffee.low else 'OFF' }}", ...alwaysAvailability,
    }),
    entity("sensor", "shots_since_backflush", {
      name: "Shots since backflush", icon: "mdi:counter", state_class: "total",
      value_template: "{{ value_json.maintenance.backflush_shots if value_json.maintenance.backflush_shots is not none else 'unknown' }}", ...alwaysAvailability,
    }),
  ];

  client.on("connect", () => {
    log(`mqtt: connected to ${config.mqttUrl}`);
    for (const d of discovery) client.publish(d.topic, JSON.stringify(d.payload), { retain: true });
    client.publish(availabilityTopic, "online", { retain: true });
    client.subscribe([modeCommandTopic, printCommandTopic]);
    if (latest) publishState(latest.db, latest.live);
  });
  client.on("error", (error) => log(`mqtt: ${error.message}`));

  client.on("message", async (topic, payload) => {
    if (topic === printCommandTopic && latest) {
      const text = payload.toString().trim();
      const id = /^\d+$/.test(text) ? Number(text)
        : (latest.db.prepare("SELECT id FROM shot_context ORDER BY started_at DESC LIMIT 1").get() as { id: number } | undefined)?.id;
      if (id == null) return;
      const result = await printShot(latest.db, id);
      log(result.ok ? `mqtt: printed shot ${id}` : `mqtt: print of shot ${id} failed: ${result.message}`);
      return;
    }
    if (topic !== modeCommandTopic) return;
    const mode = payload.toString().trim();
    const result = await changeMode(mode);
    log(result.ok ? `mqtt: mode -> ${result.mode}` : `mqtt: mode ${mode} refused: ${result.message}`);
    if (latest) {
      // Re-read the machine so the select reflects the outcome at once.
      const { fetchStatus } = await import("./device/client.js");
      publishState(latest.db, await fetchStatus());
    }
  });

  function publishState(dbNow: DatabaseSync, live: MachineStatus | null): void {
    const c = currentConditions(dbNow, live);
    const pct = c.settledness ?? 0;
    // Hysteresis: on at the threshold, off only once clearly below it.
    const eligible = c.reachable && c.mode_name === "brew";
    ready = eligible && (ready ? pct >= config.readyPct - READY_HYSTERESIS_PCT : pct >= config.readyPct);

    const last = dbNow.prepare("SELECT * FROM shot_context ORDER BY started_at DESC LIMIT 1").get() as unknown as ShotContextRow | undefined;
    const maint = maintenanceStatus(dbNow).filter((m) => m.enabled);
    const backflush = maint.find((m) => m.key === "backflush");

    const state = {
      reachable: c.reachable,
      mode: c.mode_name ?? "off",
      settledness: c.settledness,
      ready,
      boiler_temp: c.current_temp != null ? Math.round(c.current_temp * 10) / 10 : null,
      target_temp: c.target_temp,
      heating_for_s: c.heating_for_s,
      powered_for_s: c.powered_for_s,
      last_shot: last
        ? {
            id: last.id, started_at: last.started_at, profile: last.profile_name, bean: last.bean, roaster: last.roaster,
            grind: last.grind_setting, dose_g: last.dose_g, weight_g: last.stable_weight_g, ratio: last.ratio,
            duration_s: last.duration_ms != null ? Math.round(last.duration_ms / 100) / 10 : null, rating: last.rating,
            machine_settledness: last.machine_settledness,
            receipt_url: config.webUrl ? `${config.webUrl}/api/shots/${last.id}/receipt.png` : null,
          }
        : null,
      printer: { configured: printerSettings(dbNow).mac !== "", print_each_shot: printerSettings(dbNow).print_each_shot },
      // The bag being ground from: remaining grams and days, from bag_g on
      // the coffee minus the doses pulled since its roast-date period opened.
      coffee: currentStock(dbNow),
      maintenance: {
        due: maint.some((m) => m.state === "due"),
        soon: maint.some((m) => m.state === "soon"),
        backflush_shots: backflush?.shots_since ?? null,
        routines: Object.fromEntries(maint.map((m) => [m.key, { state: m.state, fraction: m.fraction, last_at: m.last_at }])),
      },
      updated_at: Math.floor(Date.now() / 1000),
    };
    client.publish(stateTopic, JSON.stringify(state), { retain: true });
  }

  return {
    publish(dbNow, live) {
      latest = { db: dbNow, live };
      if (client.connected) publishState(dbNow, live);
    },
    async close() {
      if (client.connected) client.publish(availabilityTopic, "offline", { retain: true });
      await client.endAsync();
    },
  };
}
