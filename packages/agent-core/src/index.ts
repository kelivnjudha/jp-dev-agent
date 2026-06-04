import type {
  AgentConnectionStatus,
  AgentRegistrationStatus,
  AgentMode,
  BranchDeviceBranchSummary,
  BranchDeviceSessionSummary,
  BranchDeviceStatusValue,
  DeviceCapability,
  DeviceRegistrationSnapshot,
  PendingDeviceRegistrationState,
} from '@jade-dev-agent/protocol';

export type SetupCodeClaimErrorCode =
  | 'API_UNAVAILABLE'
  | 'MALFORMED_RESPONSE'
  | 'SETUP_CODE_INVALID'
  | 'SETUP_CODE_EXPIRED'
  | 'SETUP_CODE_REVOKED'
  | 'SETUP_CODE_USED'
  | 'RATE_LIMITED'
  | 'CONFIG_INVALID'
  | 'SETUP_CODE_REQUIRED'
  | 'UNKNOWN';

export type ActivationCheckErrorCode =
  | 'DEVICE_NOT_ACTIVE'
  | 'DEVICE_DISABLED'
  | 'DEVICE_DENIED'
  | 'DEVICE_REVOKED'
  | 'SESSION_CHALLENGE_INVALID'
  | 'SESSION_SIGNATURE_INVALID'
  | 'CHALLENGE_EXPIRED'
  | 'SIGNING_PAYLOAD_MISMATCH'
  | 'API_UNAVAILABLE'
  | 'MALFORMED_RESPONSE'
  | 'CONFIG_INVALID'
  | 'LOCAL_IDENTITY_MISSING'
  | 'UNKNOWN';

export interface AgentState {
  status: AgentRegistrationStatus;
  mode: AgentMode;
  capabilities: DeviceCapability[];
  deviceId?: string;
  branch?: BranchDeviceBranchSummary | null;
  safeHidPrefix?: string;
  deviceLabel?: string;
  claimedAt?: string;
  serverStatus?: BranchDeviceStatusValue;
  connectionStatus?: AgentConnectionStatus;
  sessionStatus?: string;
  sessionExpiresAt?: string | null;
  lastActivationCheckAt?: string;
  message: string;
  updatedAt: string;
}

export function maskSetupCode(setupCode: string): string {
  const trimmed = setupCode.trim();
  if (trimmed.length <= 4) return '••••';
  return `${trimmed.slice(0, 4)}••••`;
}

export function createInitialAgentState(hasLocalIdentity: boolean): AgentState {
  const now = new Date().toISOString();
  if (hasLocalIdentity) {
    return {
      status: 'UNREGISTERED',
      mode: 'SETUP',
      capabilities: [],
      message: 'Local device identity is ready. Enter a setup code to claim this device.',
      updatedAt: now,
    };
  }
  return {
    status: 'UNREGISTERED',
    mode: 'SETUP',
    capabilities: [],
    message: 'Enter a JP Admin setup code to claim this device.',
    updatedAt: now,
  };
}

export function createPendingActivationState(
  pendingDevice: PendingDeviceRegistrationState,
  message = 'Waiting for Admin Activation.',
): AgentState {
  return {
    status: 'PENDING_ACTIVATION',
    mode: 'SETUP',
    capabilities: [...pendingDevice.allowedCapabilities],
    deviceId: pendingDevice.deviceId,
    branch: pendingDevice.branch,
    safeHidPrefix: pendingDevice.safeHidPrefix,
    ...(pendingDevice.deviceLabel !== undefined
      ? { deviceLabel: pendingDevice.deviceLabel }
      : {}),
    claimedAt: pendingDevice.claimedAt,
    serverStatus: pendingDevice.serverStatus,
    connectionStatus: 'DISCONNECTED',
    message,
    updatedAt: new Date().toISOString(),
  };
}

export function createInitialAgentStateFromPending(
  pendingDevice: PendingDeviceRegistrationState | null,
  hasLocalIdentity: boolean,
): AgentState {
  if (pendingDevice) return createPendingActivationState(pendingDevice);
  return createInitialAgentState(hasLocalIdentity);
}

export function startSetupCodeClaim(state: AgentState): AgentState {
  return {
    ...state,
    status: 'SETUP_CODE_SUBMITTING',
    message: 'Submitting setup code. The code is not stored on this device.',
    updatedAt: new Date().toISOString(),
  };
}

export function failSetupCodeClaim(
  state: AgentState,
  errorCode: SetupCodeClaimErrorCode,
): AgentState {
  return {
    ...state,
    status: 'ERROR',
    message: safeSetupCodeClaimErrorMessage(errorCode),
    updatedAt: new Date().toISOString(),
  };
}

export function startActivationCheck(state: AgentState): AgentState {
  return {
    ...state,
    status: 'ACTIVE_SESSION_CONNECTING',
    connectionStatus: 'CHECKING_ACTIVATION',
    lastActivationCheckAt: new Date().toISOString(),
    message: 'Checking activation...',
    updatedAt: new Date().toISOString(),
  };
}

export function completeActivationCheck(
  state: AgentState,
  session: BranchDeviceSessionSummary,
): AgentState {
  return {
    ...state,
    status: 'ACTIVE',
    mode: modeForCapabilities(state.capabilities),
    serverStatus: 'ACTIVE',
    connectionStatus: 'CONNECTED',
    sessionStatus: session.status,
    sessionExpiresAt: session.expiresAt ?? null,
    lastActivationCheckAt: new Date().toISOString(),
    message: 'Secure device session established.',
    updatedAt: new Date().toISOString(),
  };
}

export function failActivationCheck(
  state: AgentState,
  errorCode: ActivationCheckErrorCode,
): AgentState {
  const now = new Date().toISOString();
  const {
    sessionStatus: _sessionStatus,
    sessionExpiresAt: _sessionExpiresAt,
    ...stateWithoutSession
  } = state;
  const base = {
    ...stateWithoutSession,
    connectionStatus: 'LOCKED' as const,
    lastActivationCheckAt: now,
    message: safeActivationCheckErrorMessage(errorCode),
    updatedAt: now,
  };

  switch (errorCode) {
    case 'DEVICE_NOT_ACTIVE':
      return {
        ...base,
        status: 'PENDING_ACTIVATION',
        mode: 'SETUP',
        serverStatus: 'PENDING_ACTIVATION',
        connectionStatus: 'DISCONNECTED',
      };
    case 'DEVICE_DISABLED':
      return { ...base, status: 'DISABLED', mode: 'SETUP', serverStatus: 'DISABLED' };
    case 'DEVICE_DENIED':
      return { ...base, status: 'DENIED', mode: 'SETUP', serverStatus: 'DENIED' };
    case 'DEVICE_REVOKED':
      return { ...base, status: 'REVOKED', mode: 'SETUP', serverStatus: 'REVOKED' };
    case 'CHALLENGE_EXPIRED':
      return { ...base, status: 'PENDING_ACTIVATION', mode: 'SETUP' };
    case 'API_UNAVAILABLE':
      return { ...base, status: 'PENDING_ACTIVATION', mode: 'SETUP' };
    default:
      return { ...base, status: 'ERROR', mode: 'SETUP' };
  }
}

export function safeSetupCodeClaimErrorMessage(
  errorCode: SetupCodeClaimErrorCode,
): string {
  switch (errorCode) {
    case 'SETUP_CODE_REQUIRED':
      return 'Setup code is required.';
    case 'SETUP_CODE_INVALID':
      return 'This setup code cannot be used. Ask an admin for a new setup code.';
    case 'SETUP_CODE_EXPIRED':
      return 'This setup code has expired. Ask an admin for a new setup code.';
    case 'SETUP_CODE_REVOKED':
      return 'This setup code was revoked. Ask an admin for a new setup code.';
    case 'SETUP_CODE_USED':
      return 'This setup code was already used. Ask an admin for a new setup code.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait before trying again.';
    case 'API_UNAVAILABLE':
      return 'Cannot reach Jade Palace API. Check the connection.';
    case 'MALFORMED_RESPONSE':
      return 'Unexpected server response. Device remains locked.';
    case 'CONFIG_INVALID':
      return 'Device API configuration is invalid. Check the agent API base URL.';
    default:
      return 'Device claim failed. Ask an admin for a new setup code or try again later.';
  }
}

export function safeActivationCheckErrorMessage(
  errorCode: ActivationCheckErrorCode,
): string {
  switch (errorCode) {
    case 'DEVICE_NOT_ACTIVE':
      return 'Device is still waiting for admin activation.';
    case 'DEVICE_DISABLED':
      return 'This device is disabled. Contact an admin.';
    case 'DEVICE_DENIED':
      return 'This device was denied. Reset is required before trying again.';
    case 'DEVICE_REVOKED':
      return 'This device was revoked. Reset is required before re-enrollment.';
    case 'SESSION_CHALLENGE_INVALID':
    case 'SESSION_SIGNATURE_INVALID':
    case 'SIGNING_PAYLOAD_MISMATCH':
      return 'Secure device session could not be verified.';
    case 'CHALLENGE_EXPIRED':
      return 'Activation challenge expired. Please try again.';
    case 'API_UNAVAILABLE':
      return 'Cannot reach Jade Palace API. Check the connection.';
    case 'MALFORMED_RESPONSE':
      return 'Unexpected server response. Device remains locked.';
    case 'CONFIG_INVALID':
      return 'Device API configuration is invalid. Check the agent API base URL.';
    case 'LOCAL_IDENTITY_MISSING':
      return 'Local device identity is missing. Reset is required before trying again.';
    default:
      return 'Activation check failed. Device remains locked.';
  }
}

export function mockSubmitSetupCodeForPendingActivation(
  state: AgentState,
  setupCode: string,
): AgentState {
  const trimmed = setupCode.trim();
  if (!trimmed) return failSetupCodeClaim(state, 'SETUP_CODE_REQUIRED');
  const entered = startSetupCodeClaim(state);
  return {
    ...entered,
    status: 'PENDING_ACTIVATION',
    deviceId: `dev-local-${Date.now().toString(36)}`,
    safeHidPrefix: 'DEV-MOCK',
    message:
      'DEV ONLY: setup code claim simulated. Waiting for mock activation.',
    updatedAt: new Date().toISOString(),
  };
}

export function mockActivateDevice(
  state: AgentState,
  capabilities: DeviceCapability[] = ['POS_TERMINAL'],
): AgentState {
  if (state.status !== 'PENDING_ACTIVATION') {
    return {
      ...state,
      status: 'ERROR',
      message: 'Device must be pending activation before mock activation.',
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...state,
    status: 'ACTIVE',
    mode: modeForCapabilities(capabilities),
    capabilities,
    message: 'DEV ONLY: device marked active locally.',
    updatedAt: new Date().toISOString(),
  };
}

export function disableDevice(state: AgentState, reason = 'Disabled'): AgentState {
  return {
    ...state,
    status: 'DISABLED',
    message: reason,
    updatedAt: new Date().toISOString(),
  };
}

export function toRegistrationSnapshot(
  state: AgentState,
): DeviceRegistrationSnapshot {
  const snapshot: DeviceRegistrationSnapshot = {
    status: state.status,
    capabilities: [...state.capabilities],
    mode: state.mode,
    message: state.message,
    updatedAt: state.updatedAt,
  };

  if (state.deviceId !== undefined) {
    snapshot.deviceId = state.deviceId;
  }
  if (state.branch !== undefined) {
    snapshot.branch = state.branch;
  }
  if (state.safeHidPrefix !== undefined) {
    snapshot.safeHidPrefix = state.safeHidPrefix;
  }
  if (state.deviceLabel !== undefined) {
    snapshot.deviceLabel = state.deviceLabel;
  }
  if (state.claimedAt !== undefined) {
    snapshot.claimedAt = state.claimedAt;
  }
  if (state.serverStatus !== undefined) {
    snapshot.serverStatus = state.serverStatus;
  }
  if (state.connectionStatus !== undefined) {
    snapshot.connectionStatus = state.connectionStatus;
  }
  if (state.sessionStatus !== undefined) {
    snapshot.sessionStatus = state.sessionStatus;
  }
  if (state.sessionExpiresAt !== undefined) {
    snapshot.sessionExpiresAt = state.sessionExpiresAt;
  }
  if (state.lastActivationCheckAt !== undefined) {
    snapshot.lastActivationCheckAt = state.lastActivationCheckAt;
  }

  return snapshot;
}

function modeForCapabilities(capabilities: DeviceCapability[]): AgentMode {
  if (capabilities.includes('SHOP_CHECKPOINT')) return 'CHECKPOINT';
  if (capabilities.includes('PRINTER_BRIDGE')) return 'PRINTER_BRIDGE';
  if (capabilities.includes('NFC_READER')) return 'NFC_READER';
  return 'POS';
}
