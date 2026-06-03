export const DEVICE_TYPES = [
  'BRANCH_WORKSTATION',
  'POS_TERMINAL',
  'SHOP_CHECKPOINT',
  'PRINTER_BRIDGE',
  'NFC_READER',
] as const;

export type BranchDeviceType = (typeof DEVICE_TYPES)[number];
export type DeviceType = BranchDeviceType;

export const DEVICE_CAPABILITIES = [
  'POS_TERMINAL',
  'PRINTER_BRIDGE',
  'SHOP_CHECKPOINT',
  'QR_DISPLAY',
  'NFC_READER',
  'BARCODE_SCANNER',
] as const;

export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const BRANCH_DEVICE_STATUSES = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'DISABLED',
  'DENIED',
  'REVOKED',
  'LOST',
  'REPLACED',
] as const;

export type BranchDeviceStatus = (typeof BRANCH_DEVICE_STATUSES)[number];
export type BranchDeviceStatusValue = BranchDeviceStatus | (string & {});
export const DEVICE_STATUSES = BRANCH_DEVICE_STATUSES;
export type DeviceStatus = BranchDeviceStatus;

export const BRANCH_DEVICE_SETUP_CODE_STATUSES = [
  'ACTIVE',
  'CLAIMED',
  'USED',
  'EXPIRED',
  'REVOKED',
  'DENIED',
] as const;

export type BranchDeviceSetupCodeStatus =
  (typeof BRANCH_DEVICE_SETUP_CODE_STATUSES)[number];

export const AGENT_REGISTRATION_STATUSES = [
  'UNREGISTERED',
  'SETUP_CODE_SUBMITTING',
  'PENDING_ACTIVATION',
  'ACTIVE_SESSION_CONNECTING',
  'ACTIVE',
  'SESSION_EXPIRED_RETRYING',
  'DISABLED',
  'DENIED',
  'REVOKED',
  'ERROR',
  'RESET_REQUIRED',
] as const;

export type AgentRegistrationStatus =
  (typeof AGENT_REGISTRATION_STATUSES)[number];

export const AGENT_MODES = [
  'SETUP',
  'POS',
  'CHECKPOINT',
  'PRINTER_BRIDGE',
  'NFC_READER',
] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export interface BranchDeviceBranchSummary {
  id: string;
  code: string | null;
  name: string | null;
}

export interface BranchDeviceSummary {
  id: string;
  branch: BranchDeviceBranchSummary | null;
  deviceType: BranchDeviceType;
  capabilities: DeviceCapability[];
  status: BranchDeviceStatusValue;
  label: string | null;
  safeHidPrefix: string | null;
  os: string | null;
  appVersion: string | null;
  localIp: string | null;
  lastSeenAt: string | null;
  setupCode?: {
    id: string;
    codePrefix: string | null;
    status: BranchDeviceSetupCodeStatus | (string & {});
  } | null;
  approvedAt?: string | null;
  deniedAt?: string | null;
  disabledAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface BranchDeviceSetupCodeClaimInput {
  setupCode: string;
  publicKeyPem: string;
  hardwareFingerprintHash: string;
  safeHidPrefix: string;
  os: string;
  appVersion: string;
  localIp?: string;
  deviceLabel?: string;
}

export interface BranchDeviceSetupCodeClaimApiRequest {
  setupCode: string;
  publicKey: string;
  hardwareFingerprintHash: string;
  safeHidPrefix: string;
  os: string;
  appVersion: string;
  localIp?: string;
  deviceLabel?: string;
}

export interface BranchDeviceSetupCodeClaimResponse {
  deviceId: string;
  status: BranchDeviceStatusValue;
  branch: BranchDeviceBranchSummary | null;
  allowedCapabilities: DeviceCapability[];
  message: string;
}

export type SetupCodeClaimRequest = BranchDeviceSetupCodeClaimInput;
export type SetupCodeClaimResult = BranchDeviceSetupCodeClaimResponse;

export interface BranchDeviceSessionChallengeRequest {
  deviceId: string;
}

export interface BranchDeviceSessionChallengeResponse {
  challenge: string;
  timestamp: string;
  expiresAt: string;
  signingPayload: string;
}

export interface BranchDeviceSessionIssueRequest {
  deviceId: string;
  challenge: string;
  signature: string;
  timestamp: string;
}

export interface BranchDeviceSessionSummary {
  status: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  lastSeenAt?: string | null;
}

export interface BranchDeviceSessionIssueResponse {
  session: BranchDeviceSessionSummary;
  sessionToken: string;
}

export interface BranchDeviceHeartbeatRequest {
  appVersion?: string;
  localIp?: string;
}

export interface BranchDeviceHeartbeatResponse {
  ok: boolean;
  device: BranchDeviceSummary;
  session: BranchDeviceSessionSummary;
}

export interface DeviceSession {
  deviceId: string;
  sessionId?: string;
  expiresAt: string;
  capabilities: DeviceCapability[];
}

export interface AgentHealth {
  ok: boolean;
  mode: AgentMode;
  deviceStatus: AgentRegistrationStatus;
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
  status: AgentRegistrationStatus;
  setupCodeMasked?: string;
  deviceId?: string;
  capabilities: DeviceCapability[];
  mode: AgentMode;
  message: string;
  updatedAt: string;
}

export function buildBranchDeviceSessionSigningPayload({
  deviceId,
  challenge,
  timestamp,
}: BranchDeviceSessionIssueRequest): string {
  return `JP_BRANCH_DEVICE_SESSION_V1\n${deviceId}\n${challenge}\n${timestamp}`;
}
