import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';
import type { AgentSnapshot, HardwareStatus } from '../preload/preload.js';

interface ViewModel {
  registration: DeviceRegistrationSnapshot;
  health: AgentHealth;
  controls: AgentSnapshot['controls'];
  hardware: HardwareStatus | null;
}

const setupInput = document.querySelector<HTMLInputElement>('#setup-code');
const deviceLabelInput = document.querySelector<HTMLInputElement>('#device-label');
const submitButton = document.querySelector<HTMLButtonElement>('#submit-code');
const activateButton = document.querySelector<HTMLButtonElement>('#mock-activate');
const disableButton = document.querySelector<HTMLButtonElement>('#disable-device');
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh');
const devControls = document.querySelector<HTMLElement>('#dev-controls');
const statusBadge = document.querySelector<HTMLElement>('#status-badge');
const modeBadge = document.querySelector<HTMLElement>('#mode-badge');
const message = document.querySelector<HTMLElement>('#message');
const capabilityList = document.querySelector<HTMLElement>('#capabilities');
const proxyStatus = document.querySelector<HTMLElement>('#proxy-status');
const hardwareStatus = document.querySelector<HTMLElement>('#hardware-status');
const screenTitle = document.querySelector<HTMLElement>('#screen-title');
const branchDetail = document.querySelector<HTMLElement>('#branch-detail');
const hidDetail = document.querySelector<HTMLElement>('#hid-detail');
const serverStatusDetail = document.querySelector<HTMLElement>('#server-status-detail');
const claimedAtDetail = document.querySelector<HTMLElement>('#claimed-at-detail');

function setText(element: Element | null, value: string): void {
  if (element) element.textContent = value;
}

function render(next: ViewModel): void {
  const { registration, health, hardware } = next;
  document.body.dataset.status = registration.status;
  setText(statusBadge, registration.status.replaceAll('_', ' '));
  setText(modeBadge, registration.mode.replaceAll('_', ' '));
  setText(message, registration.message);
  setText(screenTitle, titleForStatus(registration.status));
  setText(branchDetail, formatBranch(registration.branch));
  setText(hidDetail, registration.safeHidPrefix ?? 'Unavailable');
  setText(
    serverStatusDetail,
    (registration.serverStatus ?? registration.status).replaceAll('_', ' '),
  );
  setText(claimedAtDetail, formatDateTime(registration.claimedAt));
  setText(
    capabilityList,
    registration.capabilities.length
      ? registration.capabilities.join(' · ')
      : 'No active capabilities yet.',
  );
  setText(
    proxyStatus,
    health.proxy.enabled
      ? `Local proxy online at ${health.proxy.host}:${health.proxy.port}`
      : 'Local proxy offline.',
  );
  setText(
    hardwareStatus,
    hardware
      ? `Printer: ${hardware.printer.message} · NFC: ${hardware.nfc.message}`
      : 'Hardware adapter status unavailable.',
  );

  if (devControls) {
    devControls.hidden = !next.controls.mockFlowEnabled;
  }
  if (submitButton) {
    submitButton.disabled = ['SETUP_CODE_SUBMITTING', 'PENDING_ACTIVATION', 'ACTIVE', 'RESET_REQUIRED'].includes(
      registration.status,
    );
    submitButton.textContent = registration.status === 'SETUP_CODE_SUBMITTING'
      ? 'Claiming...'
      : 'Claim Device';
  }
  if (setupInput) {
    setupInput.disabled = ['SETUP_CODE_SUBMITTING', 'PENDING_ACTIVATION', 'ACTIVE', 'RESET_REQUIRED'].includes(
      registration.status,
    );
  }
  if (deviceLabelInput) {
    deviceLabelInput.disabled = ['SETUP_CODE_SUBMITTING', 'PENDING_ACTIVATION', 'ACTIVE', 'RESET_REQUIRED'].includes(
      registration.status,
    );
    if (registration.deviceLabel) deviceLabelInput.value = registration.deviceLabel;
  }
  if (activateButton) {
    activateButton.disabled = !next.controls.mockFlowEnabled || registration.status !== 'PENDING_ACTIVATION';
  }
  if (disableButton) {
    disableButton.disabled = !next.controls.mockFlowEnabled || registration.status === 'DISABLED';
  }
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
      return 'Jade Device Agent';
  }
}

function formatBranch(branch: DeviceRegistrationSnapshot['branch']): string {
  if (!branch) return 'Not claimed yet.';
  const code = branch.code ? ` (${branch.code})` : '';
  return `${branch.name || 'Assigned branch'}${code}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recorded';
  return date.toLocaleString();
}

async function refresh(): Promise<void> {
  const [snapshot, hardware] = await Promise.all([
    window.jadeAgent.getAgentStatus(),
    window.jadeAgent.getHardwareStatus(),
  ]);
  render({ ...snapshot, hardware });
}

submitButton?.addEventListener('click', () => {
  const code = setupInput?.value ?? '';
  const label = deviceLabelInput?.value || undefined;
  if (setupInput) setupInput.value = '';
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Claiming...';
  }
  void window.jadeAgent
    .claimSetupCode(code, label)
    .then(async (snapshot) => {
      const hardware = await window.jadeAgent.getHardwareStatus();
      render({ ...snapshot, hardware });
    })
    .catch(() => {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Claim Device';
      }
      setText(message, 'Device claim failed. Try again or ask an admin for a new setup code.');
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

void refresh();

export {};
