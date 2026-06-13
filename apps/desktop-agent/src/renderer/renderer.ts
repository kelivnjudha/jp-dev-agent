// Jade Palace Device Console — renderer presentation layer.
//
// Presentation only: all device/session/scanner behavior lives in the
// main process behind the minimal preload bridge. This file renders
// safe snapshot fields with textContent (never HTML), shows scan
// results as safe metadata (raw values hidden by default; the dev-only
// value appears only when the main process includes it behind
// JDA_SCANNER_DEV_SHOW_VALUE and is visually labeled DEV ONLY), and
// keeps a client-side safe event timeline — no secrets, no raw
// barcode values, no console logging of scan content.

import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';
import type { ScanValidationErrorCode, ScanValidationResult } from '@jade-dev-agent/protocol';
import type {
  AgentSnapshot,
  HardwareStatus,
  SafeScannerHidDevice,
  ScannerCaptureStatus,
} from '../preload/preload.cjs';

interface ViewModel {
  registration: DeviceRegistrationSnapshot;
  health: AgentHealth;
  controls: AgentSnapshot['controls'];
  hardware: HardwareStatus | null;
}

const setupInput = document.querySelector<HTMLInputElement>('#setup-code');
const deviceLabelInput = document.querySelector<HTMLInputElement>('#device-label');
const submitButton = document.querySelector<HTMLButtonElement>('#submit-code');
const checkActivationButton = document.querySelector<HTMLButtonElement>('#check-activation');
const activateButton = document.querySelector<HTMLButtonElement>('#mock-activate');
const disableButton = document.querySelector<HTMLButtonElement>('#disable-device');
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh');
const scannerInput = document.querySelector<HTMLInputElement>('#scanner-capture');
const scannerValidateButton = document.querySelector<HTMLButtonElement>('#scanner-validate');
const devControls = document.querySelector<HTMLElement>('#dev-controls');
const statusBadge = document.querySelector<HTMLElement>('#status-badge');
const modeBadge = document.querySelector<HTMLElement>('#mode-badge');
const message = document.querySelector<HTMLElement>('#message');
const capabilityList = document.querySelector<HTMLElement>('#capabilities');
const proxyStatus = document.querySelector<HTMLElement>('#proxy-status');
const hardwareStatus = document.querySelector<HTMLElement>('#hardware-status');
const scannerOutcome = document.querySelector<HTMLElement>('#scanner-outcome');
const scannerMeta = document.querySelector<HTMLElement>('#scanner-meta');
const scannerCounts = document.querySelector<HTMLElement>('#scanner-counts');
const scannerErrorHelp = document.querySelector<HTMLElement>('#scanner-error-help');
const scannerDevValue = document.querySelector<HTMLElement>('#scanner-dev-value');
const scannerDevValueText = document.querySelector<HTMLElement>('#scanner-dev-value-text');
const eventTimeline = document.querySelector<HTMLUListElement>('#event-timeline');
const timelineEmpty = document.querySelector<HTMLElement>('#timeline-empty');
const screenTitle = document.querySelector<HTMLElement>('#screen-title');
const branchDetail = document.querySelector<HTMLElement>('#branch-detail');
const hidDetail = document.querySelector<HTMLElement>('#hid-detail');
const serverStatusDetail = document.querySelector<HTMLElement>('#server-status-detail');
const claimedAtDetail = document.querySelector<HTMLElement>('#claimed-at-detail');
const sessionStatusDetail = document.querySelector<HTMLElement>('#session-status-detail');
const sessionExpiresDetail = document.querySelector<HTMLElement>('#session-expires-detail');
const activationCheckedDetail = document.querySelector<HTMLElement>('#activation-checked-detail');
const activationNextDetail = document.querySelector<HTMLElement>('#activation-next-detail');
const activationStatusDetail = document.querySelector<HTMLElement>('#activation-status-detail');
const activationFailuresDetail = document.querySelector<HTMLElement>('#activation-failures-detail');
const lastHeartbeatDetail = document.querySelector<HTMLElement>('#last-heartbeat-detail');
const nextHeartbeatDetail = document.querySelector<HTMLElement>('#next-heartbeat-detail');
const nextRefreshDetail = document.querySelector<HTMLElement>('#next-refresh-detail');
const heartbeatFailuresDetail = document.querySelector<HTMLElement>('#heartbeat-failures-detail');

// Helpful, text-based copy for every scanner rejection code. Raw scan
// content never appears here — only what the operator should do next.
const SCAN_ERROR_COPY: Record<ScanValidationErrorCode, string> = {
  SCAN_EMPTY: 'Empty capture. Focus the capture field, then scan again.',
  SCAN_TOO_LONG:
    'Too long. The capture exceeds the maximum accepted barcode length — check the scanner is not concatenating scans.',
  SCAN_CONTROL_CHARS:
    'Control characters detected. The scanner is likely configured with an extra prefix/suffix — review its terminator settings.',
  SCAN_INVALID_CHARSET:
    'Invalid characters. The capture contains characters outside the accepted set; the code may not be a supported product barcode.',
  SCAN_UNSUPPORTED_FORMAT:
    'Unsupported format. This symbology is not in the accepted list for this device mode.',
  SCAN_EAN_CHECK_DIGIT_INVALID:
    'Bad check digit. The EAN/UPC checksum failed — rescan; if it persists, the printed code may be damaged.',
  SCAN_DUPLICATE:
    'Duplicate scan. The same code was just accepted — wait a moment and rescan if this is intentional.',
  SCAN_RATE_LIMITED:
    'Rate limited. Scans are arriving too fast — pause briefly, then continue.',
};

type BadgeTone = 'trusted' | 'ok' | 'warn' | 'danger' | 'neutral';

function statusTone(status: DeviceRegistrationSnapshot['status']): BadgeTone {
  switch (status) {
    case 'ACTIVE':
      return 'trusted';
    case 'PENDING_ACTIVATION':
    case 'SETUP_CODE_SUBMITTING':
    case 'ACTIVE_SESSION_CONNECTING':
    case 'SESSION_EXPIRED_RETRYING':
      return 'warn';
    case 'DISABLED':
    case 'DENIED':
    case 'REVOKED':
    case 'ERROR':
    case 'RESET_REQUIRED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function setText(element: Element | null, value: string): void {
  if (element) element.textContent = value;
}

function setBadge(element: HTMLElement | null, label: string, tone: BadgeTone): void {
  if (!element) return;
  element.textContent = label;
  if (tone === 'neutral') {
    delete element.dataset.tone;
  } else {
    element.dataset.tone = tone;
  }
}

// ---------- Safe event timeline (client-side, capped, metadata only) ----------

const TIMELINE_MAX_ENTRIES = 50;

function pushTimelineEvent(
  kind: string,
  tone: 'ok' | 'danger' | 'info',
  text: string,
): void {
  if (!eventTimeline) return;
  if (timelineEmpty) timelineEmpty.hidden = true;

  const item = document.createElement('li');
  item.dataset.tone = tone;

  const time = document.createElement('span');
  time.className = 't-time';
  time.textContent = new Date().toLocaleTimeString();

  const kindEl = document.createElement('span');
  kindEl.className = 't-kind';
  kindEl.textContent = kind;

  const textEl = document.createElement('span');
  textEl.className = 't-text';
  textEl.textContent = text;

  item.append(time, kindEl, textEl);
  eventTimeline.prepend(item);

  while (eventTimeline.children.length > TIMELINE_MAX_ENTRIES) {
    eventTimeline.lastElementChild?.remove();
  }
}

let lastTimelineStatusKey = '';

function recordStatusTransition(registration: DeviceRegistrationSnapshot): void {
  const key = `${registration.status}|${registration.connectionStatus ?? ''}`;
  if (key === lastTimelineStatusKey) return;
  const isFirst = lastTimelineStatusKey === '';
  lastTimelineStatusKey = key;
  if (isFirst) return; // Don't log the initial render as a transition.
  const tone = statusTone(registration.status) === 'danger' ? 'danger' : 'info';
  const connection = registration.connectionStatus
    ? ` · ${registration.connectionStatus.replaceAll('_', ' ')}`
    : '';
  pushTimelineEvent('STATUS', tone, `${registration.status.replaceAll('_', ' ')}${connection}`);
}

// ---------- Rendering ----------

function isSetupLockedStatus(status: DeviceRegistrationSnapshot['status']): boolean {
  return [
    'SETUP_CODE_SUBMITTING',
    'PENDING_ACTIVATION',
    'ACTIVE_SESSION_CONNECTING',
    'ACTIVE',
    'SESSION_EXPIRED_RETRYING',
    'RESET_REQUIRED',
  ].includes(status);
}

function render(next: ViewModel): void {
  const { registration, health, hardware } = next;
  document.body.dataset.status = registration.status;
  setBadge(
    statusBadge,
    registration.status.replaceAll('_', ' '),
    statusTone(registration.status),
  );
  setBadge(modeBadge, registration.mode.replaceAll('_', ' '), 'neutral');
  setText(message, registration.message);
  setText(screenTitle, titleForRegistration(registration));
  setText(branchDetail, formatBranch(registration.branch));
  setText(hidDetail, registration.safeHidPrefix ?? 'Unavailable');
  setText(
    serverStatusDetail,
    (registration.serverStatus ?? registration.status).replaceAll('_', ' '),
  );
  setText(claimedAtDetail, formatDateTime(registration.claimedAt));
  setText(
    sessionStatusDetail,
    formatConnectionStatus(registration.connectionStatus, registration.sessionStatus),
  );
  setText(sessionExpiresDetail, formatDateTime(registration.sessionExpiresAt ?? undefined));
  setText(activationCheckedDetail, formatDateTime(registration.lastActivationCheckAt));
  setText(activationNextDetail, formatDateTime(registration.nextActivationCheckAt));
  setText(
    activationStatusDetail,
    (registration.activationCheckStatus ?? 'IDLE').replaceAll('_', ' '),
  );
  setText(
    activationFailuresDetail,
    registration.activationCheckFailures && registration.activationCheckFailures > 0
      ? String(registration.activationCheckFailures)
      : '0',
  );
  setText(lastHeartbeatDetail, formatDateTime(registration.lastHeartbeatAt));
  setText(nextHeartbeatDetail, formatDateTime(registration.nextHeartbeatAt));
  setText(nextRefreshDetail, formatDateTime(registration.nextSessionRefreshAt));
  setText(heartbeatFailuresDetail, String(registration.heartbeatFailures ?? 0));
  setText(
    capabilityList,
    registration.capabilities.length
      ? registration.capabilities.join(' · ')
      : 'None yet',
  );
  setText(
    proxyStatus,
    health.proxy.enabled
      ? `Online at ${health.proxy.host}:${health.proxy.port}`
      : 'Offline',
  );
  setText(
    hardwareStatus,
    hardware
      ? `Printer: ${hardware.printer.message} · NFC: ${hardware.nfc.message} · Scanner: ${formatScannerStatus(hardware)}`
      : 'Status unavailable',
  );
  renderScannerCounters(hardware);
  recordStatusTransition(registration);

  if (devControls) {
    devControls.hidden = !next.controls.mockFlowEnabled;
  }
  if (submitButton) {
    submitButton.disabled = isSetupLockedStatus(registration.status);
    submitButton.textContent = registration.status === 'SETUP_CODE_SUBMITTING'
      ? 'Claiming...'
      : 'Claim Device';
  }
  if (setupInput) {
    setupInput.disabled = isSetupLockedStatus(registration.status);
  }
  if (deviceLabelInput) {
    deviceLabelInput.disabled = isSetupLockedStatus(registration.status);
    if (registration.deviceLabel) deviceLabelInput.value = registration.deviceLabel;
  }
  if (checkActivationButton) {
    const checking =
      registration.status === 'ACTIVE_SESSION_CONNECTING'
      || registration.activationCheckStatus === 'CHECKING';
    checkActivationButton.hidden = !['PENDING_ACTIVATION', 'ACTIVE_SESSION_CONNECTING'].includes(
      registration.status,
    );
    checkActivationButton.disabled = checking;
    checkActivationButton.textContent = checking ? 'Checking...' : 'Check now';
  }
  if (activateButton) {
    activateButton.disabled = !next.controls.mockFlowEnabled || registration.status !== 'PENDING_ACTIVATION';
  }
  if (disableButton) {
    disableButton.disabled = !next.controls.mockFlowEnabled || registration.status === 'DISABLED';
  }
}

function titleForRegistration(registration: DeviceRegistrationSnapshot): string {
  if (registration.connectionStatus === 'REFRESHING') {
    return 'Refreshing Device Session';
  }
  if (registration.connectionStatus === 'RECONNECTING') {
    return 'Reconnecting Device Session';
  }
  return titleForStatus(registration.status);
}

function titleForStatus(status: DeviceRegistrationSnapshot['status']): string {
  switch (status) {
    case 'UNREGISTERED':
      return 'Setup Code Required';
    case 'SETUP_CODE_SUBMITTING':
      return 'Claiming Device';
    case 'PENDING_ACTIVATION':
      return 'Waiting for Admin Activation';
    case 'ACTIVE_SESSION_CONNECTING':
      return 'Connecting Device Session';
    case 'ACTIVE':
      return 'Device Active';
    case 'SESSION_EXPIRED_RETRYING':
      return 'Reconnecting Device Session';
    case 'DISABLED':
      return 'Device Disabled';
    case 'DENIED':
      return 'Device Denied';
    case 'REVOKED':
      return 'Device Revoked';
    case 'ERROR':
      return 'Device Claim Failed';
    case 'RESET_REQUIRED':
      return 'Device Reset Required';
    default:
      return 'Jade Palace Device Agent';
  }
}

function formatBranch(branch: DeviceRegistrationSnapshot['branch']): string {
  if (!branch) return 'Not claimed';
  const code = branch.code ? ` (${branch.code})` : '';
  return `${branch.name || 'Assigned branch'}${code}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recorded';
  return date.toLocaleString();
}

function formatConnectionStatus(
  connectionStatus: DeviceRegistrationSnapshot['connectionStatus'],
  sessionStatus: string | undefined,
): string {
  if (connectionStatus === 'REFRESHING') {
    return 'Refreshing secure device session...';
  }
  if (connectionStatus === 'RECONNECTING') {
    return 'Reconnecting to Jade Palace API...';
  }
  if (connectionStatus && connectionStatus !== 'CONNECTED') {
    return connectionStatus.replaceAll('_', ' ');
  }
  if (sessionStatus) return sessionStatus.replaceAll('_', ' ');
  if (!connectionStatus) return 'Not connected';
  return connectionStatus.replaceAll('_', ' ');
}

function formatScannerStatus(hardware: HardwareStatus): string {
  const status = hardware.scanner;
  const lastOutcome = status.lastOutcome ? status.lastOutcome.replaceAll('_', ' ') : 'waiting';
  return `${status.enabled ? 'enabled' : 'disabled'} ${status.source} harness, ${lastOutcome}`;
}

function renderScannerCounters(hardware: HardwareStatus | null): void {
  if (!hardware) {
    setText(scannerCounts, 'Duplicates 0 · Errors 0');
    return;
  }
  setText(
    scannerCounts,
    `Duplicates ${hardware.scanner.duplicateCount} · Errors ${hardware.scanner.errorCount}`,
  );
}

function renderScanResult(result: ScanValidationResult): void {
  if (result.ok) {
    if (scannerOutcome) scannerOutcome.dataset.tone = 'ok';
    setText(scannerOutcome, 'Accepted');
    setText(
      scannerMeta,
      `${result.event.symbology} · ${result.event.valueLength} chars · hash ${result.event.valueHashPrefix} · ${formatDateTime(result.event.capturedAt)}`,
    );
    if (scannerErrorHelp) scannerErrorHelp.hidden = true;
    // Dev-only raw value: present ONLY when the main process includes
    // it behind JDA_SCANNER_DEV_SHOW_VALUE (never in production). It is
    // rendered as text in a clearly-labeled DEV ONLY box.
    if (scannerDevValue && scannerDevValueText) {
      if (result.event.value) {
        scannerDevValueText.textContent = result.event.value;
        scannerDevValue.hidden = false;
      } else {
        scannerDevValueText.textContent = '';
        scannerDevValue.hidden = true;
      }
    }
    pushTimelineEvent(
      'SCAN OK',
      'ok',
      `${result.event.symbology} · ${result.event.valueLength} chars · hash ${result.event.valueHashPrefix}`,
    );
    return;
  }

  if (scannerOutcome) scannerOutcome.dataset.tone = 'danger';
  setText(scannerOutcome, result.code.replaceAll('_', ' '));
  setText(
    scannerMeta,
    `Rejected · ${result.valueLength} chars · hash ${result.valueHashPrefix ?? 'none'} · ${formatDateTime(result.capturedAt)}`,
  );
  if (scannerErrorHelp) {
    scannerErrorHelp.textContent =
      SCAN_ERROR_COPY[result.code] ?? 'Scan rejected. Review the scanner configuration and retry.';
    scannerErrorHelp.hidden = false;
  }
  if (scannerDevValue && scannerDevValueText) {
    scannerDevValueText.textContent = '';
    scannerDevValue.hidden = true;
  }
  pushTimelineEvent('SCAN ERR', 'danger', `${result.code.replaceAll('_', ' ')} · ${result.valueLength} chars`);
}

function clearScannerDevValue(): void {
  if (!scannerDevValue || !scannerDevValueText) return;
  scannerDevValueText.textContent = '';
  scannerDevValue.hidden = true;
}

async function refresh(): Promise<void> {
  const bridge = bridgeOrNull();
  if (!bridge) {
    setText(screenTitle, 'Agent Bridge Unavailable');
    return;
  }
  const [snapshot, hardware] = await Promise.all([
    bridge.getAgentStatus(),
    bridge.getHardwareStatus(),
  ]);
  render({ ...snapshot, hardware });
}

async function validateScannerCapture(): Promise<void> {
  const capturedText = scannerInput?.value ?? '';
  if (scannerInput) {
    scannerInput.value = '';
    scannerInput.focus();
  }
  clearScannerDevValue();
  if (scannerValidateButton) scannerValidateButton.disabled = true;
  try {
    const result = await window.jadeAgent.validateScannerInput(capturedText);
    renderScanResult(result);
    const hardware = await window.jadeAgent.getHardwareStatus();
    renderScannerCounters(hardware);
  } catch {
    if (scannerOutcome) scannerOutcome.dataset.tone = 'danger';
    setText(scannerOutcome, 'Scanner validation failed');
    setText(scannerMeta, 'Harness could not validate this capture.');
    if (scannerErrorHelp) scannerErrorHelp.hidden = true;
    clearScannerDevValue();
  } finally {
    if (scannerValidateButton) scannerValidateButton.disabled = false;
  }
}

// If the preload bridge failed to load (window.jadeAgent missing), a
// bare property access would throw synchronously AFTER the button is
// set to 'Claiming...' — escaping the listener and freezing the UI.
// Guard it, surface the failure visibly, and reset the button.
function resetClaimButton(): void {
  if (submitButton) {
    submitButton.disabled = false;
    submitButton.textContent = 'Claim Device';
  }
}

function bridgeOrNull(): Window['jadeAgent'] | null {
  const bridge = (window as Partial<Window>).jadeAgent;
  if (!bridge) {
    console.error('[claim-trace] BRIDGE_MISSING window.jadeAgent is not available');
    setText(message, 'Agent bridge unavailable. Close and relaunch the Device Agent.');
    pushTimelineEvent('BRIDGE', 'danger', 'Preload bridge missing — relaunch the agent');
    return null;
  }
  return bridge;
}

submitButton?.addEventListener('click', () => {
  console.info('[claim-trace] CLAIM_CLICKED');
  const code = setupInput?.value ?? '';
  const label = deviceLabelInput?.value || undefined;
  if (setupInput) setupInput.value = '';
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Claiming...';
  }
  const bridge = bridgeOrNull();
  if (!bridge) {
    resetClaimButton();
    return;
  }
  console.info('[claim-trace] IPC_SENT');
  void bridge
    .claimSetupCode(code, label)
    .then(async (snapshot) => {
      const hardware = await bridge.getHardwareStatus();
      render({ ...snapshot, hardware });
    })
    .catch(() => {
      resetClaimButton();
      setText(message, 'Device claim failed. Try again or ask an admin for a new setup code.');
      pushTimelineEvent('CLAIM', 'danger', 'Device claim failed');
    });
});

checkActivationButton?.addEventListener('click', () => {
  if (checkActivationButton) {
    checkActivationButton.disabled = true;
    checkActivationButton.textContent = 'Checking...';
  }
  void window.jadeAgent
    .checkActivation()
    .then(async (snapshot) => {
      const hardware = await window.jadeAgent.getHardwareStatus();
      render({ ...snapshot, hardware });
    })
    .catch(() => {
      if (checkActivationButton) {
        checkActivationButton.disabled = false;
        checkActivationButton.textContent = 'Check now';
      }
      setText(message, 'Activation check failed. Device remains locked.');
      pushTimelineEvent('ACTIVATE', 'danger', 'Activation check failed — device remains locked');
    });
});

activateButton?.addEventListener('click', () => {
  void window.jadeAgent.mockActivate().then(async (snapshot) => {
    const hardware = await window.jadeAgent.getHardwareStatus();
    render({ ...snapshot, hardware });
  });
});

disableButton?.addEventListener('click', () => {
  void window.jadeAgent.disable().then(async (snapshot) => {
    const hardware = await window.jadeAgent.getHardwareStatus();
    render({ ...snapshot, hardware });
  });
});

refreshButton?.addEventListener('click', () => {
  void refresh();
});

scannerValidateButton?.addEventListener('click', () => {
  void validateScannerCapture();
});

scannerInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== 'Tab') return;
  event.preventDefault();
  void validateScannerCapture();
});

// ─── Phase 3C — HID capture bench (presentation only) ──────────────
//
// Renders the SAFE projections the main process exposes: device names,
// vendor/product ids, masked serials, and UPPER_SNAKE status codes.
// Raw device paths, HID report bytes, and scan values never reach this
// file. No timers — the bench updates on user actions only.

const scannerCaptureMode = document.querySelector<HTMLElement>('#scanner-capture-mode');
const scannerSelectedDevice = document.querySelector<HTMLElement>('#scanner-selected-device');
const scannerHidDetectButton = document.querySelector<HTMLButtonElement>('#scanner-hid-detect');
const scannerWedgeFallbackButton = document.querySelector<HTMLButtonElement>('#scanner-wedge-fallback');
const scannerHidShowAll = document.querySelector<HTMLInputElement>('#scanner-hid-show-all');
const scannerHidStatus = document.querySelector<HTMLElement>('#scanner-hid-status');
const scannerHidDeviceList = document.querySelector<HTMLUListElement>('#scanner-hid-devices');

// Last device list from the most recent detect, re-rendered when the
// "Show all HID devices" toggle flips (no re-enumeration needed).
let lastHidDevices: SafeScannerHidDevice[] = [];

const HID_CATEGORY_LABEL: Record<SafeScannerHidDevice['category'], string> = {
  SCANNER: 'Scanner',
  KEYBOARD_SCANNER: 'Keyboard-mode scanner',
  KEYBOARD: 'Keyboard',
  POINTER: 'Mouse / pointer',
  SYSTEM_CONTROLLER: 'System / LED controller',
  OTHER: 'Other HID device',
};

const HID_REASON_COPY: Record<string, string> = {
  HID_MODULE_UNAVAILABLE:
    'Native HID support could not be loaded on this machine. Keyboard Wedge stays active.',
  HID_ENUMERATION_FAILED:
    'Could not list HID devices. Replug the scanner and detect again.',
  HID_SELECTION_INVALID:
    'That device selection is no longer valid. Detect devices again.',
  HID_DEVICE_NOT_FOUND:
    'Device not found — it may have been unplugged. Detect devices again.',
  HID_OPEN_BLOCKED_OR_BUSY:
    'Windows blocked opening this device (keyboard-class scanners are OS-claimed). Switch the scanner to HID-POS mode or stay on Keyboard Wedge.',
  HID_OPEN_FAILED:
    'Could not open this device. Check permissions or use Keyboard Wedge.',
  HID_DEVICE_DISCONNECTED:
    'The scanner disconnected. Reconnect it and detect again — Keyboard Wedge still works.',
  HID_PREFERRED_DEVICE_ABSENT:
    'The previously selected scanner is not connected. Keyboard Wedge stays active.',
  HID_MULTIPLE_MATCHES:
    'Several matching scanners are connected — detect devices and choose one manually.',
  NO_SCANNER:
    'No scanner detected — keyboard-wedge fallback is ready in JPPOS while the cashier is open.',
  SELECT_SCANNER:
    'Select scanner — two matching units are connected; detect devices and pick one.',
};

function hex4(value: number): string {
  return value.toString(16).padStart(4, '0');
}

function renderCaptureStatus(status: ScannerCaptureStatus): void {
  setText(
    scannerCaptureMode,
    status.mode === 'HID_RAW' ? 'HID Raw (focus-independent)' : 'Keyboard Wedge',
  );
  const device = status.selectedDevice;
  setText(
    scannerSelectedDevice,
    device
      ? `${device.product ?? 'HID device'} (${hex4(device.vendorId)}:${hex4(device.productId)})`
      : 'None',
  );
  if (status.reconnecting || status.hidState === 'RECONNECTING') {
    setText(
      scannerHidStatus,
      'Scanner disconnected — reconnecting automatically. Keyboard wedge still works.',
    );
    return;
  }
  if (status.captureSource === 'HID' && status.hidState === 'CAPTURING') {
    setText(
      scannerHidStatus,
      'HID scanner active — scans route to POS even while JPPOS is focused.',
    );
    return;
  }
  // Wedge mode is the steady, "ready" state — show the reason hint if
  // an HID attempt fell back, otherwise the plain ready copy.
  if (status.hidReasonCode) {
    setText(
      scannerHidStatus,
      HID_REASON_COPY[status.hidReasonCode] ?? `Keyboard-wedge scanner ready in JPPOS (${status.hidReasonCode}).`,
    );
    return;
  }
  setText(
    scannerHidStatus,
    'Keyboard-wedge scanner ready in JPPOS — scans work while the cashier screen is open. Switch the scanner to HID-POS mode for focus-independent agent capture.',
  );
}

function renderHidDeviceList(devices: SafeScannerHidDevice[]): void {
  if (!scannerHidDeviceList) return;
  lastHidDevices = devices;
  const showAll = scannerHidShowAll?.checked === true;
  const visible = showAll ? devices : devices.filter((d) => d.defaultVisible);
  scannerHidDeviceList.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'small';
    empty.textContent = devices.length === 0
      ? 'No HID devices listed. Replug the scanner and detect again.'
      : 'No likely scanners found. Tick "Show all HID devices" to see every device.';
    scannerHidDeviceList.append(empty);
    return;
  }
  for (const device of visible) {
    const item = document.createElement('li');
    item.className = 'hid-device-row';
    const label = document.createElement('span');
    const name = device.product ?? device.manufacturer ?? 'HID device';
    const hints: string[] = [HID_CATEGORY_LABEL[device.category]];
    if (device.keyboardClass) hints.push('Often OS-blocked on Windows');
    if (device.serialMasked) hints.push(`SN ${device.serialMasked}`);
    label.textContent = `${name} · ${hex4(device.vendorId)}:${hex4(device.productId)} · ${hints.join(' · ')}`;
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = device.recommendation === 'USE' ? 'secondary' : 'ghost';
    selectButton.textContent =
      device.recommendation === 'USE'
        ? 'Use this scanner'
        : device.recommendation === 'TRY_HID_MODE'
          ? 'Try HID mode'
          : 'Not recommended';
    selectButton.addEventListener('click', () => {
      const bridge = bridgeOrNull();
      if (!bridge) return;
      void bridge.selectScannerHidDevice(device.key).then((status) => {
        renderCaptureStatus(status);
      });
    });
    item.append(label, selectButton);
    scannerHidDeviceList.append(item);
  }
}

scannerHidShowAll?.addEventListener('change', () => {
  renderHidDeviceList(lastHidDevices);
});

scannerHidDetectButton?.addEventListener('click', () => {
  const bridge = bridgeOrNull();
  if (!bridge) return;
  setText(scannerHidStatus, 'Detecting HID devices…');
  void bridge.listScannerHidDevices().then(async (devices) => {
    renderHidDeviceList(devices);
    renderCaptureStatus(await bridge.getScannerCaptureStatus());
  });
});

scannerWedgeFallbackButton?.addEventListener('click', () => {
  const bridge = bridgeOrNull();
  if (!bridge) return;
  void bridge.useScannerWedgeMode().then((status) => {
    renderCaptureStatus(status);
    scannerHidDeviceList?.replaceChildren();
  });
});

{
  const bridge = bridgeOrNull();
  if (bridge) {
    void bridge.getScannerCaptureStatus().then(renderCaptureStatus);
  }
}

void refresh();

export {};
