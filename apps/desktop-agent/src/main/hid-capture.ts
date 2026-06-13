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
// Phase 3F — native-crash containment. RAW HID is EXPERIMENTAL and
// opt-in: node-hid's Windows backend can abort the whole process with a
// native N-API assertion (hid_winapi_descriptor_reconstruct_pp_data /
// napi_call_threadsafe_function) that no JS try/catch can intercept.
// So this module:
//   • imports/opens node-hid ONLY when the feature is enabled
//     (`hidEnabled()` — driven by JDA_HID_SCANNER_ENABLED, default off);
//     while disabled the native addon is never loaded → zero crash
//     surface, and the keyboard-wedge fallback stays the default;
//   • brackets every device open with a crash marker (written before
//     open, cleared after a clean close) so a prior abort disables RAW
//     HID on the next launch instead of crash-looping;
//   • invalidates in-flight 'data'/'error' callbacks before close and
//     after dispose (capture-generation guard) so a late native edge
//     can't touch torn-down state or enqueue a scan after teardown.
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
//   • The crash marker is a fixed string — never a path, serial, or
//     any device identifier.

import {
  createHidKeyboardScanAssembler,
  projectSafeHidDeviceInfo,
  type RawHidDeviceInfo,
  type SafeHidDeviceInfo,
  type ScannerHidPreference,
} from '@jade-dev-agent/scanner-adapter';

export type ScannerCaptureMode = 'WEDGE' | 'HID_RAW';

export type HidCaptureState =
  | 'IDLE'
  | 'CAPTURING'
  | 'RECONNECTING'
  | 'ERROR'
  | 'UNAVAILABLE';

export type ScannerCaptureSource = 'HID' | 'WEDGE';

/** Why RAW HID is unavailable, so the bench can show the right copy.
 *  `FLAG_DISABLED` — the operator never opted into the experimental
 *  feature (JDA_HID_SCANNER_ENABLED is not true).
 *  `PRIOR_CRASH` — a crash marker from a previous launch was found, so
 *  RAW HID is held down for this launch as a safety cool-off. */
export type HidDisabledReason = 'FLAG_DISABLED' | 'PRIOR_CRASH';

/** Safe, renderer-visible status. Never contains paths, serials,
 *  report bytes, or scan values. */
export interface ScannerCaptureStatus {
  mode: ScannerCaptureMode;
  /** RAW HID is opt-in + experimental: true only when the feature flag
   *  is on AND no prior-crash marker is holding it down this launch. */
  hidEnabled: boolean;
  hidSupported: boolean;
  hidState: HidCaptureState;
  /** UPPER_SNAKE reason code when not capturing; human copy stays in
   *  the renderer so the codes themselves remain log-safe. */
  hidReasonCode: string | null;
  selectedDevice: ScannerHidPreference | null;
  /** True when scans WILL be captured: HID_RAW while CAPTURING, or any
   *  WEDGE mode (the JPPOS keyboard-wedge fallback covers it). */
  ready: boolean;
  /** Which path is actively capturing. */
  captureSource: ScannerCaptureSource;
  /** Watchdog is retrying a dropped HID device. */
  reconnecting: boolean;
}

interface NodeHidDeviceLike {
  on(event: 'data', listener: (data: Buffer) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  /** EventEmitter teardown — used to detach listeners BEFORE close so a
   *  late native callback can't fire into a half-closed handle. Optional
   *  so the structural type stays minimal. */
  removeAllListeners?(event?: 'data' | 'error'): void;
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
  /** Watchdog timer injection for tests; default global setTimeout. */
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Live gate for the experimental RAW HID feature. Evaluated every
   *  time the manager would import or open node-hid, so the decision can
   *  be resolved after construction (the flag + crash marker are read
   *  during app bootstrap). Defaults to OFF — node-hid is never touched
   *  unless this returns true. */
  hidEnabled?: () => boolean;
  /** Why RAW HID is off (only consulted while `hidEnabled()` is false),
   *  so the bench shows "disabled" vs "disabled after a crash". */
  hidDisabledReason?: () => HidDisabledReason;
  /** Crash-marker side effects (the file I/O lives in main so this
   *  module stays pure + testable). `markOpenInProgress` is invoked
   *  synchronously right before a native open; `clearOpenMarker` after
   *  the handle is cleanly closed (or the open failed without aborting).
   *  A surviving marker on next launch signals a prior native crash. */
  markOpenInProgress?: () => void;
  clearOpenMarker?: () => void;
}

// Watchdog reconnect backoff (ms): 2s → 5s → 10s → 30s (then 30s).
const HID_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  // Bumped on every open and on every close/dispose. Each device's
  // 'data'/'error' listeners capture the generation they were attached
  // at and drop their event if it no longer matches — so a late native
  // callback (after close, after dispose, or from a superseded handle)
  // cannot enqueue a scan or schedule a reconnect into torn-down state.
  private captureGeneration = 0;
  private disposed = false;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: HidCaptureManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** Whether the experimental RAW HID feature is permitted right now.
   *  Secure default: OFF unless the host explicitly opts in. */
  private isHidEnabled(): boolean {
    return this.options.hidEnabled?.() ?? false;
  }

  /** Reason code for the disabled state, mapped to the bench copy. */
  private disabledReasonCode(): string {
    const reason = this.options.hidDisabledReason?.() ?? 'FLAG_DISABLED';
    return reason === 'PRIOR_CRASH' ? 'HID_DISABLED_AFTER_CRASH' : 'HID_DISABLED';
  }

  private async loadHid(): Promise<NodeHidModuleLike | null> {
    // Never import the native addon while the feature is disabled — this
    // is the core of the crash containment: an addon that is never loaded
    // cannot abort the process.
    if (!this.isHidEnabled()) return null;
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
    const enabled = this.isHidEnabled();
    const hidActive =
      enabled && this.mode === 'HID_RAW' && this.hidState === 'CAPTURING';
    return {
      mode: this.mode,
      hidEnabled: enabled,
      // Supported = opted-in AND the native module actually loaded.
      hidSupported: enabled && !this.moduleUnavailable,
      hidState: this.hidState,
      hidReasonCode: this.hidReasonCode,
      selectedDevice: this.selectedDevice,
      // WEDGE mode is always "ready" because JPPOS's keyboard-wedge
      // fallback captures it; HID_RAW is ready only while capturing.
      ready: this.mode === 'WEDGE' ? true : hidActive,
      captureSource: hidActive ? 'HID' : 'WEDGE',
      reconnecting: this.reconnecting,
    };
  }

  /** Enumerate HID devices as safe projections (masked serial, hashed
   *  path key). Also refreshes the key→path map used by select(). */
  async listDevices(): Promise<SafeHidDeviceInfo[]> {
    if (!this.isHidEnabled()) {
      // Disabled: do not enumerate (which would load node-hid). Wedge
      // stays the ready capture path.
      this.hidState = 'IDLE';
      this.hidReasonCode = this.disabledReasonCode();
      return [];
    }
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
    // Rank by category: openable scanners first, keyboard-mode
    // scanners next, everything else after. The renderer hides the
    // non-scanner tail unless "Show all HID devices" is on.
    const rank: Record<SafeHidDeviceInfo['category'], number> = {
      SCANNER: 0,
      KEYBOARD_SCANNER: 1,
      KEYBOARD: 2,
      POINTER: 3,
      SYSTEM_CONTROLLER: 4,
      OTHER: 5,
    };
    return safeDevices.sort((a, b) => rank[a.category] - rank[b.category]);
  }

  /** Open the device behind a selection key from the LAST discovery
   *  and switch to HID_RAW capture. A manual select cancels any active
   *  reconnect watchdog and resets its backoff. */
  async selectDevice(key: unknown): Promise<ScannerCaptureStatus> {
    if (!this.isHidEnabled() || this.disposed) {
      // Experimental RAW HID is off (or the manager is torn down) — never
      // open a device. Stay on the wedge fallback.
      this.hidReasonCode = this.disabledReasonCode();
      return this.getStatus();
    }
    if (typeof key !== 'string' || !/^[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{8}$/u.test(key)) {
      this.hidReasonCode = 'HID_SELECTION_INVALID';
      return this.getStatus();
    }
    this.stopReconnect();
    const status = await this.openDeviceByKey(key);
    if (status.hidState === 'CAPTURING') {
      this.options.persistPreference({
        mode: this.mode,
        device: this.selectedDevice,
      });
    }
    return status;
  }

  /** Low-level open used by both manual select and the watchdog. Does
   *  NOT persist or touch the reconnect backoff. */
  private async openDeviceByKey(key: string): Promise<ScannerCaptureStatus> {
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

    // Mark BEFORE the native open: if node-hid aborts the process inside
    // open()/descriptor reconstruction, this marker survives to the next
    // launch and holds RAW HID down. Written synchronously by the host.
    this.options.markOpenInProgress?.();

    let device: NodeHidDeviceLike;
    try {
      device = await hid.HIDAsync.open(path);
    } catch {
      // Open failed but the process survived — not a crash; release the
      // marker so it doesn't falsely trip the next launch.
      this.options.clearOpenMarker?.();
      this.hidState = 'ERROR';
      // Keyboard-class devices are usually OS-claimed on Windows —
      // give the UI the precise reason so it can suggest HID-POS mode
      // or wedge fallback.
      this.hidReasonCode =
        this.platform === 'win32' ? 'HID_OPEN_BLOCKED_OR_BUSY' : 'HID_OPEN_FAILED';
      return this.getStatus();
    }

    // This handle's callbacks are valid only while the generation holds.
    const generation = ++this.captureGeneration;
    const isCurrent = (): boolean =>
      !this.disposed && generation === this.captureGeneration;

    const assembler = createHidKeyboardScanAssembler({
      onScan: (assembled) => {
        if (!isCurrent()) return;
        this.options.submitScan(assembled);
      },
    });
    device.on('data', (data) => {
      // Drop late reports from a closed/superseded handle.
      if (!isCurrent()) return;
      assembler.pushReport(data);
    });
    device.on('error', () => {
      // Device unplugged or read failure — close and let the watchdog
      // retry with backoff; the wedge harness keeps working meanwhile.
      // Ignore the edge entirely if this handle is no longer current.
      if (!isCurrent()) return;
      void this.handleHidDisconnect();
    });

    this.openDevice = device;
    this.mode = 'HID_RAW';
    this.hidState = 'CAPTURING';
    this.hidReasonCode = null;
    this.reconnecting = false;
    this.selectedDevice = this.preferenceForKey(key);
    return this.getStatus();
  }

  // ─── Watchdog: auto-reconnect a dropped HID scanner ──────────────

  private async handleHidDisconnect(): Promise<void> {
    await this.closeOpenDevice();
    if (this.disposed || !this.isHidEnabled()) return; // torn down / disabled
    if (this.mode !== 'HID_RAW') return; // operator switched to wedge
    this.hidState = 'RECONNECTING';
    this.hidReasonCode = 'HID_DEVICE_DISCONNECTED';
    this.reconnecting = true;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.isHidEnabled()) return;
    if (this.reconnectTimer !== null || this.mode !== 'HID_RAW') return;
    const index = Math.min(
      this.reconnectAttempt,
      HID_RECONNECT_DELAYS_MS.length - 1,
    );
    const delay = HID_RECONNECT_DELAYS_MS[index]!;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  /** One reconnect tick: re-discover, and re-open the saved scanner if
   *  a single unambiguous match is present; otherwise back off. */
  async attemptReconnect(): Promise<ScannerCaptureStatus> {
    if (this.disposed || !this.isHidEnabled() || this.mode !== 'HID_RAW' || !this.selectedDevice) {
      this.reconnecting = false;
      return this.getStatus();
    }
    const preference = this.selectedDevice;
    const match = await this.findUniqueMatchKey(preference);
    if (match.kind !== 'unique') {
      this.hidReasonCode =
        match.kind === 'ambiguous' ? 'HID_MULTIPLE_MATCHES' : 'HID_DEVICE_DISCONNECTED';
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
      return this.getStatus();
    }
    const status = await this.openDeviceByKey(match.key);
    if (status.hidState === 'CAPTURING') {
      if (preference.product) {
        this.selectedDevice = { ...preference };
      }
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      this.options.persistPreference({
        mode: this.mode,
        device: this.selectedDevice,
      });
    } else {
      this.reconnectAttempt += 1;
      this.reconnecting = true;
      this.scheduleReconnect();
    }
    return this.getStatus();
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.reconnecting = false;
  }

  /** Find the single openable interface matching a saved preference. */
  private async findUniqueMatchKey(
    preference: ScannerHidPreference,
  ): Promise<{ kind: 'unique'; key: string } | { kind: 'none' } | { kind: 'ambiguous' }> {
    const devices = await this.listDevices();
    const matches = devices.filter(
      (device) =>
        device.vendorId === preference.vendorId
        && device.productId === preference.productId,
    );
    if (matches.length === 0) return { kind: 'none' };
    // A single physical scanner usually exposes several interfaces
    // (keyboard collection + HID-POS collection) — prefer the openable
    // scanner-class one.
    const preferred = matches.filter(
      (device) => device.likelyScanner && !device.keyboardClass,
    );
    const candidates = preferred.length > 0 ? preferred : matches;
    if (candidates.length > 1) return { kind: 'ambiguous' };
    return { kind: 'unique', key: candidates[0]!.key };
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
    // Remember the preference either way (so the bench still shows it and
    // a later re-enable can use it), but do NOT auto-open while RAW HID is
    // disabled — auto-restoring straight into the crashing open() path is
    // exactly what Phase 3F prevents. Wedge stays the ready default.
    this.selectedDevice = { ...preference };
    if (!this.isHidEnabled() || this.disposed) {
      this.mode = 'WEDGE';
      this.hidState = 'IDLE';
      this.hidReasonCode = this.disabledReasonCode();
      return this.getStatus();
    }
    const match = await this.findUniqueMatchKey(preference);
    if (match.kind === 'none') {
      // Saved scanner not plugged in — wedge fallback stays ready.
      this.mode = 'WEDGE';
      this.hidState = 'IDLE';
      this.hidReasonCode = 'NO_SCANNER';
      return this.getStatus();
    }
    if (match.kind === 'ambiguous') {
      // Two identical units — never guess; ask the operator to pick.
      this.mode = 'WEDGE';
      this.hidState = 'IDLE';
      this.hidReasonCode = 'SELECT_SCANNER';
      return this.getStatus();
    }
    const status = await this.selectDevice(match.key);
    if (status.hidState === 'CAPTURING' && preference.product) {
      this.selectedDevice = { ...preference };
    }
    return this.getStatus();
  }

  /** Fall back to the keyboard-wedge harness; closes any open device
   *  and cancels the reconnect watchdog. */
  async useWedgeMode(): Promise<ScannerCaptureStatus> {
    this.stopReconnect();
    await this.closeOpenDevice();
    this.mode = 'WEDGE';
    this.hidState = 'IDLE';
    this.hidReasonCode = null;
    this.options.persistPreference({ mode: 'WEDGE', device: this.selectedDevice });
    return this.getStatus();
  }

  /** Idempotent teardown. Safe to call from multiple quit paths; the
   *  second call is a no-op. Invalidates any in-flight callbacks first. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopReconnect();
    await this.closeOpenDevice();
  }

  private async closeOpenDevice(): Promise<void> {
    const device = this.openDevice;
    this.openDevice = null;
    // Invalidate this handle's callbacks BEFORE detaching/closing so a
    // 'data'/'error' edge that fires during teardown is dropped instead
    // of touching freed state. (Single-threaded JS makes this atomic
    // w.r.t. the synchronous listener bodies.)
    this.captureGeneration += 1;
    if (!device) {
      // No live handle — make sure the crash marker isn't left set.
      this.options.clearOpenMarker?.();
      return;
    }
    // Detach listeners first to shrink the window for a native callback
    // landing after close (the node-hid N-API use-after-free path).
    try {
      device.removeAllListeners?.('data');
      device.removeAllListeners?.('error');
    } catch {
      // removeAllListeners is best-effort; close still runs below.
    }
    try {
      await device.close();
    } catch {
      // Closing an unplugged handle can throw — nothing to clean up.
    }
    // Clean close completed (or threw without aborting the process) — the
    // handle is released, so the crash marker can be cleared. A real
    // native abort skips this line, leaving the marker for next launch.
    this.options.clearOpenMarker?.();
  }
}
