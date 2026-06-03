import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createInitialAgentState,
  disableDevice,
  mockActivateDevice,
  mockSubmitSetupCodeForPendingActivation,
  toRegistrationSnapshot,
  type AgentState,
} from '@jade-dev-agent/agent-core';
import {
  DEFAULT_PROXY_PORT,
  startAgentProxy,
  type RunningAgentProxy,
} from '@jade-dev-agent/agent-proxy';
import { createSafeDeviceIdentity } from '@jade-dev-agent/device-identity';
import { DevFileDeviceStorage, type DeviceStorage } from '@jade-dev-agent/device-storage';
import { PlaceholderNfcReaderAdapter } from '@jade-dev-agent/nfc-adapter';
import { PlaceholderPrinterAdapter } from '@jade-dev-agent/printer-adapter';
import type { AgentHealth, DeviceCapability } from '@jade-dev-agent/protocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_VERSION = '0.1.0-scaffold';
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
  return {
    ok: state.status !== 'ERROR' && state.status !== 'DISABLED',
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
  };
}

async function ensureLocalIdentity(): Promise<void> {
  if (!storage) return;
  const existing = await storage.readIdentity();
  if (existing) return;
  const generated = createSafeDeviceIdentity();
  await storage.writeIdentity({
    privateKeyPem: generated.privateKeyPem,
    publicKeyPem: generated.identity.publicKeyPem,
    createdAt: new Date().toISOString(),
  });
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
  storage = new DevFileDeviceStorage(join(app.getPath('userData'), 'dev-device-identity.json'));
  const existing = await storage.readIdentity();
  state = createInitialAgentState(Boolean(existing));

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

ipcMain.handle('agent:submitSetupCode', async (_event, setupCode: unknown) => {
  const code = typeof setupCode === 'string' ? setupCode : '';
  await ensureLocalIdentity();
  state = mockSubmitSetupCodeForPendingActivation(state, code);
  return getSnapshot();
});

ipcMain.handle('agent:mockActivate', () => {
  state = mockActivateDevice(state, DEFAULT_MOCK_CAPABILITIES);
  return getSnapshot();
});

ipcMain.handle('agent:disable', () => {
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
