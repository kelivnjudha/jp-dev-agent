export const DEVICE_TYPES = [
  'BRANCH_WORKSTATION',
  'POS_TERMINAL',
  'SHOP_CHECKPOINT',
  'PRINTER_BRIDGE',
  'NFC_READER',
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_CAPABILITIES = [
  'POS_TERMINAL',
  'PRINTER_BRIDGE',
  'SHOP_CHECKPOINT',
  'QR_DISPLAY',
  'NFC_READER',
  'BARCODE_SCANNER',
] as const;

export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const DEVICE_STATUSES = [
  'UNREGISTERED',
  'SETUP_CODE_ENTERED',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'DISABLED',
  'ERROR',
] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const AGENT_MODES = [
  'SETUP',
  'POS',
  'CHECKPOINT',
  'PRINTER_BRIDGE',
  'NFC_READER',
] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export interface SetupCodeClaimRequest {
  setupCode: string;
  publicKeyPem: string;
  hardwareFingerprintHash: string;
  safeHidPrefix: string;
  os: string;
  appVersion: string;
  requestedAt: string;
}

export interface SetupCodeClaimResult {
  status: Extract<DeviceStatus, 'PENDING_ACTIVATION' | 'ERROR'>;
  deviceId?: string;
  message: string;
}

export interface DeviceSession {
  deviceId: string;
  sessionId: string;
  expiresAt: string;
  capabilities: DeviceCapability[];
}

export interface AgentHealth {
  ok: boolean;
  mode: AgentMode;
  deviceStatus: DeviceStatus;
  proxy: {
    enabled: boolean;
    host: '127.0.0.1';
    port: number;
  };
  capabilities: DeviceCapability[];
  appVersion: string;
  updatedAt: string;
}

export interface SafeDeviceIdentity {
  publicKeyPem: string;
  hardwareFingerprintHash: string;
  safeHidPrefix: string;
}

export interface DeviceRegistrationSnapshot {
  status: DeviceStatus;
  setupCodeMasked?: string;
  deviceId?: string;
  capabilities: DeviceCapability[];
  mode: AgentMode;
  message: string;
  updatedAt: string;
}
