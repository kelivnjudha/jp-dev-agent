import { contextBridge, ipcRenderer } from 'electron';

import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';
import type { NfcReaderStatus } from '@jade-dev-agent/nfc-adapter';
import type { PrinterStatus } from '@jade-dev-agent/printer-adapter';

export interface AgentSnapshot {
  registration: DeviceRegistrationSnapshot;
  health: AgentHealth;
}

export interface HardwareStatus {
  printer: PrinterStatus;
  nfc: NfcReaderStatus;
}

const api = {
  getSnapshot: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:getSnapshot'),
  submitSetupCode: (setupCode: string): Promise<AgentSnapshot> =>
    ipcRenderer.invoke('agent:submitSetupCode', setupCode),
  mockActivate: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:mockActivate'),
  disable: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:disable'),
  getHardwareStatus: (): Promise<HardwareStatus> =>
    ipcRenderer.invoke('agent:getHardwareStatus'),
};

contextBridge.exposeInMainWorld('jadeAgent', api);

export type JadeAgentBridge = typeof api;
