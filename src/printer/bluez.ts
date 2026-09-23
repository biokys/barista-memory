import dbus, { Variant, type ProxyObject, type ClientInterface } from "dbus-next";

/**
 * Just enough BlueZ over the system D-Bus to scan for and talk to a BLE
 * peripheral: no native module, which keeps the image buildable for arm64,
 * and the same API the machine's own tooling (bleak) uses underneath. Needs
 * the host's D-Bus socket in the container (/run/dbus) and a BlueZ adapter.
 */

const BLUEZ = "org.bluez";
const CONNECT_ATTEMPTS = 3;
// Longer than BlueZ's own LE connection timeout, so its error (the reason)
// reaches the log instead of our bare "timed out".
const CONNECT_TIMEOUT_MS = 45000;
/** Some adapters refuse a connection started the instant discovery stops. */
const SETTLE_AFTER_SCAN_MS = 1000;
const RESOLVE_TIMEOUT_MS = 15000;

export interface FoundDevice {
  address: string;
  name: string | null;
  rssi: number | null;
  /** Looks like a cat printer of the MXW01 family, by name. */
  printer_like: boolean;
}

type ManagedObjects = Record<string, Record<string, Record<string, Variant>>>;

let bus: ReturnType<typeof dbus.systemBus> | null = null;
function systemBus() {
  if (!bus) bus = dbus.systemBus();
  return bus;
}

/** Drop the D-Bus connection; an open one keeps a one-shot process alive. */
export function closeBus(): void {
  if (!bus) return;
  try { bus.disconnect(); } catch { /* already gone */ }
  bus = null;
}

async function managedObjects(): Promise<ManagedObjects> {
  const root = await systemBus().getProxyObject(BLUEZ, "/");
  const om = root.getInterface("org.freedesktop.DBus.ObjectManager");
  return (await om.GetManagedObjects()) as ManagedObjects;
}

async function adapterPath(): Promise<string> {
  const objects = await managedObjects();
  const path = Object.keys(objects).find((p) => objects[p]["org.bluez.Adapter1"]);
  if (!path) throw new Error("No Bluetooth adapter: is BlueZ running and /run/dbus mounted?");
  return path;
}

export async function bluetoothAvailable(): Promise<boolean> {
  try { await adapterPath(); return true; } catch { return false; }
}

const PRINTER_NAME = /mxw01|mx[0-9]{2}|gb0[1-3]|gt01|catprint|print/i;

function deviceFrom(path: string, props: Record<string, Variant>): FoundDevice {
  const name = (props.Name?.value ?? props.Alias?.value ?? null) as string | null;
  return {
    address: String(props.Address?.value ?? path.split("dev_")[1]?.replace(/_/g, ":") ?? ""),
    name,
    rssi: (props.RSSI?.value as number | undefined) ?? null,
    printer_like: !!name && PRINTER_NAME.test(name),
  };
}

/** Scan for `seconds`, then list every device BlueZ knows about, strongest first. */
export async function scan(seconds = 8): Promise<FoundDevice[]> {
  const path = await adapterPath();
  const obj = await systemBus().getProxyObject(BLUEZ, path);
  const adapter = obj.getInterface("org.bluez.Adapter1");
  const props = obj.getInterface("org.freedesktop.DBus.Properties");
  const powered = (await props.Get("org.bluez.Adapter1", "Powered")) as Variant;
  if (!powered.value) await props.Set("org.bluez.Adapter1", "Powered", new Variant("b", true));
  try { await adapter.SetDiscoveryFilter({ Transport: new Variant("s", "le") }); } catch { /* older BlueZ */ }
  try { await adapter.StartDiscovery(); } catch (error) { if (!String(error).includes("InProgress")) throw error; }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  try { await adapter.StopDiscovery(); } catch { /* fine */ }
  const objects = await managedObjects();
  return Object.entries(objects)
    .filter(([p, ifaces]) => p.startsWith(path + "/dev_") && ifaces["org.bluez.Device1"])
    .map(([p, ifaces]) => deviceFrom(p, ifaces["org.bluez.Device1"]))
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}

export interface Characteristic {
  write(data: Uint8Array, withResponse: boolean): Promise<void>;
  notify(handler: (data: Uint8Array) => void): Promise<void>;
}

export interface Connection {
  characteristic(uuid: string): Promise<Characteristic>;
  disconnect(): Promise<void>;
}

function devicePath(adapter: string, address: string): string {
  return `${adapter}/dev_${address.toUpperCase().replace(/:/g, "_")}`;
}

/**
 * Connect to a device by address. BlueZ often fails the first attempt and
 * only knows a device it has seen, so a miss triggers a short scan first.
 */
/**
 * Wait until the device is advertising right now. BlueZ keeps a device
 * object from any earlier scan, and Connect() on a stale one just times out
 * after twenty seconds; a cat printer that went to sleep is exactly that.
 * RSSI is only present on a device while its advertisements arrive.
 */
async function waitForAdvertising(adapter: string, path: string, ms: number): Promise<Record<string, Variant> | null> {
  const obj = await systemBus().getProxyObject(BLUEZ, adapter);
  const a = obj.getInterface("org.bluez.Adapter1");
  // Forget what BlueZ cached about the device (an unpaired, unconnected
  // entry) so the address type and everything else come from this scan's
  // advertisement. A stale entry connects to the wrong address type and
  // simply times out; Home Assistant's own connector clears the cache the
  // same way when connections fail.
  try {
    const objects = await managedObjects();
    const dev = objects[path]?.["org.bluez.Device1"];
    if (dev && !dev.Connected?.value && !dev.Paired?.value) await a.RemoveDevice(path);
  } catch { /* not cached, fine */ }
  try { await a.SetDiscoveryFilter({ Transport: new Variant("s", "le") }); } catch { /* older BlueZ */ }
  try { await a.StartDiscovery(); } catch (error) { if (!String(error).includes("InProgress")) throw error; }
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const objects = await managedObjects();
      const dev = objects[path]?.["org.bluez.Device1"];
      if (dev && (dev.RSSI != null || dev.Connected?.value)) return dev;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  } finally {
    try { await a.StopDiscovery(); } catch { /* fine */ }
  }
}

function describe(dev: Record<string, Variant> | null): string {
  if (!dev) return "";
  return ` [AddressType=${dev.AddressType?.value} RSSI=${dev.RSSI?.value ?? "?"} Connected=${dev.Connected?.value} Paired=${dev.Paired?.value} Name=${dev.Name?.value ?? "?"}]`;
}

/**
 * What BlueZ build we are talking to, for the log. The per-bearer interfaces
 * exist only when bluetoothd runs with -E (Home Assistant OS does, the Pi
 * does not); Adapter1.ExperimentalFeatures is a different thing, the
 * kernel-side experimental features, and was read as "-E is off" once.
 */
async function describeStack(adapter: string, device: ProxyObject): Promise<string> {
  try {
    const objects = await managedObjects();
    const kernel = objects[adapter]?.["org.bluez.Adapter1"]?.ExperimentalFeatures?.value as string[] | undefined;
    const bearer = Object.keys(device.interfaces).includes("org.bluez.Bearer.LE1");
    return ` [bluetoothd-experimental=${bearer ? "yes" : "no"} kernel-experimental=${kernel ? kernel.length : "no"}]`;
  } catch {
    return "";
  }
}

export async function connect(address: string, attempts = CONNECT_ATTEMPTS): Promise<Connection> {
  const adapter = await adapterPath();
  const path = devicePath(adapter, address);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const seen = await waitForAdvertising(adapter, path, attempt === 1 ? 8000 : 4000);
      if (!seen) throw new Error("not advertising: the printer is asleep or off — switch it on and try again");
      await new Promise((r) => setTimeout(r, SETTLE_AFTER_SCAN_MS));
      const obj = await systemBus().getProxyObject(BLUEZ, path);
      const device = obj.getInterface("org.bluez.Device1");
      const props = obj.getInterface("org.freedesktop.DBus.Properties");
      // A timeline of what the device object did while Connect() was
      // pending. On Home Assistant OS Connect() neither succeeds nor fails
      // within 45 s; whether the link ever came up is what tells a radio
      // problem from a BlueZ one, and the log is the only place to see it.
      const started = Date.now();
      const timeline: string[] = [];
      const note = (what: string) => timeline.push(`+${((Date.now() - started) / 1000).toFixed(1)}s ${what}`);
      let servicesResolved!: () => void;
      const whenResolved = new Promise<void>((resolve) => { servicesResolved = resolve; });
      const onChange = (iface: string, changed: Record<string, Variant>) => {
        if (iface !== "org.bluez.Device1") return;
        for (const key of ["Connected", "ServicesResolved"]) if (changed[key]) note(`${key}=${changed[key].value}`);
        if (changed.ServicesResolved?.value === true) servicesResolved();
      };
      props.on("PropertiesChanged", onChange);
      try {
        // BlueZ answers Connect() only after it has browsed the GATT
        // database; if ServicesResolved arrives first the device is usable,
        // whatever BlueZ still owes us. The late reply must not surface as
        // an unhandled rejection.
        const reply = connectOverLe(obj, device, props, note);
        reply.catch(() => {});
        await withTimeout(Promise.race([reply, whenResolved]), CONNECT_TIMEOUT_MS, "connect");
      } catch (error) {
        // Cancel the pending request, or the next attempt gets InProgress.
        device.Disconnect().catch(() => {});
        // What the scan saw, for the log: address type and signal are what
        // usually explain an LE connection that never completes.
        const events = timeline.length ? ` events: ${timeline.join(", ")}` : " events: none";
        throw new Error(`${error instanceof Error ? error.message : error}${describe(seen)}${await describeStack(adapter, obj)}${events}`);
      } finally {
        props.removeListener("PropertiesChanged", onChange);
      }
      await waitForProperty(props, "org.bluez.Device1", "ServicesResolved", true, RESOLVE_TIMEOUT_MS);
      return connection(path, obj);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`could not connect to ${address}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

/**
 * Connect over LE explicitly. The MXW01 advertises flags that claim BR/EDR
 * support it does not have, and BlueZ 5.80+ answers Device1.Connect() on such
 * a "dual-mode" device by trying classic Bluetooth first — which never
 * completes (seen on Home Assistant OS, BlueZ 5.8x, 2026-09-23; BlueZ 5.66
 * on the Pi has no such logic and connected at once). The per-bearer
 * interface, or the PreferredBearer property where only that exists, pins
 * the attempt to LE; older BlueZ has neither and Connect() is right there.
 */
async function connectOverLe(obj: ProxyObject, device: ClientInterface, props: ClientInterface, note: (what: string) => void): Promise<void> {
  const ifaces = Object.keys(obj.interfaces);
  if (ifaces.includes("org.bluez.Bearer.LE1")) {
    note("Bearer.LE1.Connect()");
    await obj.getInterface("org.bluez.Bearer.LE1").Connect();
    note("Bearer.LE1.Connect() returned");
    return;
  }
  let preferred = "PreferredBearer=le";
  try {
    await props.Set("org.bluez.Device1", "PreferredBearer", new Variant("s", "le"));
  } catch {
    preferred = "no PreferredBearer";
  }
  note(`Device1.Connect() (${preferred})`);
  await device.Connect();
  note("Device1.Connect() returned");
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function waitForProperty(props: ClientInterface, iface: string, name: string, wanted: unknown, ms: number): Promise<void> {
  const current = (await props.Get(iface, name)) as Variant;
  if (current.value === wanted) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { props.removeListener("PropertiesChanged", on); reject(new Error(`${name} did not become ${wanted} within ${ms} ms`)); }, ms);
    const on = (i: string, changed: Record<string, Variant>) => {
      if (i === iface && changed[name]?.value === wanted) { clearTimeout(t); props.removeListener("PropertiesChanged", on); resolve(); }
    };
    props.on("PropertiesChanged", on);
  });
}

function connection(path: string, deviceObj: ProxyObject): Connection {
  return {
    async characteristic(uuid) {
      const objects = await managedObjects();
      const charPath = Object.keys(objects).find(
        (p) => p.startsWith(path + "/") && objects[p]["org.bluez.GattCharacteristic1"]?.UUID?.value === uuid
      );
      if (!charPath) throw new Error(`characteristic ${uuid} not found on ${path}`);
      const obj = await systemBus().getProxyObject(BLUEZ, charPath);
      const ch = obj.getInterface("org.bluez.GattCharacteristic1");
      const props = obj.getInterface("org.freedesktop.DBus.Properties");
      return {
        async write(data, withResponse) {
          await ch.WriteValue(Array.from(data), { type: new Variant("s", withResponse ? "request" : "command") });
        },
        async notify(handler) {
          props.on("PropertiesChanged", (iface: string, changed: Record<string, Variant>) => {
            if (iface === "org.bluez.GattCharacteristic1" && changed.Value) handler(Uint8Array.from(changed.Value.value as number[]));
          });
          await ch.StartNotify();
        },
      };
    },
    async disconnect() {
      try { await deviceObj.getInterface("org.bluez.Device1").Disconnect(); } catch { /* already gone */ }
    },
  };
}
