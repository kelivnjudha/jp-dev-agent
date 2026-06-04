import type {
  BranchDeviceBranchSummary,
  BranchDeviceHeartbeatRequest,
  BranchDeviceHeartbeatResponse,
  BranchDeviceSessionChallengeResponse,
  BranchDeviceSessionIssueRequest,
  BranchDeviceSessionIssueResponse,
  BranchDeviceSessionSummary,
  BranchDeviceSetupCodeClaimApiRequest,
  BranchDeviceSetupCodeClaimInput,
  BranchDeviceSetupCodeClaimResponse,
  BranchDeviceSetupCodeStatus,
  BranchDeviceStatus,
  BranchDeviceStatusValue,
  BranchDeviceSummary,
  BranchDeviceType,
  DeviceCapability,
} from '@jade-dev-agent/protocol';
import {
  BRANCH_DEVICE_SETUP_CODE_STATUSES,
  BRANCH_DEVICE_STATUSES,
  DEVICE_CAPABILITIES,
  DEVICE_TYPES,
} from '@jade-dev-agent/protocol';

export const BRANCH_DEVICE_API_ENDPOINTS = {
  claim: '/api/v1/branch-devices/claim',
  sessionChallenge: '/api/v1/branch-devices/session/challenge',
  session: '/api/v1/branch-devices/session',
  heartbeat: '/api/v1/branch-devices/heartbeat',
} as const;

export type BranchDeviceApiEndpointName =
  keyof typeof BRANCH_DEVICE_API_ENDPOINTS;

export const BRANCH_DEVICE_API_ERROR_CODES = [
  'API_UNAVAILABLE',
  'MALFORMED_RESPONSE',
  'SETUP_CODE_INVALID',
  'SETUP_CODE_EXPIRED',
  'SETUP_CODE_REVOKED',
  'SETUP_CODE_USED',
  'DEVICE_NOT_ACTIVE',
  'DEVICE_DISABLED',
  'DEVICE_DENIED',
  'DEVICE_REVOKED',
  'SESSION_CHALLENGE_INVALID',
  'SESSION_SIGNATURE_INVALID',
  'SESSION_CHALLENGE_FAILED',
  'SESSION_ISSUE_FAILED',
  'HEARTBEAT_FAILED',
  'SESSION_TOKEN_MISSING',
  'SESSION_TOKEN_INVALID',
  'SESSION_EXPIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'UNKNOWN',
] as const;

export type BranchDeviceApiErrorCode =
  (typeof BRANCH_DEVICE_API_ERROR_CODES)[number];

export interface SafeAgentApiLogEvent {
  level: 'debug' | 'warn' | 'error';
  event: 'request' | 'response' | 'failure';
  endpoint: BranchDeviceApiEndpointName;
  status?: number;
  code?: BranchDeviceApiErrorCode;
  apiCode?: string;
}

export type SafeAgentApiLogger = (event: SafeAgentApiLogEvent) => void;

export interface BranchDeviceApiClientConfig {
  apiBaseUrl: string;
  timeoutMs?: number;
  appVersion?: string;
  logger?: SafeAgentApiLogger;
  fetchImpl?: typeof fetch;
}

interface RequestOptions<T> {
  endpoint: BranchDeviceApiEndpointName;
  body: unknown;
  validate: (value: unknown) => T;
  authToken?: string;
}

interface ApiErrorOptions {
  httpStatus?: number;
  endpoint?: BranchDeviceApiEndpointName;
  apiCode?: string;
}

const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SAFE_API_CODE_PATTERN = /^[A-Z0-9_]{1,96}$/;
const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
} as const;

const API_ERROR_MESSAGES: Record<BranchDeviceApiErrorCode, string> = {
  API_UNAVAILABLE: 'Branch device API is unavailable.',
  MALFORMED_RESPONSE: 'Branch device API returned an invalid response.',
  SETUP_CODE_INVALID: 'Setup code is invalid.',
  SETUP_CODE_EXPIRED: 'Setup code has expired.',
  SETUP_CODE_REVOKED: 'Setup code has been revoked.',
  SETUP_CODE_USED: 'Setup code has already been used.',
  DEVICE_NOT_ACTIVE: 'Device is not active.',
  DEVICE_DISABLED: 'Device is disabled.',
  DEVICE_DENIED: 'Device was denied.',
  DEVICE_REVOKED: 'Device was revoked.',
  SESSION_CHALLENGE_INVALID: 'Device session challenge is invalid.',
  SESSION_SIGNATURE_INVALID: 'Device session signature is invalid.',
  SESSION_CHALLENGE_FAILED: 'Device session challenge failed.',
  SESSION_ISSUE_FAILED: 'Device session issue failed.',
  HEARTBEAT_FAILED: 'Device heartbeat failed.',
  SESSION_TOKEN_MISSING: 'Device session token is missing.',
  SESSION_TOKEN_INVALID: 'Device session token is invalid.',
  SESSION_EXPIRED: 'Device session expired.',
  UNAUTHORIZED: 'Device API request is unauthorized.',
  FORBIDDEN: 'Device API request is forbidden.',
  RATE_LIMITED: 'Device API request was rate limited.',
  UNKNOWN: 'Branch device API request failed.',
};

export class BranchDeviceApiError extends Error {
  readonly code: BranchDeviceApiErrorCode;
  readonly httpStatus?: number;
  readonly endpoint?: BranchDeviceApiEndpointName;
  readonly apiCode?: string;

  constructor(code: BranchDeviceApiErrorCode, options: ApiErrorOptions = {}) {
    super(API_ERROR_MESSAGES[code]);
    this.name = 'BranchDeviceApiError';
    this.code = code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.endpoint !== undefined) this.endpoint = options.endpoint;
    if (options.apiCode !== undefined) this.apiCode = options.apiCode;
  }

  toJSON(): {
    name: string;
    code: BranchDeviceApiErrorCode;
    httpStatus?: number;
    endpoint?: BranchDeviceApiEndpointName;
    apiCode?: string;
  } {
    const out: {
      name: string;
      code: BranchDeviceApiErrorCode;
      httpStatus?: number;
      endpoint?: BranchDeviceApiEndpointName;
      apiCode?: string;
    } = {
      name: this.name,
      code: this.code,
    };
    if (this.httpStatus !== undefined) out.httpStatus = this.httpStatus;
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    if (this.apiCode !== undefined) out.apiCode = this.apiCode;
    return out;
  }
}

export function toBranchDeviceClaimApiRequest(
  payload: BranchDeviceSetupCodeClaimInput,
): BranchDeviceSetupCodeClaimApiRequest {
  const request: BranchDeviceSetupCodeClaimApiRequest = {
    setupCode: payload.setupCode,
    publicKey: payload.publicKeyPem,
    hardwareFingerprintHash: payload.hardwareFingerprintHash,
    safeHidPrefix: payload.safeHidPrefix,
    os: payload.os,
    appVersion: payload.appVersion,
  };
  if (payload.localIp !== undefined) request.localIp = payload.localIp;
  if (payload.deviceLabel !== undefined) request.deviceLabel = payload.deviceLabel;
  return request;
}

export function redactHeadersForLog(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = key.toLowerCase() === 'authorization' ? '[REDACTED]' : value;
  }
  return out;
}

export function getBranchDeviceApiEndpointUrl(
  config: Pick<BranchDeviceApiClientConfig, 'apiBaseUrl'>,
  endpoint: BranchDeviceApiEndpointName,
): string {
  const path = BRANCH_DEVICE_API_ENDPOINTS[endpoint];
  if (!path.startsWith('/api/v1/branch-devices/') || path.includes('..')) {
    throw new BranchDeviceApiError('UNKNOWN', { endpoint });
  }
  let base: URL;
  try {
    base = new URL(config.apiBaseUrl);
  } catch {
    throw new BranchDeviceApiError('UNKNOWN', { endpoint });
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new BranchDeviceApiError('UNKNOWN', { endpoint });
  }
  return new URL(path, `${base.protocol}//${base.host}`).toString();
}

export async function claimBranchDeviceSetupCode(
  config: BranchDeviceApiClientConfig,
  payload: BranchDeviceSetupCodeClaimInput,
): Promise<BranchDeviceSetupCodeClaimResponse> {
  return requestJson(config, {
    endpoint: 'claim',
    body: toBranchDeviceClaimApiRequest(payload),
    validate: validateClaimResponse,
  });
}

export async function requestBranchDeviceSessionChallenge(
  config: BranchDeviceApiClientConfig,
  deviceId: string,
): Promise<BranchDeviceSessionChallengeResponse> {
  return requestJson(config, {
    endpoint: 'sessionChallenge',
    body: { deviceId },
    validate: validateChallengeResponse,
  });
}

export async function issueBranchDeviceSession(
  config: BranchDeviceApiClientConfig,
  payload: BranchDeviceSessionIssueRequest,
): Promise<BranchDeviceSessionIssueResponse> {
  return requestJson(config, {
    endpoint: 'session',
    body: {
      deviceId: payload.deviceId,
      challenge: payload.challenge,
      signature: payload.signature,
      timestamp: payload.timestamp,
    },
    validate: validateSessionIssueResponse,
  });
}

export async function sendBranchDeviceHeartbeat(
  config: BranchDeviceApiClientConfig,
  sessionToken: string,
  payload: BranchDeviceHeartbeatRequest = {},
): Promise<BranchDeviceHeartbeatResponse> {
  return requestJson(config, {
    endpoint: 'heartbeat',
    body: buildHeartbeatBody(config, payload),
    authToken: sessionToken,
    validate: validateHeartbeatResponse,
  });
}

async function requestJson<T>(
  config: BranchDeviceApiClientConfig,
  options: RequestOptions<T>,
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new BranchDeviceApiError('API_UNAVAILABLE', {
      endpoint: options.endpoint,
    });
  }
  const url = getBranchDeviceApiEndpointUrl(config, options.endpoint);
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (options.authToken !== undefined) {
    headers.authorization = `Bearer ${options.authToken}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  config.logger?.({
    level: 'debug',
    event: 'request',
    endpoint: options.endpoint,
  });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch {
    config.logger?.({
      level: 'error',
      event: 'failure',
      endpoint: options.endpoint,
      code: 'API_UNAVAILABLE',
    });
    throw new BranchDeviceApiError('API_UNAVAILABLE', {
      endpoint: options.endpoint,
    });
  } finally {
    clearTimeout(timeout);
  }

  const rawBody = await readJsonBodySafely(response);
  if (!response.ok) {
    const apiCode = extractApiCode(rawBody);
    const failureInput: {
      endpoint: BranchDeviceApiEndpointName;
      httpStatus: number;
      apiCode?: string;
    } = {
      endpoint: options.endpoint,
      httpStatus: response.status,
    };
    if (apiCode !== undefined) failureInput.apiCode = apiCode;
    const code = mapHttpFailure(failureInput);
    const logEvent: SafeAgentApiLogEvent = {
      level: 'warn',
      event: 'failure',
      endpoint: options.endpoint,
      status: response.status,
      code,
    };
    if (apiCode !== undefined) logEvent.apiCode = apiCode;
    config.logger?.(logEvent);
    const errorOptions: ApiErrorOptions = {
      httpStatus: response.status,
      endpoint: options.endpoint,
    };
    if (apiCode !== undefined) errorOptions.apiCode = apiCode;
    throw new BranchDeviceApiError(code, errorOptions);
  }

  try {
    const parsed = options.validate(rawBody);
    config.logger?.({
      level: 'debug',
      event: 'response',
      endpoint: options.endpoint,
      status: response.status,
    });
    return parsed;
  } catch {
    config.logger?.({
      level: 'error',
      event: 'failure',
      endpoint: options.endpoint,
      status: response.status,
      code: 'MALFORMED_RESPONSE',
    });
    throw new BranchDeviceApiError('MALFORMED_RESPONSE', {
      httpStatus: response.status,
      endpoint: options.endpoint,
    });
  }
}

function buildHeartbeatBody(
  config: BranchDeviceApiClientConfig,
  payload: BranchDeviceHeartbeatRequest,
): BranchDeviceHeartbeatRequest {
  const body: BranchDeviceHeartbeatRequest = {};
  const appVersion = payload.appVersion ?? config.appVersion;
  if (appVersion !== undefined) body.appVersion = appVersion;
  if (payload.localIp !== undefined) body.localIp = payload.localIp;
  return body;
}

async function readJsonBodySafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new BranchDeviceApiError('MALFORMED_RESPONSE');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return null;
    throw new BranchDeviceApiError('MALFORMED_RESPONSE');
  }
}

function mapHttpFailure({
  endpoint,
  httpStatus,
  apiCode,
}: {
  endpoint: BranchDeviceApiEndpointName;
  httpStatus: number;
  apiCode?: string;
}): BranchDeviceApiErrorCode {
  if (httpStatus === 429) return 'RATE_LIMITED';
  if (apiCode) {
    const mapped = mapApiCode(apiCode);
    if (mapped) return mapped;
  }
  if (httpStatus === 401) return 'UNAUTHORIZED';
  if (httpStatus === 403) return 'FORBIDDEN';
  if (endpoint === 'claim') return 'SETUP_CODE_INVALID';
  if (endpoint === 'sessionChallenge') return 'SESSION_CHALLENGE_FAILED';
  if (endpoint === 'session') return 'SESSION_ISSUE_FAILED';
  if (endpoint === 'heartbeat') return 'HEARTBEAT_FAILED';
  return 'UNKNOWN';
}

function mapApiCode(apiCode: string): BranchDeviceApiErrorCode | null {
  switch (apiCode) {
    case 'BRANCH_DEVICE_SETUP_CODE_INVALID':
    case 'BRANCH_DEVICE_SETUP_CODE_NOT_ACTIVE':
    case 'BRANCH_DEVICE_SETUP_CODE_ACTIVATION_INVALID':
      return 'SETUP_CODE_INVALID';
    case 'SETUP_CODE_ALREADY_USED_REVOKE_DEVICE_INSTEAD':
      return 'SETUP_CODE_USED';
    case 'BRANCH_DEVICE_NOT_ACTIVE':
      return 'DEVICE_NOT_ACTIVE';
    case 'BRANCH_DEVICE_NOT_DISABLED':
      return 'DEVICE_DISABLED';
    case 'BRANCH_DEVICE_DISABLED':
      return 'DEVICE_DISABLED';
    case 'BRANCH_DEVICE_DENIED':
      return 'DEVICE_DENIED';
    case 'BRANCH_DEVICE_REVOKED':
      return 'DEVICE_REVOKED';
    case 'BRANCH_DEVICE_SESSION_CHALLENGE_INVALID':
      return 'SESSION_CHALLENGE_INVALID';
    case 'BRANCH_DEVICE_SESSION_SIGNATURE_INVALID':
      return 'SESSION_SIGNATURE_INVALID';
    case 'BRANCH_DEVICE_SESSION_TOKEN_MISSING':
      return 'SESSION_TOKEN_MISSING';
    case 'BRANCH_DEVICE_SESSION_TOKEN_INVALID':
      return 'SESSION_TOKEN_INVALID';
    case 'BRANCH_DEVICE_SESSION_EXPIRED':
      return 'SESSION_EXPIRED';
    case 'UNAUTHORIZED':
      return 'UNAUTHORIZED';
    case 'BRANCH_DEVICE_ACTOR_FORBIDDEN':
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    default:
      return null;
  }
}

function extractApiCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code ?? value.errorCode;
  if (typeof code === 'string' && SAFE_API_CODE_PATTERN.test(code.trim())) {
    return code.trim();
  }
  const error = value.error;
  if (
    isRecord(error)
    && typeof error.code === 'string'
    && SAFE_API_CODE_PATTERN.test(error.code.trim())
  ) {
    return error.code.trim();
  }
  return undefined;
}

function validateClaimResponse(value: unknown): BranchDeviceSetupCodeClaimResponse {
  const object = expectRecord(value);
  return {
    deviceId: expectString(object.deviceId),
    status: expectStatusValue(object.status),
    branch: validateBranchSummary(object.branch),
    allowedCapabilities: validateCapabilities(object.allowedCapabilities),
    message: expectString(object.message),
  };
}

function validateChallengeResponse(value: unknown): BranchDeviceSessionChallengeResponse {
  const object = expectRecord(value);
  return {
    challenge: expectString(object.challenge),
    timestamp: expectString(object.timestamp),
    expiresAt: expectString(object.expiresAt),
    signingPayload: expectString(object.signingPayload),
  };
}

function validateSessionIssueResponse(value: unknown): BranchDeviceSessionIssueResponse {
  const object = expectRecord(value);
  return {
    session: validateSessionSummary(object.session),
    sessionToken: expectString(object.sessionToken),
  };
}

function validateHeartbeatResponse(value: unknown): BranchDeviceHeartbeatResponse {
  const object = expectRecord(value);
  const ok = object.ok;
  if (typeof ok !== 'boolean') throw new TypeError('ok must be boolean');
  return {
    ok,
    device: validateDeviceSummary(object.device),
    session: validateSessionSummary(object.session),
  };
}

function validateBranchSummary(value: unknown): BranchDeviceBranchSummary | null {
  if (value === null) return null;
  const object = expectRecord(value);
  return {
    id: expectString(object.id),
    code: expectNullableString(object.code),
    name: expectNullableString(object.name),
  };
}

function validateDeviceSummary(value: unknown): BranchDeviceSummary {
  const object = expectRecord(value);
  const deviceType = expectKnownValue(object.deviceType, DEVICE_TYPES);
  const device: BranchDeviceSummary = {
    id: expectString(object.id),
    branch: validateBranchSummary(object.branch),
    deviceType,
    capabilities: validateCapabilities(object.capabilities),
    status: expectStatusValue(object.status),
    label: expectNullableString(object.label),
    safeHidPrefix: expectNullableString(object.safeHidPrefix),
    os: expectNullableString(object.os),
    appVersion: expectNullableString(object.appVersion),
    localIp: expectNullableString(object.localIp),
    lastSeenAt: expectNullableString(object.lastSeenAt),
  };

  if ('setupCode' in object) {
    device.setupCode = validateSetupCodeSummary(object.setupCode);
  }
  for (const key of [
    'approvedAt',
    'deniedAt',
    'disabledAt',
    'revokedAt',
    'createdAt',
    'updatedAt',
  ] as const) {
    if (key in object) device[key] = expectNullableString(object[key]);
  }
  return device;
}

function validateSetupCodeSummary(
  value: unknown,
): {
  id: string;
  codePrefix: string | null;
  status: BranchDeviceSetupCodeStatus | (string & {});
} | null {
  if (value === null) return null;
  const object = expectRecord(value);
  return {
    id: expectString(object.id),
    codePrefix: expectNullableString(object.codePrefix),
    status: expectSetupCodeStatusValue(object.status),
  };
}

function validateSessionSummary(value: unknown): BranchDeviceSessionSummary {
  const object = expectRecord(value);
  const session: BranchDeviceSessionSummary = {
    status: expectString(object.status),
  };
  for (const key of ['issuedAt', 'expiresAt', 'lastSeenAt'] as const) {
    if (key in object) session[key] = expectNullableString(object[key]);
  }
  return session;
}

function validateCapabilities(value: unknown): DeviceCapability[] {
  if (!Array.isArray(value)) throw new TypeError('capabilities must be array');
  return value.map((entry) => expectKnownValue(entry, DEVICE_CAPABILITIES));
}

function expectStatusValue(value: unknown): BranchDeviceStatusValue {
  const status = expectString(value);
  if (BRANCH_DEVICE_STATUSES.includes(status as BranchDeviceStatus)) {
    return status as BranchDeviceStatusValue;
  }
  return status as BranchDeviceStatusValue;
}

function expectSetupCodeStatusValue(
  value: unknown,
): BranchDeviceSetupCodeStatus | (string & {}) {
  const status = expectString(value);
  if (BRANCH_DEVICE_SETUP_CODE_STATUSES.includes(
    status as BranchDeviceSetupCodeStatus,
  )) {
    return status as BranchDeviceSetupCodeStatus;
  }
  return status as string & {};
}

function expectKnownValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  const text = expectString(value);
  if (!allowed.includes(text)) throw new TypeError('unexpected enum value');
  return text;
}

function expectString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('expected non-empty string');
  }
  return value;
}

function expectNullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new TypeError('expected nullable string');
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('expected object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
