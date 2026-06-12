// Phase 3C — focus-independent HID scanner capture (main process ONLY).
//
// Why node-hid: it is the only maintained N-API (prebuilt, ABI-stable)
// HID library that runs in the Electron MAIN process. WebHID would put
// untrusted hardware input and device handles in the renderer — the
// opposite of this app's sandbox boundary — and serial capture is a
// different transport entirely (follow-up if ever needed).
//
// Known platform limit, surfaced honestly in the UI: on Windows the OS
// claims keyboard-class HID collections (usagePage 0x01 / usage 0x06),
// so a scanner configured as a plain HID keyboard usually CANNOT be
// opened — it keeps working through the wedge harness instead. Most
// POS scanners can be switched to "HID POS / serial-over-HID" modes
// (usagePage 0x8C) which open fine.
//
// Privacy/security:
//   • Raw OS device paths and full serial numbers never leave this
//     module — discovery results go through projectSafeHidDeviceInfo.
//   • Raw HID report bytes are fed straight into the pure assembler
//     and dropped; they are never logged, stored, or sent anywhere.
//   • Assembled candidate strings go ONLY into the shared scanner
//     validation pipeline (same policy as wedge), which owns debounce,
//     rate limiting, and the Phase 3B delivery queue.
//   • Scanned content is data, never code: nothing here (or downstream)
//     executes, opens, or renders scanned values.

import {
  createHidKeyboardScanAssembler,
  projectSafeHidDeviceInfo,
  type RawHidDeviceInfo,
  type SafeHidDeviceInfo,
  type ScannerHidPreference,
} from '@jade-dev-agent/scanner-adapter';

export type ScannerCaptureMode = 'WEDGE' | 'HID_RAW';

export type HidCaptureState = 'IDLE' | 'CAPTURING' | 'ERROR' | 'UNAVAILABLE';

/** Safe, renderer-visible status. Never contains paths, serials,
 *  report bytes, or scan values. */
export interface ScannerCaptureStatus {
  mode: ScannerCaptureMode;
  hidSupported: boolean;
  hidState: HidCaptureState;
  /** UPPER_SNAKE reason code when not capturing; human copy stays in
   *  the renderer so the codes themselves remain log-safe. */
  hidReasonCode: string | null;
  selectedDevice: ScannerHidPreference | null;
}

interface NodeHidDeviceLike {
  on(event: 'data', listener: (data: Buffer) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  close(): Promise<void> | void;
}

interface NodeHidModuleLike {
  devicesAsync(): Promise<RawHidDeviceInfo[]>;
  HIDAsync: {
    open(path: string): Promise<NodeHidDeviceLike>;
  };
}

export interface HidCaptureManagerOptions {
  /** Shared validation pipeline: assembled candidate strings are
   *  validated + queued by the SAME adapter the wedge harness uses. */
  submitScan: (assembled: string) => void;
  /** Persist the safe device preference + mode (vendor/product/name
   *  only — never path or serial). */
  persistPreference: (preference: {
    mode: ScannerCaptureMode;
    device: ScannerHidPreference | null;
  }) => void;
  /** Module loader hook for tests; defaults to importing node-hid. */
  loadModule?: () => Promise<NodeHidModuleLike>;
  platform?: NodeJS.Platform;
}

const defaultLoadModule = async (): Promise<NodeHidModuleLike> => {
  const mod = (await import('node-hid')) as unknown as
    | NodeHidModuleLike
    | { default: NodeHidModuleLike };
  return 'devicesAsync' in mod ? mod : (mod as { default: NodeHidModuleLike }).default;
};

export class HidCaptureManager {
  private mode: ScannerCaptureMode = 'WEDGE';
  private hidState: HidCaptureState = 'IDLE';
  private hidReasonCode: string | null = null;
  private selectedDevice: ScannerHidPreference | null = null;
  private openDevice: NodeHidDeviceLike | null = null;
  /** Selection key → raw OS path, refreshed per discovery. The raw
   *  path is only ever used here to open the device. */
  private pathsByKey = new Map<string, string>();
  private modulePromise: Promise<NodeHidModuleLike> | null = null;
  private moduleUnavailable = false;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: HidCaptureManagerOptions) {
    this.platform = options.platform ?? process.platform;
  }

  private async loadHid(): Promise<NodeHidModuleLike | null> {
    if (this.moduleUnavailable) return null;
    try {
      this.modulePromise ??= (this.options.loadModule ?? defaultLoadModule)();
      return await this.modulePromise;
    } catch {
      this.modulePromise = null;
      this.moduleUnavailable = true;
      return null;
    }
  }

  getStatus(): ScannerCaptureStatus {
    return {
      mode: this.mode,
      hidSupported: !this.moduleUnavailable,
      hidState: this.hidState,
      hidReasonCode: this.hidReasonCode,
      selectedDevice: this.selectedDevice,
    };
  }

  /** Enumerate HID devices as safe projections (masked serial, hashed
   *  path key). Also refreshes the key→path map used by select(). */
  async listDevices(): Promise<SafeHidDeviceInfo[]> {
    const hid = await this.loadHid();
    if (!hid) {
      this.hidState = 'UNAVAILABLE';
      this.hidReasonCode = 'HID_MODULE_UNAVAILABLE';
      return [];
    }
    let rawDevices: RawHidDeviceInfo[];
    try {
      rawDevices = await hid.devicesAsync();
    } catch {
      this.hidState = 'ERROR';
      this.hidReasonCode = 'HID_ENUMERATION_FAILED';
      return [];
    }
    this.pathsByKey = new Map();
    const safeDevices: SafeHidDeviceInfo[] = [];
    for (const raw of rawDevices) {
      const safe = projectSafeHidDeviceInfo(raw);
      if (typeof raw.path === 'string' && raw.path.length > 0) {
        this.pathsByKey.set(safe.key, raw.path);
      }
      safeDevices.push(safe);
    }
    // Scanner-looking devices first, keyboard-class collections last.
    return safeDevices.sort((a, b) => {
      const score = (d: SafeHidDeviceInfo) =>
        (d.likelyScanner ? 0 : 1) + (d.keyboardClass ? 2 : 0);
      return score(a) - score(b);
    });
  }

  /** Open the device behind a selection key from the LAST discovery
   *  and switch to HID_RAW capture. Falls back safely on failure. */
  async selectDevice(key: unknown): Promise<ScannerCaptureStatus> {
    if (typeof key !== 'string' || !/^[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{8}$/u.test(key)) {
      this.hidReasonCode = 'HID_SELECTION_INVALID';
      return this.getStatus();
    }
    const path = this.pathsByKey.get(key);
    if (!path) {
      this.hidReasonCode = 'HID_DEVICE_NOT_FOUND';
      return this.getStatus();
    }
    const hid = await this.loadHid();
    if (!hid) {
      this.hidState = 'UNAVAILABLE';
      this.hidReasonCode = 'HID_MODULE_UNAVAILABLE';
      return this.getStatus();
    }

    await this.closeOpenDevice();

    let device: NodeHidDeviceLike;
    try {
      device = await hid.HIDAsync.open(path);
    } catch {
      this.hidState = 'ERROR';
      // Keyboard-class devices are usually OS-claimed on Windows —
      // give the UI the precise reason so it can suggest HID-POS mode
      // or wedge fallback.
      this.hidReasonCode =
        this.platform === 'win32' ? 'HID_OPEN_BLOCKED_OR_BUSY' : 'HID_OPEN_FAILED';
      return this.getStatus();
    }

    const assembler = createHidKeyboardScanAssembler({
      onScan: (assembled) => {
        this.options.submitScan(assembled);
      },
    });
    device.on('data', (data) => {
      assembler.pushReport(data);
    });
    device.on('error', () => {
      // Device unplugged or read failure — drop to a safe error state;
      // the wedge harness keeps working and the UI shows the reason.
      void this.closeOpenDevice();
      this.hidState = 'ERROR';
      this.hidReasonCode = 'HID_DEVICE_DISCONNECTED';
    });

    this.openDevice = device;
    this.mode = 'HID_RAW';
    this.hidState = 'CAPTURING';
    this.hidReasonCode = null;
    this.selectedDevice = this.preferenceForKey(key);
    this.options.persistPreference({
      mode: this.mode,
      device: this.selectedDevice,
    });
    return this.getStatus();
  }

  /** Build the persistable (safe-fields-only) preference for a key. */
  private preferenceForKey(key: string): ScannerHidPreference | null {
    const [vendorHex, productHex] = key.split(':');
    const vendorId = Number.parseInt(vendorHex ?? '', 16);
    const productId = Number.parseInt(productHex ?? '', 16);
    if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null;
    return { vendorId, productId, product: null };
  }

  /** Re-attach a persisted preference after restart. Matching is by
   *  vendor/product id (paths and serials are never persisted), so:
   *    • a single match (or a single scanner-class interface among a
   *      multi-interface device) auto-restores;
   *    • genuinely ambiguous matches — e.g. two identical scanner
   *      units — are NEVER auto-picked: the bench asks the operator
   *      to choose, instead of silently capturing the wrong unit. */
  async restorePreference(preference: ScannerHidPreference): Promise<ScannerCaptureStatus> {
    const devices = await this.listDevices();
    const matches = devices.filter(
      (device) =>
        device.vendorId === preference.vendorId
        && device.productId === preference.productId,
    );
    if (matches.length === 0) {
      this.hidState = 'IDLE';
      this.hidReasonCode = 'HID_PREFERRED_DEVICE_ABSENT';
      return this.getStatus();
    }
    // A single physical scanner usually enumerates several interfaces
    // (keyboard collection + HID-POS collection) with the same ids —
    // prefer the openable scanner-class interface.
    const preferred = matches.filter(
      (device) => device.likelyScanner && !device.keyboardClass,
    );
    const candidates = preferred.length > 0 ? preferred : matches;
    if (candidates.length > 1) {
      this.hidState = 'IDLE';
      this.hidReasonCode = 'HID_MULTIPLE_MATCHES';
      return this.getStatus();
    }
    const status = await this.selectDevice(candidates[0]!.key);
    if (status.selectedDevice && preference.product) {
      this.selectedDevice = { ...status.selectedDevice, product: preference.product };
    }
    return this.getStatus();
  }

  /** Fall back to the keyboard-wedge harness; closes any open device. */
  async useWedgeMode(): Promise<ScannerCaptureStatus> {
    await this.closeOpenDevice();
    this.mode = 'WEDGE';
    this.hidState = 'IDLE';
    this.hidReasonCode = null;
    this.options.persistPreference({ mode: 'WEDGE', device: this.selectedDevice });
    return this.getStatus();
  }

  async dispose(): Promise<void> {
    await this.closeOpenDevice();
  }

  private async closeOpenDevice(): Promise<void> {
    const device = this.openDevice;
    this.openDevice = null;
    if (!device) return;
    try {
      await device.close();
    } catch {
      // Closing an unplugged handle can throw — nothing to clean up.
    }
  }
}
