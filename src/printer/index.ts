import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { getSetting, setSetting } from "../settings.js";
import { renderShotReceipt, renderTestReceipt, receiptOptions, type Receipt, type ReceiptOptions } from "../receipt.js";
import { connect, scan, bluetoothAvailable, type FoundDevice } from "./bluez.js";
import { Mxw01, packRows, CONTROL_UUID, DATA_UUID, NOTIFY_UUID, DEFAULT_INTENSITY, type PrinterStatus } from "./mxw01.js";

/**
 * The receipt printer as the rest of the code sees it: settings, one print
 * at a time, and a status line. The transport is BlueZ over D-Bus, so
 * nothing here works on a host without Bluetooth — and it says so instead
 * of failing obscurely.
 */

export interface PrinterSettings {
  mac: string;
  print_each_shot: boolean;
  intensity: number;
  lang: "cs" | "en";
  receipt: ReceiptOptions;
}

export function printerSettings(db: DatabaseSync): PrinterSettings {
  return {
    mac: getSetting(db, "printer_mac", config.printerMac).toUpperCase(),
    print_each_shot: getSetting(db, "print_each_shot", "0") === "1",
    intensity: Number(getSetting(db, "print_intensity", String(DEFAULT_INTENSITY))),
    lang: (getSetting(db, "receipt_lang", config.lang) === "cs" ? "cs" : "en"),
    receipt: receiptOptions(db),
  };
}

type SettingsChange = Partial<{
  mac: string | null; print_each_shot: boolean; intensity: number; lang: string;
  cafe_name: string; cafe_tagline: string; thanks: string; greetings: string; web_url: string; show_chart: boolean; show_qr: boolean; auto_caption: boolean;
}>;

export function updatePrinterSettings(db: DatabaseSync, change: SettingsChange): PrinterSettings {
  const text = (key: string, value: string | undefined) => { if (value !== undefined) setSetting(db, key, value.trim() || null); };
  text("cafe_name", change.cafe_name);
  text("cafe_tagline", change.cafe_tagline);
  text("receipt_thanks", change.thanks);
  text("receipt_greetings", change.greetings);
  text("web_url", change.web_url);
  if (change.show_chart !== undefined) setSetting(db, "receipt_chart", change.show_chart ? "1" : "0");
  if (change.show_qr !== undefined) setSetting(db, "receipt_qr", change.show_qr ? "1" : "0");
  if (change.auto_caption !== undefined) setSetting(db, "receipt_auto_caption", change.auto_caption ? "1" : "0");
  if (change.mac !== undefined) setSetting(db, "printer_mac", change.mac ? change.mac.trim().toUpperCase() : null);
  if (change.print_each_shot !== undefined) setSetting(db, "print_each_shot", change.print_each_shot ? "1" : "0");
  if (change.intensity !== undefined) setSetting(db, "print_intensity", String(Math.max(0, Math.min(255, Math.round(change.intensity)))));
  if (change.lang !== undefined) setSetting(db, "receipt_lang", change.lang === "cs" ? "cs" : "en");
  return printerSettings(db);
}

export type PrintResult =
  | { ok: true; lines: number; completed: boolean }
  | { ok: false; code: "NO_PRINTER" | "NO_BLUETOOTH" | "BUSY" | "NOT_FOUND" | "PRINT_FAILED"; message: string };

let busy = false;

async function withPrinter<T>(mac: string, fn: (printer: Mxw01) => Promise<T>, attempts?: number): Promise<T> {
  const link = await connect(mac, attempts);
  try {
    const [control, data, notify] = await Promise.all([link.characteristic(CONTROL_UUID), link.characteristic(DATA_UUID), link.characteristic(NOTIFY_UUID)]);
    let handler: ((d: Uint8Array) => void) | null = null;
    const printer = new Mxw01({
      writeControl: (d) => control.write(d, false),
      writeData: (d) => data.write(d, false),
      onNotify: (h) => { handler = h; },
    });
    await notify.notify((d) => handler?.(d));
    return await fn(printer);
  } finally {
    await link.disconnect();
  }
}

async function printReceipt(db: DatabaseSync, receipt: Receipt): Promise<PrintResult> {
  const settings = printerSettings(db);
  if (!settings.mac) return { ok: false, code: "NO_PRINTER", message: "No printer address set" };
  if (!(await bluetoothAvailable())) return { ok: false, code: "NO_BLUETOOTH", message: "No Bluetooth adapter reachable (BlueZ over D-Bus)" };
  if (busy) return { ok: false, code: "BUSY", message: "A print is already running" };
  busy = true;
  try {
    const rows = packRows(receipt.raster.black, receipt.raster.width, receipt.raster.height);
    const result = await withPrinter(settings.mac, (p) => p.print(rows, receipt.raster.height, settings.intensity));
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Into the service log too: an add-on user sees that, not the API reply.
    console.error(`printer: ${settings.mac}: ${message}`);
    return { ok: false, code: "PRINT_FAILED", message };
  } finally {
    busy = false;
  }
}

export async function printShot(db: DatabaseSync, shotId: number): Promise<PrintResult> {
  const receipt = await renderShotReceipt(db, shotId, printerSettings(db).lang);
  if (!receipt) return { ok: false, code: "NOT_FOUND", message: `No archived shot ${shotId}` };
  return printReceipt(db, receipt);
}

export async function printTest(db: DatabaseSync): Promise<PrintResult> {
  return printReceipt(db, await renderTestReceipt(printerSettings(db).lang, db));
}

export async function printerStatus(db: DatabaseSync): Promise<{ ok: true; status: PrinterStatus } | { ok: false; code: string; message: string }> {
  const settings = printerSettings(db);
  if (!settings.mac) return { ok: false, code: "NO_PRINTER", message: "No printer address set" };
  if (!(await bluetoothAvailable())) return { ok: false, code: "NO_BLUETOOTH", message: "No Bluetooth adapter reachable" };
  if (busy) return { ok: false, code: "BUSY", message: "A print is running" };
  busy = true;
  try {
    // One attempt: this answers a button in the UI, which must come back
    // within the ingress proxy's patience; printing itself keeps retrying.
    return { ok: true, status: await withPrinter(settings.mac, (p) => p.status(), 1) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`printer: ${settings.mac}: ${message}`);
    return { ok: false, code: "UNREACHABLE", message };
  } finally {
    busy = false;
  }
}

/** Nearby Bluetooth devices, printers first. */
export async function findPrinters(seconds = 8): Promise<{ bluetooth: boolean; devices: FoundDevice[] }> {
  if (!(await bluetoothAvailable())) return { bluetooth: false, devices: [] };
  const devices = await scan(seconds);
  return { bluetooth: true, devices: [...devices.filter((d) => d.printer_like), ...devices.filter((d) => !d.printer_like)] };
}
