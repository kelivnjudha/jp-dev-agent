import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRANCH_DEVICE_API_ENDPOINTS,
  BranchDeviceApiError,
  claimBranchDeviceSetupCode,
  getBranchDeviceApiEndpointUrl,
  issueBranchDeviceSession,
  redactHeadersForLog,
  requestBranchDeviceSessionChallenge,
  sendBranchDeviceHeartbeat,
  toBranchDeviceClaimApiRequest,
  type BranchDeviceApiClientConfig,
  type SafeAgentApiLogEvent,
} from './index.js';

const API_BASE_URL = 'https://api.jade-palace.test/ignored?target=https://evil.test';
const SETUP_CODE = 'JPBD-ABCDEF-GHJKLM-NPQRST';
const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAfixture=\n-----END PUBLIC KEY-----\n';
const FINGERPRINT = 'a'.repeat(64);
const SESSION_TOKEN = 'branch_device_session_v1_secret-token';
const SIGNATURE = 'secret-signature';

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function createFetchMock(
  status: number,
  body: unknown,
  calls: FetchCall[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { input };
    if (init !== undefined) call.init = init;
    calls.push(call);
    return jsonResponse(status, body);
  }) as typeof fetch;
}

function baseConfig(
  fetchImpl: typeof fetch,
  logger?: (event: SafeAgentApiLogEvent) => void,
): BranchDeviceApiClientConfig {
  const config: BranchDeviceApiClientConfig = {
    apiBaseUrl: API_BASE_URL,
    fetchImpl,
  };
  if (logger) config.logger = logger;
  return config;
}

function claimPayload() {
  return {
    setupCode: SETUP_CODE,
    publicKeyPem: PUBLIC_KEY,
    hardwareFingerprintHash: FINGERPRINT,
    safeHidPrefix: 'ABCD-12345678',
    os: 'Windows',
    appVersion: '0.1.0',
    localIp: '192.168.1.20',
    deviceLabel: 'Front counter',
  };
}

function claimResponse() {
  return {
    deviceId: 'd0000000-0000-4000-8000-000000000001',
    status: 'PENDING_ACTIVATION',
    branch: {
      id: 'b0000000-0000-4000-8000-000000000001',
      code: 'BKK',
      name: 'Bangkok',
    },
    allowedCapabilities: ['POS_TERMINAL', 'BARCODE_SCANNER'],
    message: 'Device claim received. Waiting for activation.',
  };
}

function challengeResponse() {
  return {
    challenge: 'challenge-value',
    timestamp: '2026-06-04T01:00:00.000Z',
    expiresAt: '2026-06-04T01:02:00.000Z',
    signingPayload:
      'JP_BRANCH_DEVICE_SESSION_V1\nd0000000-0000-4000-8000-000000000001\nchallenge-value\n2026-06-04T01:00:00.000Z',
  };
}

function sessionResponse() {
  return {
    session: {
      status: 'ACTIVE',
      issuedAt: '2026-06-04T01:00:00.000Z',
      expiresAt: '2026-06-04T13:00:00.000Z',
    },
    sessionToken: SESSION_TOKEN,
  };
}

function heartbeatResponse() {
  return {
    ok: true,
    device: {
      id: 'd0000000-0000-4000-8000-000000000001',
      branch: {
        id: 'b0000000-0000-4000-8000-000000000001',
        code: 'BKK',
        name: 'Bangkok',
      },
      deviceType: 'POS_TERMINAL',
      capabilities: ['POS_TERMINAL', 'BARCODE_SCANNER'],
      status: 'ACTIVE',
      label: 'Front counter',
      safeHidPrefix: 'ABCD-12345678',
      os: 'Windows',
      appVersion: '0.1.0',
      localIp: '192.168.1.20',
      lastSeenAt: '2026-06-04T01:01:00.000Z',
      setupCode: null,
      approvedAt: '2026-06-04T01:00:00.000Z',
      deniedAt: null,
      disabledAt: null,
      revokedAt: null,
      createdAt: '2026-06-04T00:55:00.000Z',
      updatedAt: '2026-06-04T01:01:00.000Z',
    },
    session: {
      status: 'ACTIVE',
      expiresAt: '2026-06-04T13:00:00.000Z',
      lastSeenAt: '2026-06-04T01:01:00.000Z',
    },
  };
}

function assertApiError(
  value: unknown,
  code: BranchDeviceApiError['code'],
): boolean {
  assert.ok(value instanceof BranchDeviceApiError);
  assert.equal(value.code, code);
  return true;
}

test('claim payload maps publicKeyPem to API publicKey and whitelists fields', () => {
  const payload = {
    ...claimPayload(),
    capabilities: ['POS_TERMINAL'],
    publicKey: 'attacker-key',
    endpointUrl: 'https://evil.test',
  };
  const mapped = toBranchDeviceClaimApiRequest(payload);
  assert.equal(mapped.publicKey, PUBLIC_KEY);
  assert.equal('publicKeyPem' in mapped, false);
  assert.equal('capabilities' in mapped, false);
  assert.equal('endpointUrl' in mapped, false);
});

test('fixed endpoints ignore base URL paths and query strings', async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = createFetchMock(202, claimResponse(), calls);
  await claimBranchDeviceSetupCode(baseConfig(fetchImpl), claimPayload());
  assert.equal(
    String(calls[0]?.input),
    'https://api.jade-palace.test/api/v1/branch-devices/claim',
  );
  assert.equal(
    getBranchDeviceApiEndpointUrl(
      { apiBaseUrl: API_BASE_URL },
      'sessionChallenge',
    ),
    'https://api.jade-palace.test/api/v1/branch-devices/session/challenge',
  );
});

test('API base URL with embedded credentials is rejected before network use', async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = createFetchMock(200, challengeResponse(), calls);
  await assert.rejects(
    requestBranchDeviceSessionChallenge(
      {
        apiBaseUrl: 'https://user:pass@api.jade-palace.test',
        fetchImpl,
      },
      'd0000000-0000-4000-8000-000000000001',
    ),
    (error) => assertApiError(error, 'UNKNOWN'),
  );
  assert.equal(calls.length, 0);
});

test('client functions use fixed Branch Device API endpoint constants', async () => {
  const calls: FetchCall[] = [];
  await claimBranchDeviceSetupCode(
    baseConfig(createFetchMock(202, claimResponse(), calls)),
    claimPayload(),
  );
  await requestBranchDeviceSessionChallenge(
    baseConfig(createFetchMock(200, challengeResponse(), calls)),
    'd0000000-0000-4000-8000-000000000001',
  );
  await issueBranchDeviceSession(
    baseConfig(createFetchMock(201, sessionResponse(), calls)),
    {
      deviceId: 'd0000000-0000-4000-8000-000000000001',
      challenge: 'challenge-value',
      signature: SIGNATURE,
      timestamp: '2026-06-04T01:00:00.000Z',
    },
  );
  await sendBranchDeviceHeartbeat(
    baseConfig(createFetchMock(200, heartbeatResponse(), calls)),
    SESSION_TOKEN,
    { appVersion: '0.1.1' },
  );

  assert.deepEqual(
    calls.map((call) => new URL(String(call.input)).pathname),
    [
      BRANCH_DEVICE_API_ENDPOINTS.claim,
      BRANCH_DEVICE_API_ENDPOINTS.sessionChallenge,
      BRANCH_DEVICE_API_ENDPOINTS.session,
      BRANCH_DEVICE_API_ENDPOINTS.heartbeat,
    ],
  );
});

test('safe logger does not receive setup code, public key, fingerprint, signature, or token', async () => {
  const events: SafeAgentApiLogEvent[] = [];
  await claimBranchDeviceSetupCode(
    baseConfig(createFetchMock(202, claimResponse()), (event) => events.push(event)),
    claimPayload(),
  );
  await issueBranchDeviceSession(
    baseConfig(createFetchMock(201, sessionResponse()), (event) => events.push(event)),
    {
      deviceId: 'd0000000-0000-4000-8000-000000000001',
      challenge: 'challenge-value',
      signature: SIGNATURE,
      timestamp: '2026-06-04T01:00:00.000Z',
    },
  );
  await sendBranchDeviceHeartbeat(
    baseConfig(createFetchMock(200, heartbeatResponse()), (event) => events.push(event)),
    SESSION_TOKEN,
  );

  const text = JSON.stringify(events);
  assert.equal(text.includes(SETUP_CODE), false);
  assert.equal(text.includes(PUBLIC_KEY), false);
  assert.equal(text.includes(FINGERPRINT), false);
  assert.equal(text.includes(SIGNATURE), false);
  assert.equal(text.includes(SESSION_TOKEN), false);
});

test('Authorization header is redacted for any log helper usage', () => {
  assert.deepEqual(
    redactHeadersForLog({
      authorization: `Bearer ${SESSION_TOKEN}`,
      accept: 'application/json',
    }),
    {
      authorization: '[REDACTED]',
      accept: 'application/json',
    },
  );
});

test('malformed successful responses fail closed', async () => {
  await assert.rejects(
    claimBranchDeviceSetupCode(baseConfig(createFetchMock(202, { status: 'ACTIVE' })), claimPayload()),
    (error) => assertApiError(error, 'MALFORMED_RESPONSE'),
  );
  await assert.rejects(
    requestBranchDeviceSessionChallenge(
      baseConfig(createFetchMock(200, { challenge: 'missing fields' })),
      'd0000000-0000-4000-8000-000000000001',
    ),
    (error) => assertApiError(error, 'MALFORMED_RESPONSE'),
  );
  await assert.rejects(
    issueBranchDeviceSession(
      baseConfig(createFetchMock(201, { session: { status: 'ACTIVE' } })),
      {
        deviceId: 'd0000000-0000-4000-8000-000000000001',
        challenge: 'challenge-value',
        signature: SIGNATURE,
        timestamp: '2026-06-04T01:00:00.000Z',
      },
    ),
    (error) => assertApiError(error, 'MALFORMED_RESPONSE'),
  );
  await assert.rejects(
    sendBranchDeviceHeartbeat(
      baseConfig(createFetchMock(200, { ok: true })),
      SESSION_TOKEN,
    ),
    (error) => assertApiError(error, 'MALFORMED_RESPONSE'),
  );
});

test('API error mapping is safe and does not serialize secret response fragments', async () => {
  await assert.rejects(
    issueBranchDeviceSession(
      baseConfig(createFetchMock(403, {
        code: 'BRANCH_DEVICE_SESSION_SIGNATURE_INVALID',
        sessionToken: SESSION_TOKEN,
        signature: SIGNATURE,
      })),
      {
        deviceId: 'd0000000-0000-4000-8000-000000000001',
        challenge: 'challenge-value',
        signature: SIGNATURE,
        timestamp: '2026-06-04T01:00:00.000Z',
      },
    ),
    (error) => {
      assertApiError(error, 'SESSION_SIGNATURE_INVALID');
      assert.equal(String(error).includes(SESSION_TOKEN), false);
      assert.equal(JSON.stringify(error).includes(SESSION_TOKEN), false);
      assert.equal(JSON.stringify(error).includes(SIGNATURE), false);
      return true;
    },
  );
});

test('unsafe API error code strings are not copied into logs or thrown errors', async () => {
  const events: SafeAgentApiLogEvent[] = [];
  await assert.rejects(
    issueBranchDeviceSession(
      baseConfig(createFetchMock(403, {
        code: `BRANCH_DEVICE_${SESSION_TOKEN}`,
      }), (event) => events.push(event)),
      {
        deviceId: 'd0000000-0000-4000-8000-000000000001',
        challenge: 'challenge-value',
        signature: SIGNATURE,
        timestamp: '2026-06-04T01:00:00.000Z',
      },
    ),
    (error) => {
      assertApiError(error, 'FORBIDDEN');
      assert.equal(JSON.stringify(error).includes(SESSION_TOKEN), false);
      return true;
    },
  );
  assert.equal(JSON.stringify(events).includes(SESSION_TOKEN), false);
});

test('session challenge and token API errors map to explicit safe codes', async () => {
  await assert.rejects(
    requestBranchDeviceSessionChallenge(
      baseConfig(createFetchMock(409, {
        code: 'BRANCH_DEVICE_NOT_ACTIVE',
      })),
      'd0000000-0000-4000-8000-000000000001',
    ),
    (error) => assertApiError(error, 'DEVICE_NOT_ACTIVE'),
  );

  await assert.rejects(
    requestBranchDeviceSessionChallenge(
      baseConfig(createFetchMock(403, {
        code: 'BRANCH_DEVICE_DISABLED',
      })),
      'd0000000-0000-4000-8000-000000000001',
    ),
    (error) => assertApiError(error, 'DEVICE_DISABLED'),
  );

  await assert.rejects(
    sendBranchDeviceHeartbeat(
      baseConfig(createFetchMock(401, {
        code: 'BRANCH_DEVICE_SESSION_EXPIRED',
      })),
      SESSION_TOKEN,
    ),
    (error) => assertApiError(error, 'SESSION_EXPIRED'),
  );
});

test('session token is returned only by successful session issue result', async () => {
  const result = await issueBranchDeviceSession(
    baseConfig(createFetchMock(201, sessionResponse())),
    {
      deviceId: 'd0000000-0000-4000-8000-000000000001',
      challenge: 'challenge-value',
      signature: SIGNATURE,
      timestamp: '2026-06-04T01:00:00.000Z',
    },
  );
  assert.equal(result.sessionToken, SESSION_TOKEN);
});
