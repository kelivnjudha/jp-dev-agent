import type {
  ActivationCheckStatus,
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
  | 'RATE_LIMITED'
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
  activationCheckStatus?: ActivationCheckStatus;
  lastActivationCheckAt?: string;
  nextActivationCheckAt?: string;
  activationCheckFailures?: number;
  lastActivationCheckErrorCode?: ActivationCheckErrorCode;
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
    activationCheckStatus: 'IDLE',
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
  const stateWithoutActiveSession = stripActivationPollingMetadata(
    stripActiveSessionMetadata(state),
  );
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
  const stateWithoutActiveSession = stripActivationPollingMetadata(
    stripActiveSessionMetadata(state),
  );
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
  const {
    nextActivationCheckAt: _nextActivationCheckAt,
    lastActivationCheckErrorCode: _lastActivationCheckErrorCode,
    ...stateWithoutScheduledCheck
  } = stateWithoutActiveSession;
  return {
    ...stateWithoutScheduledCheck,
    status: 'ACTIVE_SESSION_CONNECTING',
    connectionStatus: 'CHECKING_ACTIVATION',
    activationCheckStatus: 'CHECKING',
    lastActivationCheckAt: new Date().toISOString(),
    message: 'Checking activation...',
    updatedAt: new Date().toISOString(),
  };
}

export function scheduleActivationCheck(
  state: AgentState,
  options: {
    nextActivationCheckAt: string;
    status?: Extract<ActivationCheckStatus, 'WAITING' | 'RETRYING'>;
    errorCode?: ActivationCheckErrorCode;
    incrementFailures?: boolean;
    message?: string;
    nowIso?: string;
  },
): AgentState {
  const now = options.nowIso ?? new Date().toISOString();
  const status = options.status ?? (options.errorCode ? 'RETRYING' : 'WAITING');
  const failureCount = options.incrementFailures
    ? (state.activationCheckFailures ?? 0) + 1
    : (state.activationCheckFailures ?? 0);
  const stateWithoutActiveSession = stripActiveSessionMetadata(state);
  const {
    lastActivationCheckErrorCode: _lastActivationCheckErrorCode,
    ...stateWithoutPreviousError
  } = stateWithoutActiveSession;
  return {
    ...stateWithoutPreviousError,
    status: 'PENDING_ACTIVATION',
    mode: 'SETUP',
    connectionStatus: 'DISCONNECTED',
    activationCheckStatus: status,
    nextActivationCheckAt: options.nextActivationCheckAt,
    activationCheckFailures: failureCount,
    ...(options.errorCode ? { lastActivationCheckErrorCode: options.errorCode } : {}),
    message:
      options.message
      ?? (status === 'RETRYING'
        ? "Can't reach API. We'll try again."
        : "Waiting for admin activation. We'll continue checking automatically."),
    updatedAt: now,
  };
}

export function completeActivationCheck(
  state: AgentState,
  session: BranchDeviceSessionSummary,
): AgentState {
  const {
    activationCheckStatus: _activationCheckStatus,
    nextActivationCheckAt: _nextActivationCheckAt,
    activationCheckFailures: _activationCheckFailures,
    lastActivationCheckErrorCode: _lastActivationCheckErrorCode,
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
    activationCheckStatus: _activationCheckStatus,
    nextActivationCheckAt: _nextActivationCheckAt,
    ...stateWithoutSession
  } = state;
  const base = {
    ...stateWithoutSession,
    connectionStatus: 'LOCKED' as const,
    activationCheckStatus: 'IDLE' as const,
    lastActivationCheckAt: now,
    lastActivationCheckErrorCode: errorCode,
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
    case 'RATE_LIMITED':
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
    case 'RATE_LIMITED':
      return 'Activation check was rate limited. Please wait before trying again.';
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
    ...stripActivationPollingMetadata(state),
    status: 'ACTIVE',
    mode: modeForCapabilities(capabilities),
    capabilities,
    message: 'DEV ONLY: device marked active locally.',
    updatedAt: new Date().toISOString(),
  };
}

export function disableDevice(state: AgentState, reason = 'Disabled'): AgentState {
  const stateWithoutActiveSession = stripActivationPollingMetadata(
    stripActiveSessionMetadata(state),
  );
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
  if (state.activationCheckStatus !== undefined) {
    snapshot.activationCheckStatus = state.activationCheckStatus;
  }
  if (state.nextActivationCheckAt !== undefined) {
    snapshot.nextActivationCheckAt = state.nextActivationCheckAt;
  }
  if (state.activationCheckFailures !== undefined) {
    snapshot.activationCheckFailures = state.activationCheckFailures;
  }
  if (state.lastActivationCheckErrorCode !== undefined) {
    snapshot.lastActivationCheckErrorCode = state.lastActivationCheckErrorCode;
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

// ─── POS device-proof readiness (Phase 2C fast unlock) ────────────
//
// Pure classifier for the local POS proof endpoint. It splits "not
// ready" into TRANSIENT warm-up states (the device will become ready on
// its own — and a heartbeat can be woken early to accelerate it) vs
// TERMINAL states (revoked/denied/disabled/unactivated/capability
// missing — never auto-retried, the gate stays locked).
//
// Why transient warm-up exists at all: `completeSessionRefresh` (and
// fresh activation) deliberately leave `futureProxyForwardingEligible`
// false — only a CONFIRMED heartbeat flips it true and stamps
// `lastHeartbeatAt`. The first heartbeat after a session issue is
// scheduled a full interval out, so without a wake-up the proof
// endpoint refuses for up to that interval even though the device is
// fully trusted. `wakeHeartbeat: true` marks exactly the states a
// single immediate heartbeat resolves.

export type PosDeviceProofReadinessCode =
  | 'POS_DEVICE_PROOF_WARMING'
  | 'POS_DEVICE_HEARTBEAT_STALE'
  | 'POS_DEVICE_REFRESH_IN_FLIGHT'
  | 'POS_DEVICE_NOT_CONNECTED'
  | 'POS_DEVICE_NOT_ACTIVE'
  | 'POS_DEVICE_CAPABILITY_MISSING'
  | 'POS_DEVICE_PROOF_EXPIRED'
  | 'POS_DEVICE_PROOF_INVALID';

export type PosDeviceProofReadiness =
  | { ready: true }
  | {
      ready: false;
      code: PosDeviceProofReadinessCode;
      /** True when the agent is expected to become ready on its own
       *  shortly (warm-up); callers may wait briefly and re-check.
       *  False is terminal for this request — never auto-retried. */
      transient: boolean;
      /** True when one immediate heartbeat resolves the blocker. */
      wakeHeartbeat: boolean;
    };

export interface PosDeviceProofReadinessInput {
  state: AgentState;
  hasSessionToken: boolean;
  sessionRefreshInFlight: boolean;
  nowMs: number;
  heartbeatFreshnessMs: number;
  maxHeartbeatClockSkewMs?: number;
}

const notReadyForPosProof = (
  code: PosDeviceProofReadinessCode,
  transient: boolean,
  wakeHeartbeat: boolean,
): PosDeviceProofReadiness => ({ ready: false, code, transient, wakeHeartbeat });

export function evaluatePosDeviceProofReadiness({
  state,
  hasSessionToken,
  sessionRefreshInFlight,
  nowMs,
  heartbeatFreshnessMs,
  maxHeartbeatClockSkewMs = 120_000,
}: PosDeviceProofReadinessInput): PosDeviceProofReadiness {
  // No device session token in memory — either never activated or the
  // lifecycle cleared it on a terminal failure. Never auto-wake.
  if (!hasSessionToken) {
    return notReadyForPosProof('POS_DEVICE_NOT_ACTIVE', false, false);
  }
  // Startup / recovery states with an own retry lifecycle — the proof
  // caller may briefly wait, but must not inject extra heartbeats while
  // session establishment is converging.
  if (
    state.status === 'ACTIVE_SESSION_CONNECTING'
    || state.status === 'SESSION_EXPIRED_RETRYING'
  ) {
    return notReadyForPosProof('POS_DEVICE_NOT_CONNECTED', true, false);
  }
  // Anything else that is not ACTIVE on both the agent and the server
  // is terminal for proof purposes (revoked / denied / disabled /
  // pending activation / error / reset required).
  if (state.status !== 'ACTIVE' || state.serverStatus !== 'ACTIVE') {
    return notReadyForPosProof('POS_DEVICE_NOT_ACTIVE', false, false);
  }
  if (!state.capabilities.includes('POS_TERMINAL')) {
    return notReadyForPosProof('POS_DEVICE_CAPABILITY_MISSING', false, false);
  }
  if (!state.deviceId || !state.branch?.id) {
    return notReadyForPosProof('POS_DEVICE_PROOF_INVALID', false, false);
  }
  if (sessionRefreshInFlight || state.connectionStatus === 'REFRESHING') {
    return notReadyForPosProof('POS_DEVICE_REFRESH_IN_FLIGHT', true, false);
  }
  if (state.connectionStatus !== 'CONNECTED') {
    return notReadyForPosProof('POS_DEVICE_NOT_CONNECTED', true, false);
  }
  const sessionExpiresAtMs = state.sessionExpiresAt
    ? new Date(state.sessionExpiresAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(sessionExpiresAtMs) || sessionExpiresAtMs <= nowMs) {
    return notReadyForPosProof('POS_DEVICE_PROOF_EXPIRED', false, false);
  }
  // Post-refresh / post-activation warm-up: trust is established but a
  // confirmed heartbeat has not yet re-armed proof eligibility.
  if (state.futureProxyForwardingEligible !== true) {
    return notReadyForPosProof('POS_DEVICE_PROOF_WARMING', true, true);
  }
  const lastHeartbeatMs = state.lastHeartbeatAt
    ? new Date(state.lastHeartbeatAt).getTime()
    : Number.NaN;
  if (
    !Number.isFinite(lastHeartbeatMs)
    || nowMs - lastHeartbeatMs > heartbeatFreshnessMs
    || lastHeartbeatMs - nowMs > maxHeartbeatClockSkewMs
  ) {
    return notReadyForPosProof('POS_DEVICE_HEARTBEAT_STALE', true, true);
  }
  return { ready: true };
}

/** Share one in-flight execution of an async task across concurrent
 *  callers. While a run is pending every caller gets the same promise;
 *  after it settles the next call starts a fresh run. Used so many
 *  simultaneous POS proof requests trigger at most ONE readiness
 *  heartbeat wake-up. */
export function createSingleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = task().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
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

function stripActivationPollingMetadata(state: AgentState): AgentState {
  const {
    activationCheckStatus: _activationCheckStatus,
    nextActivationCheckAt: _nextActivationCheckAt,
    activationCheckFailures: _activationCheckFailures,
    lastActivationCheckErrorCode: _lastActivationCheckErrorCode,
    ...stateWithoutActivationPolling
  } = state;
  return stateWithoutActivationPolling;
}
