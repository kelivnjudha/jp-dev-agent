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

export const AGENT_CONNECTION_STATUSES = [
  'DISCONNECTED',
  'CHECKING_ACTIVATION',
  'CONNECTED',
  'REFRESHING',
  'RECONNECTING',
  'LOCKED',
  'ERROR',
] as const;

export type AgentConnectionStatus =
  (typeof AGENT_CONNECTION_STATUSES)[number];

export const ACTIVATION_CHECK_STATUSES = [
  'IDLE',
  'CHECKING',
  'WAITING',
  'RETRYING',
] as const;

export type ActivationCheckStatus =
  (typeof ACTIVATION_CHECK_STATUSES)[number];

export const SCAN_SOURCES = ['WEDGE', 'HID', 'SERIAL'] as const;

export type ScanSource = (typeof SCAN_SOURCES)[number];

export const SCAN_SYMBOLOGIES = [
  'EAN13',
  'EAN8',
  'UPCA',
  'UPCE',
  'CODE128',
  'QR',
  'UNKNOWN',
] as const;

export type ScanSymbology = (typeof SCAN_SYMBOLOGIES)[number];

export const SCAN_VALIDATION_ERROR_CODES = [
  'SCAN_EMPTY',
  'SCAN_TOO_LONG',
  'SCAN_CONTROL_CHARS',
  'SCAN_INVALID_CHARSET',
  'SCAN_UNSUPPORTED_FORMAT',
  'SCAN_EAN_CHECK_DIGIT_INVALID',
  'SCAN_DUPLICATE',
  'SCAN_RATE_LIMITED',
] as const;

export type ScanValidationErrorCode =
  (typeof SCAN_VALIDATION_ERROR_CODES)[number];

export interface ScanEvent {
  type: 'SCAN';
  scanId: string;
  capturedAt: string;
  source: ScanSource;
  symbology: ScanSymbology;
  valueLength: number;
  valueHashPrefix: string;
  value?: string;
}

export type ScanValidationResult =
  | {
      ok: true;
      event: ScanEvent;
    }
  | {
      ok: false;
      code: ScanValidationErrorCode;
      capturedAt: string;
      source: ScanSource;
      valueLength: number;
      valueHashPrefix: string | null;
    };

export interface ScannerStatus {
  enabled: boolean;
  source: ScanSource;
  lastScanAt: string | null;
  lastOutcome: 'ACCEPTED' | ScanValidationErrorCode | null;
  duplicateCount: number;
  errorCount: number;
}

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

export type BranchDeviceSessionChallengeValidationErrorCode =
  | 'SESSION_CHALLENGE_INVALID'
  | 'CHALLENGE_EXPIRED'
  | 'SIGNING_PAYLOAD_MISMATCH';

export class BranchDeviceSessionChallengeValidationError extends Error {
  constructor(readonly code: BranchDeviceSessionChallengeValidationErrorCode) {
    super(code);
    this.name = 'BranchDeviceSessionChallengeValidationError';
  }
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

export interface PendingDeviceRegistrationState {
  deviceId: string;
  serverStatus: BranchDeviceStatusValue;
  branch: BranchDeviceBranchSummary | null;
  allowedCapabilities: DeviceCapability[];
  safeHidPrefix: string;
  deviceLabel?: string;
  claimedAt: string;
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
    futureForwardingEligible: boolean;
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
  deviceId?: string;
  branch?: BranchDeviceBranchSummary | null;
  safeHidPrefix?: string;
  deviceLabel?: string;
  claimedAt?: string;
  serverStatus?: BranchDeviceStatusValue;
  connectionStatus?: AgentConnectionStatus;
  sessionStatus?: string;
  sessionExpiresAt?: string | null;
  activationCheckStatus?: ActivationCheckStatus;
  lastActivationCheckAt?: string;
  nextActivationCheckAt?: string;
  activationCheckFailures?: number;
  lastActivationCheckErrorCode?: string;
  lastHeartbeatAt?: string;
  nextHeartbeatAt?: string;
  heartbeatFailures?: number;
  lastHeartbeatErrorCode?: string;
  lastSessionRefreshAt?: string;
  nextSessionRefreshAt?: string;
  sessionRefreshInFlight?: boolean;
  sessionRefreshFailures?: number;
  lastSessionRefreshErrorCode?: string;
  futureProxyForwardingEligible?: boolean;
  capabilities: DeviceCapability[];
  mode: AgentMode;
  message: string;
  updatedAt: string;
}

export function buildBranchDeviceSessionSigningPayload({
  deviceId,
  challenge,
  timestamp,
}: Pick<BranchDeviceSessionIssueRequest, 'deviceId' | 'challenge' | 'timestamp'>): string {
  return `JP_BRANCH_DEVICE_SESSION_V1\n${deviceId}\n${challenge}\n${timestamp}`;
}

export function validateBranchDeviceSessionChallengeSigningPayload({
  deviceId,
  challenge,
  nowMs = Date.now(),
  minValidityMs = 5_000,
}: {
  deviceId: string;
  challenge: BranchDeviceSessionChallengeResponse;
  nowMs?: number;
  minValidityMs?: number;
}): string {
  if (
    !challenge.challenge.trim() ||
    !challenge.timestamp.trim() ||
    !challenge.expiresAt.trim() ||
    !challenge.signingPayload.trim()
  ) {
    throw new BranchDeviceSessionChallengeValidationError('SESSION_CHALLENGE_INVALID');
  }

  const timestamp = parseIsoTimestamp(challenge.timestamp);
  const expiresAt = parseIsoTimestamp(challenge.expiresAt);
  if (timestamp === null || expiresAt === null) {
    throw new BranchDeviceSessionChallengeValidationError('SESSION_CHALLENGE_INVALID');
  }
  if (expiresAt <= nowMs + minValidityMs) {
    throw new BranchDeviceSessionChallengeValidationError('CHALLENGE_EXPIRED');
  }

  const expectedPayload = buildBranchDeviceSessionSigningPayload({
    deviceId,
    challenge: challenge.challenge,
    timestamp: challenge.timestamp,
  });
  if (challenge.signingPayload !== expectedPayload) {
    throw new BranchDeviceSessionChallengeValidationError('SIGNING_PAYLOAD_MISMATCH');
  }
  return expectedPayload;
}

function parseIsoTimestamp(value: string): number | null {
  if (!value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
