import { contextBridge, ipcRenderer } from 'electron';

import type { AgentHealth, DeviceRegistrationSnapshot } from '@jade-dev-agent/protocol';
import type { NfcReaderStatus } from '@jade-dev-agent/nfc-adapter';
import type { PrinterStatus } from '@jade-dev-agent/printer-adapter';
import type { ScanValidationResult, ScannerStatus } from '@jade-dev-agent/protocol';

export interface AgentSnapshot {
  registration: DeviceRegistrationSnapshot;
  health: AgentHealth;
  controls: {
    mockFlowEnabled: boolean;
  };
}

export interface HardwareStatus {
  printer: PrinterStatus;
  nfc: NfcReaderStatus;
  scanner: ScannerStatus;
}

const api = {
  getAgentStatus: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:getSnapshot'),
  claimSetupCode: (
    setupCode: string,
    deviceLabel?: string,
  ): Promise<AgentSnapshot> =>
    ipcRenderer.invoke('agent:claimSetupCode', setupCode, deviceLabel),
  checkActivation: (): Promise<AgentSnapshot> =>
    ipcRenderer.invoke('agent:checkActivation'),
  mockActivate: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:mockActivate'),
  disable: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:disable'),
  getHardwareStatus: (): Promise<HardwareStatus> =>
    ipcRenderer.invoke('agent:getHardwareStatus'),
  validateScannerInput: (input: string): Promise<ScanValidationResult> =>
    ipcRenderer.invoke('agent:validateScannerInput', input),
};

contextBridge.exposeInMainWorld('jadeAgent', api);

export type JadeAgentBridge = typeof api;
