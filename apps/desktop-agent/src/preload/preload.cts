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

/** Phase 3C — safe HID bench shapes. The renderer only ever sees the
 *  masked projections built in the main process: no raw device paths,
 *  no full serials, no report bytes, no scan values. */
export interface SafeScannerHidDevice {
  key: string;
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  usagePage: number | null;
  usage: number | null;
  serialMasked: string | null;
  keyboardClass: boolean;
  likelyScanner: boolean;
}

export interface ScannerCaptureStatus {
  mode: 'WEDGE' | 'HID_RAW';
  hidSupported: boolean;
  hidState: 'IDLE' | 'CAPTURING' | 'ERROR' | 'UNAVAILABLE';
  hidReasonCode: string | null;
  selectedDevice: {
    vendorId: number;
    productId: number;
    product: string | null;
  } | null;
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
  listScannerHidDevices: (): Promise<SafeScannerHidDevice[]> =>
    ipcRenderer.invoke('agent:listScannerHidDevices'),
  selectScannerHidDevice: (key: string): Promise<ScannerCaptureStatus> =>
    ipcRenderer.invoke('agent:selectScannerHidDevice', key),
  useScannerWedgeMode: (): Promise<ScannerCaptureStatus> =>
    ipcRenderer.invoke('agent:useScannerWedgeMode'),
  getScannerCaptureStatus: (): Promise<ScannerCaptureStatus> =>
    ipcRenderer.invoke('agent:getScannerCaptureStatus'),
};

contextBridge.exposeInMainWorld('jadeAgent', api);

export type JadeAgentBridge = typeof api;
