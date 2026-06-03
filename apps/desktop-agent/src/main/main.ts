import { app, BrowserWindow, ipcMain } from 'electron';
import { networkInterfaces, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BranchDeviceApiError,
  claimBranchDeviceSetupCode,
} from '@jade-dev-agent/agent-api-client';
import {
  createInitialAgentState,
  createInitialAgentStateFromPending,
  createPendingActivationState,
  disableDevice,
  failSetupCodeClaim,
  mockActivateDevice,
  startSetupCodeClaim,
  toRegistrationSnapshot,
  type AgentState,
  type SetupCodeClaimErrorCode,
} from '@jade-dev-agent/agent-core';
import {
  DEFAULT_PROXY_PORT,
  startAgentProxy,
  type RunningAgentProxy,
} from '@jade-dev-agent/agent-proxy';
import {
  computeHardwareFingerprintHash,
  createSafeDeviceIdentity,
  createSafeHidPrefix,
} from '@jade-dev-agent/device-identity';
import {
  DevFileDeviceStorage,
  type DeviceSecretRecord,
  type DeviceStorage,
} from '@jade-dev-agent/device-storage';
import { PlaceholderNfcReaderAdapter } from '@jade-dev-agent/nfc-adapter';
import { PlaceholderPrinterAdapter } from '@jade-dev-agent/printer-adapter';
import type {
  AgentHealth,
  DeviceCapability,
  PendingDeviceRegistrationState,
  SafeDeviceIdentity,
} from '@jade-dev-agent/protocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_VERSION = '0.1.0-scaffold';
const DEFAULT_DEV_API_BASE_URL = 'http://127.0.0.1:3000';
const MOCK_FLOW_ENABLED = process.env.JDA_ENABLE_MOCK_DEVICE_FLOW === 'true';
const DEFAULT_MOCK_CAPABILITIES: DeviceCapability[] = [
  'POS_TERMINAL',
  'BARCODE_SCANNER',
];

let mainWindow: BrowserWindow | null = null;
let state: AgentState = createInitialAgentState(false);
let proxy: RunningAgentProxy | null = null;
let storage: DeviceStorage | null = null;

const printerAdapter = new PlaceholderPrinterAdapter();
const nfcAdapter = new PlaceholderNfcReaderAdapter();

function getHealth(): AgentHealth {
  const unhealthyStatuses = new Set([
    'ERROR',
    'DISABLED',
    'DENIED',
    'REVOKED',
    'RESET_REQUIRED',
  ]);
  return {
    ok: !unhealthyStatuses.has(state.status),
    mode: state.mode,
    deviceStatus: state.status,
    proxy: {
      enabled: proxy !== null,
      host: '127.0.0.1',
      port: proxy?.port ?? DEFAULT_PROXY_PORT,
    },
    capabilities: [...state.capabilities],
    appVersion: APP_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

function getSnapshot() {
  return {
    registration: toRegistrationSnapshot(state),
    health: getHealth(),
    controls: {
      mockFlowEnabled: MOCK_FLOW_ENABLED,
    },
  };
}

async function ensureLocalIdentity(): Promise<SafeDeviceIdentity> {
  if (!storage) {
    const generated = createSafeDeviceIdentity();
    return generated.identity;
  }
  const existing = await storage.readIdentity();
  if (existing) {
    const identity = identityRecordToSafeIdentity(existing);
    if (!existing.hardwareFingerprintHash || !existing.safeHidPrefix) {
      await storage.writeIdentity({
        ...existing,
        hardwareFingerprintHash: identity.hardwareFingerprintHash,
        safeHidPrefix: identity.safeHidPrefix,
      });
    }
    return identity;
  }
  const generated = createSafeDeviceIdentity();
  await storage.writeIdentity({
    privateKeyPem: generated.privateKeyPem,
    publicKeyPem: generated.identity.publicKeyPem,
    hardwareFingerprintHash: generated.identity.hardwareFingerprintHash,
    safeHidPrefix: generated.identity.safeHidPrefix,
    createdAt: new Date().toISOString(),
  });
  return generated.identity;
}

function identityRecordToSafeIdentity(record: DeviceSecretRecord): SafeDeviceIdentity {
  const hardwareFingerprintHash =
    record.hardwareFingerprintHash ?? computeHardwareFingerprintHash(record.publicKeyPem);
  return {
    publicKeyPem: record.publicKeyPem,
    hardwareFingerprintHash,
    safeHidPrefix: record.safeHidPrefix ?? createSafeHidPrefix(hardwareFingerprintHash),
  };
}

function resolveApiBaseUrl(): string | null {
  const rawValue = (process.env.JDA_API_BASE_URL || DEFAULT_DEV_API_BASE_URL).trim();
  try {
    const parsed = new URL(rawValue);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function safeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f<>`]/g, '')
    .slice(0, maxLength);
  return normalized || undefined;
}

function resolveLocalIpForClaim(): string | undefined {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function mapClaimFailure(error: unknown): SetupCodeClaimErrorCode {
  if (error instanceof BranchDeviceApiError) {
    if (
      error.code === 'SETUP_CODE_INVALID' ||
      error.code === 'SETUP_CODE_EXPIRED' ||
      error.code === 'SETUP_CODE_REVOKED' ||
      error.code === 'SETUP_CODE_USED' ||
      error.code === 'RATE_LIMITED' ||
      error.code === 'API_UNAVAILABLE' ||
      error.code === 'MALFORMED_RESPONSE'
    ) {
      return error.code;
    }
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

function createResetRequiredState(message: string): AgentState {
  return {
    status: 'RESET_REQUIRED',
    mode: 'SETUP',
    capabilities: [],
    message,
    updatedAt: new Date().toISOString(),
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'Jade Device Agent',
    backgroundColor: '#061B16',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData');
  storage = new DevFileDeviceStorage(
    join(userDataPath, 'dev-device-identity.json'),
    join(userDataPath, 'dev-device-pending.json'),
  );
  const [existing, pendingDevice] = await Promise.all([
    storage.readIdentity(),
    storage.readPendingDevice(),
  ]);
  state = pendingDevice && !existing
    ? createResetRequiredState('Pending device state exists without local identity. Reset is required.')
    : createInitialAgentStateFromPending(pendingDevice, Boolean(existing));

  proxy = await startAgentProxy({
    port: Number(process.env.JADE_AGENT_PROXY_PORT || DEFAULT_PROXY_PORT),
    getHealth,
    getDeviceStatus: () => toRegistrationSnapshot(state),
    safeLog: (event) => {
      if (process.env.NODE_ENV === 'production') return;
      // Safe metadata only: method/path/status. No bodies, tokens, keys, or setup codes.
      console.info('[agent-proxy]', event);
    },
  });

  createWindow();
}

ipcMain.handle('agent:getSnapshot', () => getSnapshot());

ipcMain.handle('agent:claimSetupCode', async (_event, setupCode: unknown, deviceLabel: unknown) => {
  const rawSetupCode = typeof setupCode === 'string' ? setupCode.trim() : '';
  if (!rawSetupCode) {
    state = failSetupCodeClaim(state, 'SETUP_CODE_REQUIRED');
    return getSnapshot();
  }
  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) {
    state = failSetupCodeClaim(state, 'CONFIG_INVALID');
    return getSnapshot();
  }

  state = startSetupCodeClaim(state);
  try {
    const identity = await ensureLocalIdentity();
    const safeDeviceLabel = safeOptionalString(deviceLabel, 80);
    const localIp = resolveLocalIpForClaim();
    const claim = await claimBranchDeviceSetupCode(
      {
        apiBaseUrl,
        appVersion: APP_VERSION,
      },
      {
        setupCode: rawSetupCode,
        publicKeyPem: identity.publicKeyPem,
        hardwareFingerprintHash: identity.hardwareFingerprintHash,
        safeHidPrefix: identity.safeHidPrefix,
        os: `${platform()} ${release()}`,
        appVersion: APP_VERSION,
        ...(localIp !== undefined ? { localIp } : {}),
        ...(safeDeviceLabel !== undefined ? { deviceLabel: safeDeviceLabel } : {}),
      },
    );
    const pendingDevice: PendingDeviceRegistrationState = {
      deviceId: claim.deviceId,
      serverStatus: claim.status,
      branch: claim.branch,
      allowedCapabilities: [...claim.allowedCapabilities],
      safeHidPrefix: identity.safeHidPrefix,
      ...(safeDeviceLabel !== undefined ? { deviceLabel: safeDeviceLabel } : {}),
      claimedAt: new Date().toISOString(),
    };
    await storage?.writePendingDevice(pendingDevice);
    state = createPendingActivationState(
      pendingDevice,
      'Waiting for Admin Activation. Ask Main Admin or an authorized Admin to activate this device in JP Admin.',
    );
  } catch (error) {
    state = failSetupCodeClaim(state, mapClaimFailure(error));
  }
  return getSnapshot();
});

ipcMain.handle('agent:mockActivate', () => {
  if (!MOCK_FLOW_ENABLED) return getSnapshot();
  state = mockActivateDevice(state, DEFAULT_MOCK_CAPABILITIES);
  return getSnapshot();
});

ipcMain.handle('agent:disable', () => {
  if (!MOCK_FLOW_ENABLED) return getSnapshot();
  state = disableDevice(state, 'DEV ONLY: device disabled locally.');
  return getSnapshot();
});

ipcMain.handle('agent:getHardwareStatus', async () => ({
  printer: await printerAdapter.getStatus(),
  nfc: await nfcAdapter.getStatus(),
}));

app.whenReady().then(() => {
  void bootstrap();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  if (!proxy) return;
  event.preventDefault();
  const currentProxy = proxy;
  proxy = null;
  currentProxy
    .close()
    .catch(() => undefined)
    .finally(() => app.exit(0));
});
