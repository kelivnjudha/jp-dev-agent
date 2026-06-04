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

export type HeartbeatFailureErrorCode =
  | 'DEVICE_NOT_ACTIVE'
  | 'DEVICE_DISABLED'
  | 'DEVICE_DENIED'
  | 'DEVICE_REVOKED'
  | 'SESSION_TOKEN_MISSING'
  | 'SESSION_TOKEN_INVALID'
  | 'SESSION_EXPIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'API_UNAVAILABLE'
  | 'HEARTBEAT_FAILED'
  | 'RATE_LIMITED'
  | 'MALFORMED_RESPONSE'
  | 'CONFIG_INVALID'
  | 'UNKNOWN';

export type SessionRefreshFailureErrorCode =
  | 'DEVICE_NOT_ACTIVE'
  | 'DEVICE_DISABLED'
  | 'DEVICE_DENIED'
  | 'DEVICE_REVOKED'
  | 'SESSION_CHALLENGE_INVALID'
  | 'SESSION_SIGNATURE_INVALID'
  | 'SESSION_CHALLENGE_FAILED'
  | 'SESSION_ISSUE_FAILED'
  | 'CHALLENGE_EXPIRED'
  | 'SIGNING_PAYLOAD_MISMATCH'
  | 'SESSION_TOKEN_MISSING'
  | 'SESSION_TOKEN_INVALID'
  | 'SESSION_EXPIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'API_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'MALFORMED_RESPONSE'
  | 'CONFIG_INVALID'
  | 'LOCAL_IDENTITY_MISSING'
  | 'IDENTITY_MISMATCH'
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
  lastHeartbeatAt?: string;
  nextHeartbeatAt?: string;
  heartbeatFailures?: number;
  lastHeartbeatErrorCode?: HeartbeatFailureErrorCode;
  lastSessionRefreshAt?: string;
  nextSessionRefreshAt?: string;
  sessionRefreshInFlight?: boolean;
  sessionRefreshFailures?: number;
  lastSessionRefreshErrorCode?: SessionRefreshFailureErrorCode;
  futureProxyForwardingEligible?: boolean;
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
  const stateWithoutActiveSession = stripActiveSessionMetadata(state);
  return {
    ...stateWithoutActiveSession,
    status: 'SETUP_CODE_SUBMITTING',
    mode: 'SETUP',
    connectionStatus: 'DISCONNECTED',
    message: 'Submitting setup code. The code is not stored on this device.',
    updatedAt: new Date().toISOString(),
  };
}

export function failSetupCodeClaim(
  state: AgentState,
  errorCode: SetupCodeClaimErrorCode,
): AgentState {
  const stateWithoutActiveSession = stripActiveSessionMetadata(state);
  return {
    ...stateWithoutActiveSession,
    status: 'ERROR',
    mode: 'SETUP',
    connectionStatus: 'LOCKED',
    message: safeSetupCodeClaimErrorMessage(errorCode),
    updatedAt: new Date().toISOString(),
  };
}

export function startActivationCheck(state: AgentState): AgentState {
  const stateWithoutActiveSession = stripActiveSessionMetadata(state);
  return {
    ...stateWithoutActiveSession,
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
  const {
    lastHeartbeatAt: _lastHeartbeatAt,
    nextHeartbeatAt: _nextHeartbeatAt,
    heartbeatFailures: _heartbeatFailures,
    lastHeartbeatErrorCode: _lastHeartbeatErrorCode,
    lastSessionRefreshAt: _lastSessionRefreshAt,
    nextSessionRefreshAt: _nextSessionRefreshAt,
    sessionRefreshInFlight: _sessionRefreshInFlight,
    sessionRefreshFailures: _sessionRefreshFailures,
    lastSessionRefreshErrorCode: _lastSessionRefreshErrorCode,
    futureProxyForwardingEligible: _futureProxyForwardingEligible,
    ...stateWithoutHeartbeat
  } = state;
  return {
    ...stateWithoutHeartbeat,
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

export function startHeartbeatLifecycle(
  state: AgentState,
  nextHeartbeatAt: string,
): AgentState {
  const {
    lastHeartbeatErrorCode: _lastHeartbeatErrorCode,
    lastSessionRefreshErrorCode: _lastSessionRefreshErrorCode,
    ...stateWithoutHeartbeatError
  } = state;
  return {
    ...stateWithoutHeartbeatError,
    status: 'ACTIVE',
    connectionStatus: 'CONNECTED',
    nextHeartbeatAt,
    heartbeatFailures: 0,
    sessionRefreshInFlight: false,
    futureProxyForwardingEligible: false,
    message: 'Secure device session established. Heartbeat scheduled.',
    updatedAt: new Date().toISOString(),
  };
}

export function completeHeartbeat(
  state: AgentState,
  session: BranchDeviceSessionSummary,
  options: {
    nowIso?: string;
    nextHeartbeatAt: string;
  },
): AgentState {
  const now = options.nowIso ?? new Date().toISOString();
  const {
    lastHeartbeatErrorCode: _lastHeartbeatErrorCode,
    ...stateWithoutHeartbeatError
  } = state;
  return {
    ...stateWithoutHeartbeatError,
    status: 'ACTIVE',
    connectionStatus: 'CONNECTED',
    sessionStatus: session.status,
    sessionExpiresAt: session.expiresAt ?? state.sessionExpiresAt ?? null,
    lastHeartbeatAt: session.lastSeenAt ?? now,
    nextHeartbeatAt: options.nextHeartbeatAt,
    heartbeatFailures: 0,
    sessionRefreshInFlight: false,
    futureProxyForwardingEligible: true,
    message: 'Secure heartbeat confirmed.',
    updatedAt: now,
  };
}

export function scheduleSessionRefresh(
  state: AgentState,
  nextSessionRefreshAt: string,
): AgentState {
  return {
    ...state,
    nextSessionRefreshAt,
    sessionRefreshInFlight: false,
    updatedAt: new Date().toISOString(),
  };
}

export function startSessionRefresh(state: AgentState): AgentState {
  const {
    lastSessionRefreshErrorCode: _lastSessionRefreshErrorCode,
    ...stateWithoutRefreshError
  } = state;
  return {
    ...stateWithoutRefreshError,
    status: state.status === 'SESSION_EXPIRED_RETRYING'
      ? 'SESSION_EXPIRED_RETRYING'
      : 'ACTIVE',
    connectionStatus: 'REFRESHING',
    sessionRefreshInFlight: true,
    futureProxyForwardingEligible: false,
    message: 'Refreshing secure device session...',
    updatedAt: new Date().toISOString(),
  };
}

export function completeSessionRefresh(
  state: AgentState,
  session: BranchDeviceSessionSummary,
  options: {
    nowIso?: string;
  } = {},
): AgentState {
  const now = options.nowIso ?? new Date().toISOString();
  const {
    lastSessionRefreshErrorCode: _lastSessionRefreshErrorCode,
    ...stateWithoutRefreshError
  } = state;
  return {
    ...stateWithoutRefreshError,
    status: 'ACTIVE',
    mode: modeForCapabilities(state.capabilities),
    serverStatus: 'ACTIVE',
    connectionStatus: 'CONNECTED',
    sessionStatus: session.status,
    sessionExpiresAt: session.expiresAt ?? null,
    lastSessionRefreshAt: now,
    sessionRefreshInFlight: false,
    sessionRefreshFailures: 0,
    futureProxyForwardingEligible: false,
    message: 'Secure device session refreshed.',
    updatedAt: now,
  };
}

export function failSessionRefreshTransient(
  state: AgentState,
  errorCode: SessionRefreshFailureErrorCode,
  options: {
    nowIso?: string;
    nextSessionRefreshAt: string;
  },
): AgentState {
  const now = options.nowIso ?? new Date().toISOString();
  return {
    ...state,
    status: 'SESSION_EXPIRED_RETRYING',
    connectionStatus: 'RECONNECTING',
    nextSessionRefreshAt: options.nextSessionRefreshAt,
    sessionRefreshInFlight: false,
    sessionRefreshFailures: (state.sessionRefreshFailures ?? 0) + 1,
    lastSessionRefreshErrorCode: errorCode,
    futureProxyForwardingEligible: false,
    message: safeSessionRefreshErrorMessage(errorCode),
    updatedAt: now,
  };
}

export function failSessionRefreshTerminal(
  state: AgentState,
  errorCode: SessionRefreshFailureErrorCode,
): AgentState {
  const now = new Date().toISOString();
  const {
    sessionStatus: _sessionStatus,
    sessionExpiresAt: _sessionExpiresAt,
    nextHeartbeatAt: _nextHeartbeatAt,
    nextSessionRefreshAt: _nextSessionRefreshAt,
    sessionRefreshInFlight: _sessionRefreshInFlight,
    serverStatus: _serverStatus,
    futureProxyForwardingEligible: _futureProxyForwardingEligible,
    ...stateWithoutActiveSession
  } = state;
  const base = {
    ...stateWithoutActiveSession,
    connectionStatus: 'LOCKED' as const,
    sessionRefreshFailures: (state.sessionRefreshFailures ?? 0) + 1,
    lastSessionRefreshErrorCode: errorCode,
    futureProxyForwardingEligible: false,
    message: safeSessionRefreshErrorMessage(errorCode),
    updatedAt: now,
  };

  switch (errorCode) {
    case 'DEVICE_DISABLED':
      return { ...base, status: 'DISABLED', mode: 'SETUP', serverStatus: 'DISABLED' };
    case 'DEVICE_DENIED':
      return { ...base, status: 'DENIED', mode: 'SETUP', serverStatus: 'DENIED' };
    case 'DEVICE_REVOKED':
      return { ...base, status: 'REVOKED', mode: 'SETUP', serverStatus: 'REVOKED' };
    case 'MALFORMED_RESPONSE':
    case 'CONFIG_INVALID':
      return { ...base, status: 'ERROR', mode: 'SETUP', connectionStatus: 'ERROR' };
    default:
      return { ...base, status: 'RESET_REQUIRED', mode: 'SETUP' };
  }
}

export function failHeartbeatTransient(
  state: AgentState,
  errorCode: HeartbeatFailureErrorCode,
  options: {
    nowIso?: string;
    nextHeartbeatAt: string;
  },
): AgentState {
  const now = options.nowIso ?? new Date().toISOString();
  return {
    ...state,
    status: 'SESSION_EXPIRED_RETRYING',
    connectionStatus: 'RECONNECTING',
    nextHeartbeatAt: options.nextHeartbeatAt,
    heartbeatFailures: (state.heartbeatFailures ?? 0) + 1,
    lastHeartbeatErrorCode: errorCode,
    futureProxyForwardingEligible: false,
    message: safeHeartbeatErrorMessage(errorCode),
    updatedAt: now,
  };
}

export function failHeartbeatTerminal(
  state: AgentState,
  errorCode: HeartbeatFailureErrorCode,
): AgentState {
  const now = new Date().toISOString();
  const {
    sessionStatus: _sessionStatus,
    sessionExpiresAt: _sessionExpiresAt,
    nextHeartbeatAt: _nextHeartbeatAt,
    nextSessionRefreshAt: _nextSessionRefreshAt,
    sessionRefreshInFlight: _sessionRefreshInFlight,
    serverStatus: _serverStatus,
    futureProxyForwardingEligible: _futureProxyForwardingEligible,
    ...stateWithoutActiveSession
  } = state;
  const base = {
    ...stateWithoutActiveSession,
    connectionStatus: 'LOCKED' as const,
    heartbeatFailures: (state.heartbeatFailures ?? 0) + 1,
    lastHeartbeatErrorCode: errorCode,
    futureProxyForwardingEligible: false,
    message: safeHeartbeatErrorMessage(errorCode),
    updatedAt: now,
  };

  switch (errorCode) {
    case 'DEVICE_DISABLED':
      return { ...base, status: 'DISABLED', mode: 'SETUP', serverStatus: 'DISABLED' };
    case 'DEVICE_DENIED':
      return { ...base, status: 'DENIED', mode: 'SETUP', serverStatus: 'DENIED' };
    case 'DEVICE_REVOKED':
      return { ...base, status: 'REVOKED', mode: 'SETUP', serverStatus: 'REVOKED' };
    case 'MALFORMED_RESPONSE':
    case 'CONFIG_INVALID':
      return { ...base, status: 'ERROR', mode: 'SETUP', connectionStatus: 'ERROR' };
    default:
      return { ...base, status: 'RESET_REQUIRED', mode: 'SETUP' };
  }
}

export function failActivationCheck(
  state: AgentState,
  errorCode: ActivationCheckErrorCode,
): AgentState {
  const now = new Date().toISOString();
  const {
    sessionStatus: _sessionStatus,
    sessionExpiresAt: _sessionExpiresAt,
    lastHeartbeatAt: _lastHeartbeatAt,
    nextHeartbeatAt: _nextHeartbeatAt,
    heartbeatFailures: _heartbeatFailures,
    lastHeartbeatErrorCode: _lastHeartbeatErrorCode,
    lastSessionRefreshAt: _lastSessionRefreshAt,
    nextSessionRefreshAt: _nextSessionRefreshAt,
    sessionRefreshInFlight: _sessionRefreshInFlight,
    sessionRefreshFailures: _sessionRefreshFailures,
    lastSessionRefreshErrorCode: _lastSessionRefreshErrorCode,
    futureProxyForwardingEligible: _futureProxyForwardingEligible,
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

export function safeHeartbeatErrorMessage(
  errorCode: HeartbeatFailureErrorCode,
): string {
  switch (errorCode) {
    case 'API_UNAVAILABLE':
      return 'Reconnecting to Jade Palace API. Device actions are temporarily locked.';
    case 'HEARTBEAT_FAILED':
      return 'Device heartbeat failed. Reconnecting before device actions can continue.';
    case 'RATE_LIMITED':
      return 'Heartbeat was rate limited. Reconnecting after a short delay.';
    case 'DEVICE_DISABLED':
      return 'This device is disabled. Contact an admin.';
    case 'DEVICE_DENIED':
      return 'This device was denied. Reset is required before trying again.';
    case 'DEVICE_REVOKED':
      return 'This device was revoked. Reset is required before re-enrollment.';
    case 'DEVICE_NOT_ACTIVE':
      return 'Device is no longer active. Reset or admin review is required.';
    case 'SESSION_TOKEN_MISSING':
    case 'SESSION_TOKEN_INVALID':
    case 'SESSION_EXPIRED':
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 'Device session is no longer valid. Reset or admin review is required.';
    case 'MALFORMED_RESPONSE':
      return 'Unexpected heartbeat response. Device remains locked.';
    case 'CONFIG_INVALID':
      return 'Device API configuration is invalid. Device remains locked.';
    default:
      return 'Device heartbeat failed. Device remains locked.';
  }
}

export function safeSessionRefreshErrorMessage(
  errorCode: SessionRefreshFailureErrorCode,
): string {
  switch (errorCode) {
    case 'API_UNAVAILABLE':
      return 'Reconnecting to Jade Palace API. Device actions are temporarily locked.';
    case 'RATE_LIMITED':
      return 'Session refresh was rate limited. Reconnecting after a short delay.';
    case 'DEVICE_DISABLED':
      return 'This device is disabled. Contact an admin.';
    case 'DEVICE_DENIED':
      return 'This device was denied. Reset is required before trying again.';
    case 'DEVICE_REVOKED':
      return 'This device was revoked. Reset is required before re-enrollment.';
    case 'DEVICE_NOT_ACTIVE':
      return 'Device is no longer active. Reset or admin review is required.';
    case 'SESSION_CHALLENGE_INVALID':
    case 'SESSION_SIGNATURE_INVALID':
    case 'SESSION_CHALLENGE_FAILED':
    case 'SESSION_ISSUE_FAILED':
    case 'CHALLENGE_EXPIRED':
    case 'SIGNING_PAYLOAD_MISMATCH':
      return 'Secure device session could not be refreshed.';
    case 'SESSION_TOKEN_MISSING':
    case 'SESSION_TOKEN_INVALID':
    case 'SESSION_EXPIRED':
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 'Device session is no longer valid. Reset or admin review is required.';
    case 'MALFORMED_RESPONSE':
      return 'Unexpected session refresh response. Device remains locked.';
    case 'CONFIG_INVALID':
      return 'Device API configuration is invalid. Device remains locked.';
    case 'LOCAL_IDENTITY_MISSING':
      return 'Local device identity is missing. Reset is required before trying again.';
    case 'IDENTITY_MISMATCH':
      return 'Local device identity does not match the active device. Reset is required.';
    default:
      return 'Device session refresh failed. Device remains locked.';
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
  const stateWithoutActiveSession = stripActiveSessionMetadata(state);
  return {
    ...stateWithoutActiveSession,
    status: 'DISABLED',
    connectionStatus: 'LOCKED',
    futureProxyForwardingEligible: false,
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
  if (state.lastHeartbeatAt !== undefined) {
    snapshot.lastHeartbeatAt = state.lastHeartbeatAt;
  }
  if (state.nextHeartbeatAt !== undefined) {
    snapshot.nextHeartbeatAt = state.nextHeartbeatAt;
  }
  if (state.heartbeatFailures !== undefined) {
    snapshot.heartbeatFailures = state.heartbeatFailures;
  }
  if (state.lastHeartbeatErrorCode !== undefined) {
    snapshot.lastHeartbeatErrorCode = state.lastHeartbeatErrorCode;
  }
  if (state.lastSessionRefreshAt !== undefined) {
    snapshot.lastSessionRefreshAt = state.lastSessionRefreshAt;
  }
  if (state.nextSessionRefreshAt !== undefined) {
    snapshot.nextSessionRefreshAt = state.nextSessionRefreshAt;
  }
  if (state.sessionRefreshInFlight !== undefined) {
    snapshot.sessionRefreshInFlight = state.sessionRefreshInFlight;
  }
  if (state.sessionRefreshFailures !== undefined) {
    snapshot.sessionRefreshFailures = state.sessionRefreshFailures;
  }
  if (state.lastSessionRefreshErrorCode !== undefined) {
    snapshot.lastSessionRefreshErrorCode = state.lastSessionRefreshErrorCode;
  }
  if (state.futureProxyForwardingEligible !== undefined) {
    snapshot.futureProxyForwardingEligible = state.futureProxyForwardingEligible;
  }

  return snapshot;
}

function modeForCapabilities(capabilities: DeviceCapability[]): AgentMode {
  if (capabilities.includes('SHOP_CHECKPOINT')) return 'CHECKPOINT';
  if (capabilities.includes('PRINTER_BRIDGE')) return 'PRINTER_BRIDGE';
  if (capabilities.includes('NFC_READER')) return 'NFC_READER';
  return 'POS';
}

function stripActiveSessionMetadata(state: AgentState): AgentState {
  const {
    sessionStatus: _sessionStatus,
    sessionExpiresAt: _sessionExpiresAt,
    lastHeartbeatAt: _lastHeartbeatAt,
    nextHeartbeatAt: _nextHeartbeatAt,
    heartbeatFailures: _heartbeatFailures,
    lastHeartbeatErrorCode: _lastHeartbeatErrorCode,
    lastSessionRefreshAt: _lastSessionRefreshAt,
    nextSessionRefreshAt: _nextSessionRefreshAt,
    sessionRefreshInFlight: _sessionRefreshInFlight,
    sessionRefreshFailures: _sessionRefreshFailures,
    lastSessionRefreshErrorCode: _lastSessionRefreshErrorCode,
    futureProxyForwardingEligible: _futureProxyForwardingEligible,
    ...stateWithoutActiveSession
  } = state;
  return stateWithoutActiveSession;
}
