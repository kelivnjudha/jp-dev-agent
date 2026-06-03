import type {
  AgentRegistrationStatus,
  AgentMode,
  BranchDeviceBranchSummary,
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
    mode: capabilities.includes('SHOP_CHECKPOINT') ? 'CHECKPOINT' : 'POS',
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

  return snapshot;
}
