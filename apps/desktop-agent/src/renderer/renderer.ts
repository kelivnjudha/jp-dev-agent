import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';
import type { HardwareStatus } from '../preload/preload.js';

interface ViewModel {
  registration: DeviceRegistrationSnapshot;
  health: AgentHealth;
  hardware: HardwareStatus | null;
}

const setupInput = document.querySelector<HTMLInputElement>('#setup-code');
const submitButton = document.querySelector<HTMLButtonElement>('#submit-code');
const activateButton = document.querySelector<HTMLButtonElement>('#mock-activate');
const disableButton = document.querySelector<HTMLButtonElement>('#disable-device');
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh');
const statusBadge = document.querySelector<HTMLElement>('#status-badge');
const modeBadge = document.querySelector<HTMLElement>('#mode-badge');
const message = document.querySelector<HTMLElement>('#message');
const capabilityList = document.querySelector<HTMLElement>('#capabilities');
const proxyStatus = document.querySelector<HTMLElement>('#proxy-status');
const hardwareStatus = document.querySelector<HTMLElement>('#hardware-status');
const screenTitle = document.querySelector<HTMLElement>('#screen-title');

let model: ViewModel | null = null;

function setText(element: Element | null, value: string): void {
  if (element) element.textContent = value;
}

function render(next: ViewModel): void {
  model = next;
  const { registration, health, hardware } = next;
  document.body.dataset.status = registration.status;
  setText(statusBadge, registration.status.replaceAll('_', ' '));
  setText(modeBadge, registration.mode.replaceAll('_', ' '));
  setText(message, registration.message);
  setText(screenTitle, titleForStatus(registration.status));
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

  if (activateButton) {
    activateButton.disabled = registration.status !== 'PENDING_ACTIVATION';
  }
  if (disableButton) {
    disableButton.disabled = registration.status === 'DISABLED';
  }
}

function titleForStatus(status: DeviceRegistrationSnapshot['status']): string {
  switch (status) {
    case 'UNREGISTERED':
      return 'Setup Code Required';
    case 'SETUP_CODE_SUBMITTING':
      return 'Setup Code Submitting';
    case 'PENDING_ACTIVATION':
      return 'Waiting for Activation';
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
      return 'Device Error';
    case 'RESET_REQUIRED':
      return 'Device Reset Required';
    default:
      return 'Jade Device Agent';
  }
}

async function refresh(): Promise<void> {
  const [snapshot, hardware] = await Promise.all([
    window.jadeAgent.getSnapshot(),
    window.jadeAgent.getHardwareStatus(),
  ]);
  render({ ...snapshot, hardware });
}

submitButton?.addEventListener('click', () => {
  const code = setupInput?.value ?? '';
  void window.jadeAgent.submitSetupCode(code).then(async (snapshot) => {
    const hardware = await window.jadeAgent.getHardwareStatus();
    render({ ...snapshot, hardware });
    if (setupInput) setupInput.value = '';
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
