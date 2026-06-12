// Phase 3C — pure HID helpers for focus-independent scanner capture.
//
// This module is intentionally free of any native dependency so the
// report parser and the device-info redaction can be unit tested. The
// Electron main process feeds it raw report bytes from node-hid and
// receives assembled candidate strings, which then flow through the
// EXACT same validation policy as keyboard-wedge captures
// (WedgeScannerHarnessAdapter.validateInput → length cap, charset,
// AIM prefix, check digits, duplicate debounce, rate limit).
//
// Security posture:
//   • HID input is untrusted bytes. The assembler only maps keyboard
//     usage IDs to printable ASCII; anything it cannot map becomes a
//     control placeholder (\u0000) so downstream validation REJECTS
//     the scan (SCAN_CONTROL_CHARS) instead of silently dropping data.
//   • Assembled strings are handed to the callback and forgotten —
//     nothing here logs, stores, or re-emits raw content.
//   • Device discovery is projected through projectSafeHidDeviceInfo:
//     serial numbers are masked, raw OS paths never leave the main
//     process (only a short hash for selection-keying).

import { createHash } from 'node:crypto';

// ─── HID keyboard usage → ASCII (US layout, boot protocol) ─────────

const LETTER_FIRST = 0x04; // 'a'
const LETTER_LAST = 0x1d; // 'z'

const DIGIT_USAGES: Record<number, [string, string]> = {
  0x1e: ['1', '!'],
  0x1f: ['2', '@'],
  0x20: ['3', '#'],
  0x21: ['4', '$'],
  0x22: ['5', '%'],
  0x23: ['6', '^'],
  0x24: ['7', '&'],
  0x25: ['8', '*'],
  0x26: ['9', '('],
  0x27: ['0', ')'],
};

const PUNCT_USAGES: Record<number, [string, string]> = {
  0x2c: [' ', ' '],
  0x2d: ['-', '_'],
  0x2e: ['=', '+'],
  0x2f: ['[', '{'],
  0x30: [']', '}'],
  0x31: ['\\', '|'],
  0x33: [';', ':'],
  0x34: ["'", '"'],
  0x35: ['`', '~'],
  0x36: [',', '<'],
  0x37: ['.', '>'],
  0x38: ['/', '?'],
};

// Keypad digits/symbols some scanners emit in numeric mode.
const KEYPAD_USAGES: Record<number, string> = {
  0x54: '/',
  0x55: '*',
  0x56: '-',
  0x57: '+',
  0x59: '1',
  0x5a: '2',
  0x5b: '3',
  0x5c: '4',
  0x5d: '5',
  0x5e: '6',
  0x5f: '7',
  0x60: '8',
  0x61: '9',
  0x62: '0',
  0x63: '.',
};

const TERMINATOR_USAGES = new Set([
  0x28, // Enter (CR)
  0x58, // Keypad Enter
  0x2b, // Tab
]);

const SHIFT_MASK = 0x22; // left shift 0x02 | right shift 0x20

function usageToChar(usage: number, shifted: boolean): string | null {
  if (usage >= LETTER_FIRST && usage <= LETTER_LAST) {
    const base = String.fromCharCode('a'.charCodeAt(0) + (usage - LETTER_FIRST));
    return shifted ? base.toUpperCase() : base;
  }
  const digit = DIGIT_USAGES[usage];
  if (digit) return shifted ? digit[1] : digit[0];
  const punct = PUNCT_USAGES[usage];
  if (punct) return shifted ? punct[1] : punct[0];
  const keypad = KEYPAD_USAGES[usage];
  if (keypad) return keypad;
  return null;
}

export interface HidScanAssemblerOptions {
  /** Hard cap on the assembly buffer — guards against a device that
   *  never sends a terminator. Default 512 (validation caps at 256,
   *  so over-length scans still reach the SCAN_TOO_LONG rejection). */
  maxBufferLength?: number;
  /** Reset the partial buffer when reports stall longer than this —
   *  a half-assembled scan must not prefix the next one. Default 500. */
  interReportTimeoutMs?: number;
  now?: () => number;
  /** Fired with the assembled candidate string on terminator. The
   *  caller routes it into the standard scan validation pipeline. */
  onScan: (assembled: string) => void;
}

export interface HidScanAssembler {
  /** Feed one HID keyboard input report (boot protocol, 8 bytes:
   *  [modifiers, reserved, key1..key6]). Longer/shorter reports are
   *  handled defensively. */
  pushReport(report: Uint8Array | readonly number[]): void;
  reset(): void;
}

export function createHidKeyboardScanAssembler({
  maxBufferLength = 512,
  interReportTimeoutMs = 500,
  now = () => Date.now(),
  onScan,
}: HidScanAssemblerOptions): HidScanAssembler {
  let buffer = '';
  let lastReportAtMs = 0;
  let previousKeys = new Set<number>();

  const reset = (): void => {
    buffer = '';
    previousKeys = new Set();
  };

  return {
    pushReport(report) {
      const bytes = Array.from(report);
      const atMs = now();
      if (lastReportAtMs > 0 && atMs - lastReportAtMs > interReportTimeoutMs) {
        // Stale partial scan — drop it so it can't prefix the next one.
        reset();
      }
      lastReportAtMs = atMs;

      if (bytes.length < 3) return;
      const modifiers = bytes[0] ?? 0;
      const shifted = (modifiers & SHIFT_MASK) !== 0;
      const keys = bytes.slice(2, 8).filter((usage) => usage > 0x01);
      const currentKeys = new Set(keys);

      // Process ALL data-key edges in the report BEFORE terminating:
      // HID reports carry a SET of pressed keys in arbitrary slot
      // order, and the scanner protocol puts the terminator after the
      // data — so when both coalesce into one report, the data chars
      // belong to the current scan regardless of slot position.
      let sawTerminator = false;
      for (const usage of keys) {
        // Key-down edge only — a key held across reports is one press.
        if (previousKeys.has(usage)) continue;
        if (TERMINATOR_USAGES.has(usage)) {
          sawTerminator = true;
          continue;
        }
        if (buffer.length >= maxBufferLength) {
          // Keep accepting edges (so the terminator still fires) but
          // stop growing — validation rejects with SCAN_TOO_LONG.
          continue;
        }
        const char = usageToChar(usage, shifted);
        // Unmappable usage → control placeholder so the downstream
        // validator rejects the whole scan rather than truncating it.
        buffer += char ?? '\u0000';
      }
      previousKeys = currentKeys;
      if (sawTerminator) {
        const assembled = buffer;
        reset();
        previousKeys = currentKeys;
        if (assembled.length > 0) onScan(assembled);
      }
    },
    reset,
  };
}

// ─── Safe HID device discovery projection ──────────────────────────

/** Raw shape node-hid returns from devices()/devicesAsync(). Declared
 *  structurally so this module never imports the native package. */
export interface RawHidDeviceInfo {
  vendorId?: number;
  productId?: number;
  path?: string;
  serialNumber?: string;
  manufacturer?: string;
  product?: string;
  usagePage?: number;
  usage?: number;
}

export interface SafeHidDeviceInfo {
  /** Stable selection key — vendor:product:hash8(path). The raw OS
   *  path stays in the main process; the renderer only ever sees the
   *  hash fragment inside this key. */
  key: string;
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  usagePage: number | null;
  usage: number | null;
  /** Serial masked to first 2 chars + bullet padding; null if absent. */
  serialMasked: string | null;
  /** Keyboard-class collections (usagePage 0x01 / usage 0x06) are
   *  claimed by the OS on Windows and usually cannot be opened — the
   *  UI uses this to explain fallback instead of failing silently. */
  keyboardClass: boolean;
  /** HID POS scanner usage page (0x8C) or scanner-ish product name. */
  likelyScanner: boolean;
}

const SAFE_NAME_RE = /[^\x20-\x7e]/g;

function safeName(value: unknown, maxLength = 64): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(SAFE_NAME_RE, '').trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

export function maskHidSerial(serial: unknown): string | null {
  if (typeof serial !== 'string') return null;
  const cleaned = serial.replace(SAFE_NAME_RE, '').trim();
  if (cleaned.length === 0) return null;
  return `${cleaned.slice(0, 2)}••••`;
}

export function hidSelectionKey(raw: RawHidDeviceInfo): string {
  const pathHash = createHash('sha256')
    .update(String(raw.path ?? ''), 'utf8')
    .digest('hex')
    .slice(0, 8);
  const vendor = (raw.vendorId ?? 0).toString(16).padStart(4, '0');
  const product = (raw.productId ?? 0).toString(16).padStart(4, '0');
  return `${vendor}:${product}:${pathHash}`;
}

const SCANNER_NAME_HINT = /(scan|barcode|imager|symbol|honeywell|zebra|datalogic|newland)/i;

export function projectSafeHidDeviceInfo(raw: RawHidDeviceInfo): SafeHidDeviceInfo {
  const usagePage = typeof raw.usagePage === 'number' ? raw.usagePage : null;
  const usage = typeof raw.usage === 'number' ? raw.usage : null;
  const product = safeName(raw.product);
  return {
    key: hidSelectionKey(raw),
    vendorId: raw.vendorId ?? 0,
    productId: raw.productId ?? 0,
    manufacturer: safeName(raw.manufacturer),
    product,
    usagePage,
    usage,
    serialMasked: maskHidSerial(raw.serialNumber),
    keyboardClass: usagePage === 0x01 && usage === 0x06,
    likelyScanner:
      usagePage === 0x8c
      || (product !== null && SCANNER_NAME_HINT.test(product)),
  };
}

/** Persisted scanner preference — safe fields only. The raw OS path
 *  and full serial are deliberately NOT persisted; re-selection after
 *  replug matches on vendor/product ids. */
export interface ScannerHidPreference {
  vendorId: number;
  productId: number;
  product: string | null;
}

export function parseScannerHidPreference(value: unknown): ScannerHidPreference | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.vendorId !== 'number'
    || !Number.isInteger(record.vendorId)
    || typeof record.productId !== 'number'
    || !Number.isInteger(record.productId)
  ) {
    return null;
  }
  return {
    vendorId: record.vendorId,
    productId: record.productId,
    product: safeName(record.product),
  };
}
