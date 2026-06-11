import { app, BrowserWindow, ipcMain } from 'electron';
import { networkInterfaces, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BranchDeviceApiError,
  claimBranchDeviceSetupCode,
  issueBranchDeviceSession,
  requestBranchDeviceSessionChallenge,
  sendBranchDeviceHeartbeat,
} from '@jade-dev-agent/agent-api-client';
import {
  completeSessionRefresh,
  completeHeartbeat,
  completeActivationCheck,
  createInitialAgentState,
  createInitialAgentStateFromPending,
  createPendingActivationState,
  disableDevice,
  failActivationCheck,
  failHeartbeatTerminal,
  failHeartbeatTransient,
  failSessionRefreshTerminal,
  failSessionRefreshTransient,
  failSetupCodeClaim,
  mockActivateDevice,
  scheduleActivationCheck,
  scheduleSessionRefresh,
  startSessionRefresh,
  startHeartbeatLifecycle as startHeartbeatStateLifecycle,
  startActivationCheck,
  startSetupCodeClaim,
  toRegistrationSnapshot,
  type ActivationCheckErrorCode,
  type AgentState,
  type HeartbeatFailureErrorCode,
  type SessionRefreshFailureErrorCode,
  type SetupCodeClaimErrorCode,
} from '@jade-dev-agent/agent-core';
import {
  DEFAULT_PROXY_PORT,
  startAgentProxy,
  type RunningAgentProxy,
} from '@jade-dev-agent/agent-proxy';
import {
  computeHardwareFingerprintHash,
  createSafeDeviceIdentity,
  createSafeHidPrefix,
  signDeviceSessionPayload,
} from '@jade-dev-agent/device-identity';
import {
  DevFileDeviceStorage,
  type DeviceSecretRecord,
  type DeviceStorage,
} from '@jade-dev-agent/device-storage';
import { PlaceholderNfcReaderAdapter } from '@jade-dev-agent/nfc-adapter';
import { PlaceholderPrinterAdapter } from '@jade-dev-agent/printer-adapter';
import { WedgeScannerHarnessAdapter } from '@jade-dev-agent/scanner-adapter';
import type {
  AgentHealth,
  BranchDeviceSessionIssueResponse,
  BranchDeviceSessionSummary,
  BranchDeviceStatusValue,
  DeviceCapability,
  PendingDeviceRegistrationState,
  SafeDeviceIdentity,
} from '@jade-dev-agent/protocol';
import {
  BranchDeviceSessionChallengeValidationError,
  validateBranchDeviceSessionChallengeSigningPayload,
} from '@jade-dev-agent/protocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_VERSION = '0.1.0-scaffold';
const DEFAULT_DEV_API_BASE_URL = 'http://127.0.0.1:3000';
const MOCK_FLOW_ENABLED = process.env.JDA_ENABLE_MOCK_DEVICE_FLOW === 'true';
const DEFAULT_MOCK_CAPABILITIES: DeviceCapability[] = [
  'POS_TERMINAL',
  'BARCODE_SCANNER',
];
const HEARTBEAT_INTERVAL_MS = 45_000;
const HEARTBEAT_RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
const SESSION_REFRESH_SAFETY_WINDOW_MS = 60_000;
const ACTIVATION_POLL_INITIAL_DELAY_MS = 5_000;
const ACTIVATION_POLL_INTERVAL_MS = 12_000;
const ACTIVATION_POLL_API_RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;

type SessionRefreshReason =
  | 'scheduled'
  | 'near_expiry'
  | 'heartbeat_session_expired'
  | 'missing_expiry_recovery'
  | 'retry';

type ActivationCheckTrigger = 'manual' | 'poll';
type ActivationScheduleOptions = Omit<
  Parameters<typeof scheduleActivationCheck>[1],
  'nextActivationCheckAt'
>;

let mainWindow: BrowserWindow | null = null;
let state: AgentState = createInitialAgentState(false);
let proxy: RunningAgentProxy | null = null;
let storage: DeviceStorage | null = null;
let deviceSessionToken: string | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let activationPollTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatInFlight = false;
let sessionRefreshInFlight = false;
let heartbeatLifecycleVersion = 0;
let sessionRefreshLifecycleVersion = 0;
let activationPollLifecycleVersion = 0;
let activationCheckInFlight = false;
let sessionExpiredRefreshAttempted = false;
let malformedExpiryRecoveryAttempted = false;

const printerAdapter = new PlaceholderPrinterAdapter();
const nfcAdapter = new PlaceholderNfcReaderAdapter();
const scannerAdapter = new WedgeScannerHarnessAdapter({
  includeValue:
    process.env.NODE_ENV !== 'production'
    && process.env.JDA_SCANNER_DEV_SHOW_VALUE === 'true',
  safeLog: (event) => {
    if (process.env.NODE_ENV === 'production') return;
    // Safe metadata only: no raw barcode, secrets, setup codes, or payload bodies.
    console.info('[scanner]', event);
  },
});

function getHealth(): AgentHealth {
  const unhealthyStatuses = new Set([
    'ERROR',
    'DISABLED',
    'DENIED',
    'REVOKED',
    'RESET_REQUIRED',
    'SESSION_EXPIRED_RETRYING',
  ]);
  return {
    ok: !unhealthyStatuses.has(state.status),
    mode: state.mode,
    deviceStatus: state.status,
    proxy: {
      enabled: proxy !== null,
      host: '127.0.0.1',
      port: proxy?.port ?? DEFAULT_PROXY_PORT,
      futureForwardingEligible: state.futureProxyForwardingEligible === true,
    },
    capabilities: [...state.capabilities],
    appVersion: APP_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

function getSnapshot() {
  return {
    registration: toRegistrationSnapshot(state),
    health: getHealth(),
    controls: {
      mockFlowEnabled: MOCK_FLOW_ENABLED,
    },
  };
}

function clearDeviceSessionToken(): void {
  deviceSessionToken = null;
}

function clearHeartbeatTimer(): void {
  if (!heartbeatTimer) return;
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function clearSessionRefreshTimer(): void {
  if (!sessionRefreshTimer) return;
  clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = null;
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearActivationPollTimer(): void {
  if (!activationPollTimer) return;
  clearTimeout(activationPollTimer);
  activationPollTimer = null;
}

function stopActivationPolling(): void {
  activationPollLifecycleVersion += 1;
  clearActivationPollTimer();
}

function stopHeartbeatLifecycle(options: { clearToken?: boolean } = {}): void {
  heartbeatLifecycleVersion += 1;
  sessionRefreshLifecycleVersion += 1;
  clearHeartbeatTimer();
  clearSessionRefreshTimer();
  clearReconnectTimer();
  heartbeatInFlight = false;
  sessionRefreshInFlight = false;
  sessionExpiredRefreshAttempted = false;
  malformedExpiryRecoveryAttempted = false;
  if (options.clearToken ?? true) clearDeviceSessionToken();
}

function scheduleHeartbeatTimer(version: number, delayMs: number): string {
  clearHeartbeatTimer();
  const nextHeartbeatAt = new Date(Date.now() + delayMs).toISOString();
  heartbeatTimer = setTimeout(() => {
    void runHeartbeat(version);
  }, delayMs);
  return nextHeartbeatAt;
}

function scheduleSessionRefreshTimer(
  version: number,
  delayMs: number,
  reason: SessionRefreshReason,
): string {
  clearSessionRefreshTimer();
  const nextSessionRefreshAt = new Date(Date.now() + delayMs).toISOString();
  sessionRefreshTimer = setTimeout(() => {
    void runSessionRefresh(version, reason);
  }, delayMs);
  return nextSessionRefreshAt;
}

function scheduleReconnectTimer(delayMs: number, action: () => void): string {
  clearReconnectTimer();
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    action();
  }, delayMs);
  return nextAttemptAt;
}

function canScheduleActivationPolling(): boolean {
  return (
    state.status === 'PENDING_ACTIVATION'
    && !heartbeatInFlight
    && !sessionRefreshInFlight
    && state.connectionStatus !== 'REFRESHING'
    && state.connectionStatus !== 'RECONNECTING'
  );
}

function startActivationPolling(delayMs = ACTIVATION_POLL_INITIAL_DELAY_MS): void {
  if (!canScheduleActivationPolling()) return;
  const version = activationPollLifecycleVersion + 1;
  activationPollLifecycleVersion = version;
  scheduleActivationPollingTimer(version, delayMs, {
    status: 'WAITING',
    message: "Waiting for admin activation. We'll continue checking automatically.",
  });
}

function scheduleActivationPollingTimer(
  version: number,
  delayMs: number,
  options: ActivationScheduleOptions,
): void {
  if (version !== activationPollLifecycleVersion || !canScheduleActivationPolling()) return;
  clearActivationPollTimer();
  const nextActivationCheckAt = new Date(Date.now() + delayMs).toISOString();
  activationPollTimer = setTimeout(() => {
    activationPollTimer = null;
    void runActivationCheck('poll', version);
  }, delayMs);
  state = scheduleActivationCheck(state, {
    ...options,
    nextActivationCheckAt,
  });
}

function scheduleActivationRetry(
  version: number,
  errorCode: ActivationCheckErrorCode,
): void {
  if (version !== activationPollLifecycleVersion || !canScheduleActivationPolling()) return;
  const isApiRetry = isApiUnavailableActivationFailure(errorCode);
  const nextFailureCount = isApiRetry
    ? (state.activationCheckFailures ?? 0) + 1
    : (state.activationCheckFailures ?? 0);
  const backoffIndex = Math.min(
    Math.max(nextFailureCount - 1, 0),
    ACTIVATION_POLL_API_RETRY_DELAYS_MS.length - 1,
  );
  const delayMs = isApiRetry
    ? ACTIVATION_POLL_API_RETRY_DELAYS_MS[backoffIndex] ?? 60_000
    : ACTIVATION_POLL_INTERVAL_MS;
  const options: ActivationScheduleOptions = {
    status: isApiRetry ? 'RETRYING' : 'WAITING',
    incrementFailures: isApiRetry,
    message: isApiRetry
      ? "Can't reach API. We'll try again."
      : "Waiting for admin activation. We'll continue checking automatically.",
  };
  if (isApiRetry) {
    options.errorCode = errorCode;
  }
  scheduleActivationPollingTimer(version, delayMs, {
    ...options,
  });
}

function pauseHeartbeatForSessionRefresh(): void {
  heartbeatLifecycleVersion += 1;
  clearHeartbeatTimer();
  heartbeatInFlight = false;
}

function startHeartbeatLifecycle(): void {
  if (!deviceSessionToken || state.status !== 'ACTIVE') return;
  const version = heartbeatLifecycleVersion + 1;
  heartbeatLifecycleVersion = version;
  heartbeatInFlight = false;
  const nextHeartbeatAt = scheduleHeartbeatTimer(version, HEARTBEAT_INTERVAL_MS);
  state = startHeartbeatStateLifecycle(state, nextHeartbeatAt);
  startSessionRefreshLifecycle();
}

function ensureHeartbeatLifecycle(): void {
  if (!deviceSessionToken || state.status !== 'ACTIVE' || sessionRefreshInFlight) return;
  if (heartbeatTimer || heartbeatInFlight) return;
  const version = heartbeatLifecycleVersion || 1;
  heartbeatLifecycleVersion = version;
  const nextHeartbeatAt = scheduleHeartbeatTimer(version, HEARTBEAT_INTERVAL_MS);
  state = startHeartbeatStateLifecycle(state, nextHeartbeatAt);
  ensureSessionRefreshLifecycle();
}

function startSessionRefreshLifecycle(): void {
  if (!deviceSessionToken || state.status !== 'ACTIVE') return;
  const version = sessionRefreshLifecycleVersion + 1;
  sessionRefreshLifecycleVersion = version;
  scheduleSessionRefreshForCurrentSession(version);
}

function ensureSessionRefreshLifecycle(): void {
  if (!deviceSessionToken || state.status !== 'ACTIVE' || sessionRefreshInFlight) return;
  if (sessionRefreshTimer) return;
  const version = sessionRefreshLifecycleVersion || 1;
  sessionRefreshLifecycleVersion = version;
  scheduleSessionRefreshForCurrentSession(version);
}

function scheduleSessionRefreshForCurrentSession(version: number): void {
  if (!deviceSessionToken || !state.deviceId) return;
  const expiresAtMs = parseSessionExpiresAtMs(state.sessionExpiresAt);
  if (expiresAtMs === null) {
    if (malformedExpiryRecoveryAttempted) {
      stopHeartbeatLifecycle();
      state = failSessionRefreshTerminal(state, 'MALFORMED_RESPONSE');
      return;
    }
    malformedExpiryRecoveryAttempted = true;
    const nextSessionRefreshAt = scheduleSessionRefreshTimer(
      version,
      0,
      'missing_expiry_recovery',
    );
    state = scheduleSessionRefresh(state, nextSessionRefreshAt);
    return;
  }

  const delayMs = Math.max(
    0,
    expiresAtMs - Date.now() - SESSION_REFRESH_SAFETY_WINDOW_MS,
  );
  const reason: SessionRefreshReason = delayMs === 0 ? 'near_expiry' : 'scheduled';
  const nextSessionRefreshAt = scheduleSessionRefreshTimer(version, delayMs, reason);
  state = scheduleSessionRefresh(state, nextSessionRefreshAt);
}

async function runHeartbeat(version: number): Promise<void> {
  if (version !== heartbeatLifecycleVersion || heartbeatInFlight) return;
  heartbeatTimer = null;
  if (sessionRefreshInFlight) return;

  if (!deviceSessionToken) {
    stopHeartbeatLifecycle();
    state = failHeartbeatTerminal(state, 'SESSION_TOKEN_MISSING');
    return;
  }

  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) {
    stopHeartbeatLifecycle();
    state = failHeartbeatTerminal(state, 'CONFIG_INVALID');
    return;
  }

  heartbeatInFlight = true;
  try {
    const localIp = resolveLocalIpForClaim();
    const heartbeat = await sendBranchDeviceHeartbeat(
      {
        apiBaseUrl,
        appVersion: APP_VERSION,
      },
      deviceSessionToken,
      localIp !== undefined ? { localIp } : {},
    );
    if (version !== heartbeatLifecycleVersion) return;

    if (!heartbeat.ok) {
      scheduleTransientHeartbeatRetry(version, 'HEARTBEAT_FAILED');
      return;
    }

    if (heartbeat.device.status !== 'ACTIVE') {
      stopHeartbeatLifecycle();
      state = failHeartbeatTerminal(
        state,
        heartbeatFailureCodeForDeviceStatus(heartbeat.device.status),
      );
      return;
    }

    if (!isValidActiveSession(heartbeat.session)) {
      stopHeartbeatLifecycle();
      state = failHeartbeatTerminal(state, 'MALFORMED_RESPONSE');
      return;
    }

    const nextHeartbeatAt = scheduleHeartbeatTimer(version, HEARTBEAT_INTERVAL_MS);
    state = completeHeartbeat(state, heartbeat.session, { nextHeartbeatAt });
    const refreshVersion = sessionRefreshLifecycleVersion || 1;
    sessionRefreshLifecycleVersion = refreshVersion;
    scheduleSessionRefreshForCurrentSession(refreshVersion);
  } catch (error) {
    if (version !== heartbeatLifecycleVersion) return;
    const errorCode = mapHeartbeatFailure(error);
    if (
      errorCode === 'SESSION_EXPIRED'
      && await canAttemptHeartbeatSessionExpiredRefresh()
    ) {
      sessionExpiredRefreshAttempted = true;
      pauseHeartbeatForSessionRefresh();
      const refreshVersion = sessionRefreshLifecycleVersion + 1;
      sessionRefreshLifecycleVersion = refreshVersion;
      void runSessionRefresh(refreshVersion, 'heartbeat_session_expired');
      return;
    }
    if (isTransientHeartbeatFailure(errorCode)) {
      scheduleTransientHeartbeatRetry(version, errorCode);
      return;
    }
    stopHeartbeatLifecycle();
    state = failHeartbeatTerminal(state, errorCode);
  } finally {
    if (version === heartbeatLifecycleVersion) {
      heartbeatInFlight = false;
    }
  }
}

async function runSessionRefresh(
  version: number,
  reason: SessionRefreshReason,
): Promise<void> {
  if (version !== sessionRefreshLifecycleVersion || sessionRefreshInFlight) return;
  clearSessionRefreshTimer();
  clearReconnectTimer();

  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) {
    stopHeartbeatLifecycle();
    state = failSessionRefreshTerminal(state, 'CONFIG_INVALID');
    return;
  }

  if (!deviceSessionToken || !state.deviceId) {
    stopHeartbeatLifecycle();
    state = failSessionRefreshTerminal(state, 'SESSION_TOKEN_MISSING');
    return;
  }

  pauseHeartbeatForSessionRefresh();
  sessionRefreshInFlight = true;
  state = startSessionRefresh(state);

  try {
    const pendingDevice = await readRefreshPendingDevice();
    const identity = await storage?.readIdentity();
    if (!identity) {
      throw new SessionRefreshLifecycleError('LOCAL_IDENTITY_MISSING');
    }

    const config = {
      apiBaseUrl,
      appVersion: APP_VERSION,
    };
    const challenge = await requestBranchDeviceSessionChallenge(
      config,
      pendingDevice.deviceId,
    );
    const signingPayload = validateBranchDeviceSessionChallengeSigningPayload({
      deviceId: pendingDevice.deviceId,
      challenge,
    });
    const signature = signDeviceSessionPayload({
      privateKeyPem: identity.privateKeyPem,
      payload: signingPayload,
    });
    const sessionIssue = await issueBranchDeviceSession(config, {
      deviceId: pendingDevice.deviceId,
      challenge: challenge.challenge,
      signature,
      timestamp: challenge.timestamp,
    });

    assertValidSessionIssue(sessionIssue);
    deviceSessionToken = sessionIssue.sessionToken;
    sessionExpiredRefreshAttempted = false;
    malformedExpiryRecoveryAttempted = false;
    sessionRefreshInFlight = false;
    state = completeSessionRefresh(state, sessionIssue.session);
    startHeartbeatLifecycle();
  } catch (error) {
    if (version !== sessionRefreshLifecycleVersion) return;
    const errorCode = mapSessionRefreshFailure(error);
    if (
      reason !== 'missing_expiry_recovery'
      && isTransientSessionRefreshFailure(errorCode)
    ) {
      scheduleTransientSessionRefreshRetry(version, errorCode);
      return;
    }
    stopHeartbeatLifecycle();
    state = failSessionRefreshTerminal(state, errorCode);
  } finally {
    if (version === sessionRefreshLifecycleVersion) {
      sessionRefreshInFlight = false;
      if (state.sessionRefreshInFlight) {
        state = { ...state, sessionRefreshInFlight: false };
      }
    }
  }
}

function scheduleTransientHeartbeatRetry(
  version: number,
  errorCode: HeartbeatFailureErrorCode,
): void {
  const nextFailureCount = (state.heartbeatFailures ?? 0) + 1;
  const backoffIndex = Math.min(
    nextFailureCount - 1,
    HEARTBEAT_RECONNECT_DELAYS_MS.length - 1,
  );
  const delayMs = HEARTBEAT_RECONNECT_DELAYS_MS[backoffIndex] ?? 60_000;
  clearHeartbeatTimer();
  const nextHeartbeatAt = scheduleReconnectTimer(delayMs, () => {
    void runHeartbeat(version);
  });
  state = failHeartbeatTransient(state, errorCode, { nextHeartbeatAt });
}

function scheduleTransientSessionRefreshRetry(
  version: number,
  errorCode: SessionRefreshFailureErrorCode,
): void {
  const nextFailureCount = (state.sessionRefreshFailures ?? 0) + 1;
  const backoffIndex = Math.min(
    nextFailureCount - 1,
    HEARTBEAT_RECONNECT_DELAYS_MS.length - 1,
  );
  const delayMs = HEARTBEAT_RECONNECT_DELAYS_MS[backoffIndex] ?? 60_000;
  clearSessionRefreshTimer();
  const nextSessionRefreshAt = scheduleReconnectTimer(delayMs, () => {
    void runSessionRefresh(version, 'retry');
  });
  state = failSessionRefreshTransient(state, errorCode, { nextSessionRefreshAt });
}

function isTransientHeartbeatFailure(errorCode: HeartbeatFailureErrorCode): boolean {
  return (
    errorCode === 'API_UNAVAILABLE'
    || errorCode === 'HEARTBEAT_FAILED'
    || errorCode === 'RATE_LIMITED'
  );
}

function isTransientSessionRefreshFailure(errorCode: SessionRefreshFailureErrorCode): boolean {
  return errorCode === 'API_UNAVAILABLE' || errorCode === 'RATE_LIMITED';
}

function isRetryableActivationFailure(errorCode: ActivationCheckErrorCode): boolean {
  return (
    errorCode === 'DEVICE_NOT_ACTIVE'
    || errorCode === 'CHALLENGE_EXPIRED'
    || isApiUnavailableActivationFailure(errorCode)
  );
}

function isApiUnavailableActivationFailure(errorCode: ActivationCheckErrorCode): boolean {
  return errorCode === 'API_UNAVAILABLE' || errorCode === 'RATE_LIMITED';
}

function parseSessionExpiresAtMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const expiresAtMs = new Date(value).getTime();
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
}

function isValidActiveSession(session: BranchDeviceSessionSummary): boolean {
  const expiresAtMs = parseSessionExpiresAtMs(session.expiresAt);
  return session.status === 'ACTIVE' && expiresAtMs !== null && expiresAtMs > Date.now();
}

function assertValidSessionIssue(sessionIssue: BranchDeviceSessionIssueResponse): void {
  if (!sessionIssue.sessionToken.trim() || !isValidActiveSession(sessionIssue.session)) {
    throw new BranchDeviceApiError('MALFORMED_RESPONSE');
  }
}

async function runActivationCheck(
  trigger: ActivationCheckTrigger,
  version = activationPollLifecycleVersion,
): Promise<void> {
  if (trigger === 'poll' && version !== activationPollLifecycleVersion) return;

  if (state.status === 'SESSION_EXPIRED_RETRYING' && deviceSessionToken) return;

  if (state.status === 'ACTIVE' && deviceSessionToken) {
    if (
      sessionRefreshInFlight
      || state.connectionStatus === 'REFRESHING'
      || state.connectionStatus === 'RECONNECTING'
    ) {
      return;
    }
    ensureHeartbeatLifecycle();
    ensureSessionRefreshLifecycle();
    return;
  }

  if (
    activationCheckInFlight
    || heartbeatInFlight
    || sessionRefreshInFlight
    || state.connectionStatus === 'REFRESHING'
    || state.connectionStatus === 'RECONNECTING'
  ) {
    return;
  }

  clearActivationPollTimer();
  activationCheckInFlight = true;
  const retryVersion = version || activationPollLifecycleVersion || 1;
  activationPollLifecycleVersion = retryVersion;

  try {
    const apiBaseUrl = resolveApiBaseUrl();
    if (!apiBaseUrl) {
      stopActivationPolling();
      stopHeartbeatLifecycle();
      state = failActivationCheck(state, 'CONFIG_INVALID');
      return;
    }

    const pendingDevice = (await storage?.readPendingDevice()) ?? pendingDeviceFromState();
    if (!pendingDevice) {
      stopActivationPolling();
      stopHeartbeatLifecycle();
      state = failActivationCheck(state, 'UNKNOWN');
      return;
    }

    const identity = await storage?.readIdentity();
    if (!identity) {
      stopActivationPolling();
      stopHeartbeatLifecycle();
      state = failActivationCheck(
        createPendingActivationState(pendingDevice),
        'LOCAL_IDENTITY_MISSING',
      );
      return;
    }

    stopHeartbeatLifecycle();
    const pendingForCheck = createPendingActivationState(pendingDevice);
    pendingForCheck.activationCheckFailures = state.activationCheckFailures ?? 0;
    if (state.lastActivationCheckErrorCode !== undefined) {
      pendingForCheck.lastActivationCheckErrorCode = state.lastActivationCheckErrorCode;
    }
    state = startActivationCheck(pendingForCheck);

    const config = {
      apiBaseUrl,
      appVersion: APP_VERSION,
    };
    const challenge = await requestBranchDeviceSessionChallenge(
      config,
      pendingDevice.deviceId,
    );
    const signingPayload = validateBranchDeviceSessionChallengeSigningPayload({
      deviceId: pendingDevice.deviceId,
      challenge,
    });
    const signature = signDeviceSessionPayload({
      privateKeyPem: identity.privateKeyPem,
      payload: signingPayload,
    });
    const sessionIssue = await issueBranchDeviceSession(config, {
      deviceId: pendingDevice.deviceId,
      challenge: challenge.challenge,
      signature,
      timestamp: challenge.timestamp,
    });
    assertValidSessionIssue(sessionIssue);
    stopActivationPolling();
    deviceSessionToken = sessionIssue.sessionToken;
    sessionExpiredRefreshAttempted = false;
    malformedExpiryRecoveryAttempted = false;
    state = completeActivationCheck(state, sessionIssue.session);
    startHeartbeatLifecycle();
  } catch (error) {
    const errorCode = mapActivationFailure(error);
    stopHeartbeatLifecycle();
    state = failActivationCheck(state, errorCode);
    if (isRetryableActivationFailure(errorCode)) {
      scheduleActivationRetry(retryVersion, errorCode);
      return;
    }
    stopActivationPolling();
  } finally {
    activationCheckInFlight = false;
  }
}

async function canAttemptHeartbeatSessionExpiredRefresh(): Promise<boolean> {
  if (
    sessionExpiredRefreshAttempted
    || sessionRefreshInFlight
    || !deviceSessionToken
    || !state.deviceId
  ) {
    return false;
  }
  const [pendingDevice, identity] = await Promise.all([
    Promise.resolve(storage?.readPendingDevice()).then((pending) => pending ?? null),
    Promise.resolve(storage?.readIdentity()).then((identity) => identity ?? null),
  ]);
  return Boolean(identity && pendingDevice?.deviceId === state.deviceId);
}

async function readRefreshPendingDevice(): Promise<PendingDeviceRegistrationState> {
  const pendingDevice = (await storage?.readPendingDevice()) ?? pendingDeviceFromState();
  if (!pendingDevice || !state.deviceId) {
    throw new SessionRefreshLifecycleError('IDENTITY_MISMATCH');
  }
  if (pendingDevice.deviceId !== state.deviceId) {
    throw new SessionRefreshLifecycleError('IDENTITY_MISMATCH');
  }
  return pendingDevice;
}

class SessionRefreshLifecycleError extends Error {
  constructor(readonly code: SessionRefreshFailureErrorCode) {
    super(code);
    this.name = 'SessionRefreshLifecycleError';
  }
}

function heartbeatFailureCodeForDeviceStatus(
  status: BranchDeviceStatusValue,
): HeartbeatFailureErrorCode {
  switch (status) {
    case 'DISABLED':
      return 'DEVICE_DISABLED';
    case 'DENIED':
      return 'DEVICE_DENIED';
    case 'REVOKED':
      return 'DEVICE_REVOKED';
    default:
      return 'DEVICE_NOT_ACTIVE';
  }
}

async function ensureLocalIdentity(): Promise<SafeDeviceIdentity> {
  if (!storage) {
    const generated = createSafeDeviceIdentity();
    return generated.identity;
  }
  const existing = await storage.readIdentity();
  if (existing) {
    const identity = identityRecordToSafeIdentity(existing);
    if (!existing.hardwareFingerprintHash || !existing.safeHidPrefix) {
      await storage.writeIdentity({
        ...existing,
        hardwareFingerprintHash: identity.hardwareFingerprintHash,
        safeHidPrefix: identity.safeHidPrefix,
      });
    }
    return identity;
  }
  const generated = createSafeDeviceIdentity();
  await storage.writeIdentity({
    privateKeyPem: generated.privateKeyPem,
    publicKeyPem: generated.identity.publicKeyPem,
    hardwareFingerprintHash: generated.identity.hardwareFingerprintHash,
    safeHidPrefix: generated.identity.safeHidPrefix,
    createdAt: new Date().toISOString(),
  });
  return generated.identity;
}

function identityRecordToSafeIdentity(record: DeviceSecretRecord): SafeDeviceIdentity {
  const hardwareFingerprintHash =
    record.hardwareFingerprintHash ?? computeHardwareFingerprintHash(record.publicKeyPem);
  return {
    publicKeyPem: record.publicKeyPem,
    hardwareFingerprintHash,
    safeHidPrefix: record.safeHidPrefix ?? createSafeHidPrefix(hardwareFingerprintHash),
  };
}

function resolveApiBaseUrl(): string | null {
  const rawValue = (process.env.JDA_API_BASE_URL || DEFAULT_DEV_API_BASE_URL).trim();
  try {
    const parsed = new URL(rawValue);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function safeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f<>`]/g, '')
    .slice(0, maxLength);
  return normalized || undefined;
}

function resolveLocalIpForClaim(): string | undefined {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function mapClaimFailure(error: unknown): SetupCodeClaimErrorCode {
  if (error instanceof BranchDeviceApiError) {
    if (
      error.code === 'SETUP_CODE_INVALID' ||
      error.code === 'SETUP_CODE_EXPIRED' ||
      error.code === 'SETUP_CODE_REVOKED' ||
      error.code === 'SETUP_CODE_USED' ||
      error.code === 'RATE_LIMITED' ||
      error.code === 'API_UNAVAILABLE' ||
      error.code === 'MALFORMED_RESPONSE'
    ) {
      return error.code;
    }
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

function mapActivationFailure(error: unknown): ActivationCheckErrorCode {
  if (error instanceof BranchDeviceSessionChallengeValidationError) {
    return error.code;
  }
  if (error instanceof BranchDeviceApiError) {
    switch (error.code) {
      case 'DEVICE_NOT_ACTIVE':
      case 'DEVICE_DISABLED':
      case 'DEVICE_DENIED':
      case 'DEVICE_REVOKED':
      case 'SESSION_CHALLENGE_INVALID':
      case 'SESSION_SIGNATURE_INVALID':
      case 'API_UNAVAILABLE':
      case 'RATE_LIMITED':
      case 'MALFORMED_RESPONSE':
        return error.code;
      default:
        return 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

function mapHeartbeatFailure(error: unknown): HeartbeatFailureErrorCode {
  if (error instanceof BranchDeviceApiError) {
    switch (error.code) {
      case 'DEVICE_NOT_ACTIVE':
      case 'DEVICE_DISABLED':
      case 'DEVICE_DENIED':
      case 'DEVICE_REVOKED':
      case 'SESSION_TOKEN_MISSING':
      case 'SESSION_TOKEN_INVALID':
      case 'SESSION_EXPIRED':
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
      case 'API_UNAVAILABLE':
      case 'HEARTBEAT_FAILED':
      case 'RATE_LIMITED':
      case 'MALFORMED_RESPONSE':
        return error.code;
      default:
        return 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

function mapSessionRefreshFailure(error: unknown): SessionRefreshFailureErrorCode {
  if (error instanceof SessionRefreshLifecycleError) {
    return error.code;
  }
  if (error instanceof BranchDeviceSessionChallengeValidationError) {
    return error.code;
  }
  if (error instanceof BranchDeviceApiError) {
    switch (error.code) {
      case 'DEVICE_NOT_ACTIVE':
      case 'DEVICE_DISABLED':
      case 'DEVICE_DENIED':
      case 'DEVICE_REVOKED':
      case 'SESSION_CHALLENGE_INVALID':
      case 'SESSION_SIGNATURE_INVALID':
      case 'SESSION_CHALLENGE_FAILED':
      case 'SESSION_ISSUE_FAILED':
      case 'SESSION_TOKEN_MISSING':
      case 'SESSION_TOKEN_INVALID':
      case 'SESSION_EXPIRED':
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
      case 'API_UNAVAILABLE':
      case 'RATE_LIMITED':
      case 'MALFORMED_RESPONSE':
        return error.code;
      default:
        return 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

function pendingDeviceFromState(): PendingDeviceRegistrationState | null {
  if (!state.deviceId || !state.safeHidPrefix || !state.claimedAt) return null;
  const pendingDevice: PendingDeviceRegistrationState = {
    deviceId: state.deviceId,
    serverStatus: state.serverStatus ?? 'PENDING_ACTIVATION',
    branch: state.branch ?? null,
    allowedCapabilities: [...state.capabilities],
    safeHidPrefix: state.safeHidPrefix,
    claimedAt: state.claimedAt,
  };
  if (state.deviceLabel !== undefined) {
    pendingDevice.deviceLabel = state.deviceLabel;
  }
  return pendingDevice;
}

function createResetRequiredState(message: string): AgentState {
  return {
    status: 'RESET_REQUIRED',
    mode: 'SETUP',
    capabilities: [],
    message,
    updatedAt: new Date().toISOString(),
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'Jade Device Agent',
    backgroundColor: '#061B16',
    webPreferences: {
      // Sandboxed preloads must be CommonJS — the source is preload.cts
      // so tsc (NodeNext) emits preload.cjs. An ESM preload.js here
      // fails to load under sandbox:true, which silently removes the
      // window.jadeAgent bridge.
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // A failed preload silently removes the window.jadeAgent bridge and
  // freezes the UI — surface it loudly. Error message only; never
  // secrets.
  mainWindow.webContents.on('preload-error', (_event, _preloadPath, error) => {
    console.error(`[claim-trace] PRELOAD_ERROR ${error.message}`);
  });

  const baseUrlForLog = resolveApiBaseUrl();
  if (baseUrlForLog) {
    const parsed = new URL(baseUrlForLog);
    console.info(`[claim-trace] API_BASE ${parsed.protocol}//${parsed.host}`);
  } else {
    console.error('[claim-trace] API_BASE invalid or unset');
  }

  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData');
  storage = new DevFileDeviceStorage(
    join(userDataPath, 'dev-device-identity.json'),
    join(userDataPath, 'dev-device-pending.json'),
  );
  const [existing, pendingDevice] = await Promise.all([
    storage.readIdentity(),
    storage.readPendingDevice(),
  ]);
  state = pendingDevice && !existing
    ? createResetRequiredState('Pending device state exists without local identity. Reset is required.')
    : createInitialAgentStateFromPending(pendingDevice, Boolean(existing));

  proxy = await startAgentProxy({
    port: Number(process.env.JADE_AGENT_PROXY_PORT || DEFAULT_PROXY_PORT),
    getHealth,
    getDeviceStatus: () => toRegistrationSnapshot(state),
    safeLog: (event) => {
      if (process.env.NODE_ENV === 'production') return;
      // Safe metadata only: method/path/status. No bodies, tokens, keys, or setup codes.
      console.info('[agent-proxy]', event);
    },
  });

  createWindow();
  if (state.status === 'PENDING_ACTIVATION') {
    startActivationPolling(ACTIVATION_POLL_INITIAL_DELAY_MS);
  }
}

ipcMain.handle('agent:getSnapshot', () => getSnapshot());

ipcMain.handle('agent:claimSetupCode', async (_event, setupCode: unknown, deviceLabel: unknown) => {
  // Safe claim trace — event markers only; never the setup code, keys,
  // fingerprints, or request/response bodies.
  console.info('[claim-trace] IPC_RECEIVED');
  stopActivationPolling();
  stopHeartbeatLifecycle();
  const rawSetupCode = typeof setupCode === 'string' ? setupCode.trim() : '';
  if (!rawSetupCode) {
    state = failSetupCodeClaim(state, 'SETUP_CODE_REQUIRED');
    return getSnapshot();
  }
  const apiBaseUrl = resolveApiBaseUrl();
  if (!apiBaseUrl) {
    state = failSetupCodeClaim(state, 'CONFIG_INVALID');
    return getSnapshot();
  }

  state = startSetupCodeClaim(state);
  try {
    const identity = await ensureLocalIdentity();
    const safeDeviceLabel = safeOptionalString(deviceLabel, 80);
    const localIp = resolveLocalIpForClaim();
    console.info(
      `[claim-trace] CLAIM_API_CALL_START target=${new URL(apiBaseUrl).protocol}//${new URL(apiBaseUrl).host}`,
    );
    const claim = await claimBranchDeviceSetupCode(
      {
        apiBaseUrl,
        appVersion: APP_VERSION,
      },
      {
        setupCode: rawSetupCode,
        publicKeyPem: identity.publicKeyPem,
        hardwareFingerprintHash: identity.hardwareFingerprintHash,
        safeHidPrefix: identity.safeHidPrefix,
        os: `${platform()} ${release()}`,
        appVersion: APP_VERSION,
        ...(localIp !== undefined ? { localIp } : {}),
        ...(safeDeviceLabel !== undefined ? { deviceLabel: safeDeviceLabel } : {}),
      },
    );
    const pendingDevice: PendingDeviceRegistrationState = {
      deviceId: claim.deviceId,
      serverStatus: claim.status,
      branch: claim.branch,
      allowedCapabilities: [...claim.allowedCapabilities],
      safeHidPrefix: identity.safeHidPrefix,
      ...(safeDeviceLabel !== undefined ? { deviceLabel: safeDeviceLabel } : {}),
      claimedAt: new Date().toISOString(),
    };
    await storage?.writePendingDevice(pendingDevice);
    state = createPendingActivationState(
      pendingDevice,
      "Waiting for admin activation. We'll continue checking automatically.",
    );
    startActivationPolling(ACTIVATION_POLL_INITIAL_DELAY_MS);
    console.info('[claim-trace] CLAIM_API_CALL_DONE status=PENDING_ACTIVATION');
  } catch (error) {
    const failureCode = mapClaimFailure(error);
    console.info(`[claim-trace] CLAIM_API_CALL_ERROR code=${failureCode}`);
    state = failSetupCodeClaim(state, failureCode);
  }
  return getSnapshot();
});

ipcMain.handle('agent:checkActivation', async () => {
  await runActivationCheck('manual');
  return getSnapshot();
});

ipcMain.handle('agent:mockActivate', () => {
  if (!MOCK_FLOW_ENABLED) return getSnapshot();
  stopActivationPolling();
  stopHeartbeatLifecycle();
  state = mockActivateDevice(state, DEFAULT_MOCK_CAPABILITIES);
  return getSnapshot();
});

ipcMain.handle('agent:disable', () => {
  if (!MOCK_FLOW_ENABLED) return getSnapshot();
  stopActivationPolling();
  stopHeartbeatLifecycle();
  state = disableDevice(state, 'DEV ONLY: device disabled locally.');
  return getSnapshot();
});

ipcMain.handle('agent:getHardwareStatus', async () => ({
  printer: await printerAdapter.getStatus(),
  nfc: await nfcAdapter.getStatus(),
  scanner: await scannerAdapter.getStatus(),
}));

ipcMain.handle('agent:validateScannerInput', async (_event, input: unknown) =>
  scannerAdapter.validateInput(input));

app.whenReady().then(() => {
  void bootstrap();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  stopActivationPolling();
  stopHeartbeatLifecycle();
  if (!proxy) return;
  event.preventDefault();
  const currentProxy = proxy;
  proxy = null;
  currentProxy
    .close()
    .catch(() => undefined)
    .finally(() => app.exit(0));
});
