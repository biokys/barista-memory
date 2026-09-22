/**
 * The MXW01 "cat printer" protocol, ported from the Python driver that has
 * printed every receipt so far. Frames: preamble 22 21 | id | 00 | len LE |
 * payload | crc8(payload) | FF. Notifications use the same layout without the
 * CRC. Image data is 1 bpp, 48 bytes per 384-dot line, LSB first, 1 = black.
 */

export const CONTROL_UUID = "0000ae01-0000-1000-8000-00805f9b34fb"; // commands, write without response
export const NOTIFY_UUID = "0000ae02-0000-1000-8000-00805f9b34fb";  // status and acknowledgements
export const DATA_UUID = "0000ae03-0000-1000-8000-00805f9b34fb";    // bulk image data

export const PRINTER_WIDTH_PX = 384;
export const PRINTER_WIDTH_BYTES = PRINTER_WIDTH_PX / 8;
/** The printer expects at least this many lines; short jobs are padded with white. */
const MIN_LINES = 90;
export const DEFAULT_INTENSITY = 0x5d;

const CMD = { GET_STATUS: 0xa1, SET_INTENSITY: 0xa2, PRINT: 0xa9, PRINT_COMPLETE: 0xaa, FLUSH: 0xad } as const;
const PRINT_MODE_MONO_1BPP = 0x01;
const PRINT_REQUEST_FIXED = 0x30;
const NOTIFY_TIMEOUT_MS = 7000;
const COMPLETE_BASE_TIMEOUT_MS = 15000;
const COMPLETE_LINES_PER_S = 15;
/** One line per write, with a small gap, so the printer's buffer never overruns. */
const PACING_MS = 15;

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let v = 0; v < 256; v++) {
    let c = v;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t.push(c);
  }
  return t;
})();

export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) crc = CRC_TABLE[crc ^ b];
  return crc;
}

function frame(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 8);
  out.set([0x22, 0x21, id & 0xff, 0x00, payload.length & 0xff, (payload.length >> 8) & 0xff], 0);
  out.set(payload, 6);
  out[payload.length + 6] = crc8(payload);
  out[payload.length + 7] = 0xff;
  return out;
}

export const cmd = {
  getStatus: () => frame(CMD.GET_STATUS, new Uint8Array([0])),
  setIntensity: (i: number) => frame(CMD.SET_INTENSITY, new Uint8Array([Math.max(0, Math.min(255, i))])),
  printRequest: (lines: number) => frame(CMD.PRINT, new Uint8Array([lines & 0xff, (lines >> 8) & 0xff, PRINT_REQUEST_FIXED, PRINT_MODE_MONO_1BPP])),
  flush: () => frame(CMD.FLUSH, new Uint8Array([0])),
};

export interface PrinterStatus {
  raw: string;
  battery: number | null;
  temperature: number | null;
  ready: boolean | null;
  error_code: number | null;
}

export function decodeStatus(payload: Uint8Array): PrinterStatus {
  const raw = Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join(" ");
  if (payload.length < 8) return { raw, battery: null, temperature: null, ready: null, error_code: null };
  return { raw, battery: payload[3], temperature: payload[4], ready: payload[6] === 0, error_code: payload[7] };
}

/** What the driver needs from a transport: two writable characteristics and one notifying. */
export interface PrinterLink {
  writeControl(data: Uint8Array): Promise<void>;
  writeData(data: Uint8Array): Promise<void>;
  onNotify(handler: (data: Uint8Array) => void): void;
}

export class Mxw01 {
  private waiters = new Map<number, { resolve: (p: Uint8Array) => void }>();

  constructor(private link: PrinterLink) {
    link.onNotify((data) => {
      if (data.length < 6 || data[0] !== 0x22 || data[1] !== 0x21) return;
      const id = data[2];
      const length = data[4] | (data[5] << 8);
      const w = this.waiters.get(id);
      if (w) { this.waiters.delete(id); w.resolve(data.subarray(6, 6 + length)); }
    });
  }

  private expect(id: number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`printer did not answer command 0x${id.toString(16)} within ${timeoutMs} ms`)); }, timeoutMs);
      this.waiters.set(id, { resolve: (p) => { clearTimeout(timer); resolve(p); } });
    });
  }

  async status(): Promise<PrinterStatus> {
    const reply = this.expect(CMD.GET_STATUS, NOTIFY_TIMEOUT_MS);
    await this.link.writeControl(cmd.getStatus());
    return decodeStatus(await reply);
  }

  /** Print packed 1 bpp rows (48 bytes each). */
  async print(rows: Uint8Array, lineCount: number, intensity = DEFAULT_INTENSITY): Promise<{ lines: number; completed: boolean }> {
    let data = rows;
    if (lineCount < MIN_LINES) {
      const padded = new Uint8Array(PRINTER_WIDTH_BYTES * MIN_LINES);
      padded.set(rows);
      data = padded;
      lineCount = MIN_LINES;
    }
    await this.link.writeControl(cmd.setIntensity(intensity));
    const status = await this.status();
    if (status.ready === false) throw new Error(`printer not ready (error code ${status.error_code}; paper? lid?)`);

    const ack = this.expect(CMD.PRINT, NOTIFY_TIMEOUT_MS);
    await this.link.writeControl(cmd.printRequest(lineCount));
    const reply = await ack;
    if (reply.length === 0 || reply[0] !== 0) throw new Error(`printer rejected the job (ack ${Array.from(reply).join(" ")})`);

    for (let off = 0; off < data.length; off += PRINTER_WIDTH_BYTES) {
      await this.link.writeData(data.subarray(off, off + PRINTER_WIDTH_BYTES));
      await new Promise((r) => setTimeout(r, PACING_MS));
    }

    const complete = this.expect(CMD.PRINT_COMPLETE, COMPLETE_BASE_TIMEOUT_MS + (lineCount / COMPLETE_LINES_PER_S) * 1000);
    await this.link.writeControl(cmd.flush());
    try {
      await complete;
      return { lines: lineCount, completed: true };
    } catch {
      // The job usually printed anyway; the caller reports it as unconfirmed.
      return { lines: lineCount, completed: false };
    }
  }
}

/** Pack a 384-wide 1-bit raster (true = black) into printer rows. */
export function packRows(black: Uint8Array, width: number, height: number): Uint8Array {
  if (width !== PRINTER_WIDTH_PX) throw new Error(`raster must be ${PRINTER_WIDTH_PX} px wide, got ${width}`);
  const out = new Uint8Array(PRINTER_WIDTH_BYTES * height);
  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < PRINTER_WIDTH_BYTES; bx++) {
      let v = 0;
      for (let bit = 0; bit < 8; bit++) if (black[y * width + bx * 8 + bit]) v |= 1 << bit;
      out[y * PRINTER_WIDTH_BYTES + bx] = v;
    }
  }
  return out;
}
