import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSingleFlight,
  evaluatePosDeviceProofReadiness,
  type AgentState,
} from './index.js';

const NOW_MS = Date.parse('2026-06-12T10:00:00.000Z');
const HEARTBEAT_FRESHNESS_MS = 5 * 60_000;

function readyState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    status: 'ACTIVE',
    mode: 'POS',
    capabilities: ['POS_TERMINAL', 'BARCODE_SCANNER'],
    deviceId: 'f0a4f6f9-1111-4222-8333-444455556666',
    branch: { id: 'b1d4f6f9-7777-4888-8999-aaaabbbbcccc', code: 'JP01', name: 'Main' },
    serverStatus: 'ACTIVE',
    connectionStatus: 'CONNECTED',
    sessionExpiresAt: new Date(NOW_MS + 6 * 60 * 60_000).toISOString(),
    lastHeartbeatAt: new Date(NOW_MS - 30_000).toISOString(),
    futureProxyForwardingEligible: true,
    message: 'Secure heartbeat confirmed.',
    updatedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

function evaluate(
  state: AgentState,
  options: { hasSessionToken?: boolean; sessionRefreshInFlight?: boolean } = {},
) {
  return evaluatePosDeviceProofReadiness({
    state,
    hasSessionToken: options.hasSessionToken ?? true,
    sessionRefreshInFlight: options.sessionRefreshInFlight ?? false,
    nowMs: NOW_MS,
    heartbeatFreshnessMs: HEARTBEAT_FRESHNESS_MS,
  });
}

test('active, connected, fresh-heartbeat device is proof-ready', () => {
  assert.deepEqual(evaluate(readyState()), { ready: true });
});

test('stale heartbeat is transient and requests a heartbeat wake-up', () => {
  const readiness = evaluate(
    readyState({
      lastHeartbeatAt: new Date(NOW_MS - HEARTBEAT_FRESHNESS_MS - 1_000).toISOString(),
    }),
  );
  assert.deepEqual(readiness, {
    ready: false,
    code: 'POS_DEVICE_HEARTBEAT_STALE',
    transient: true,
    wakeHeartbeat: true,
  });
});

test('missing heartbeat timestamp (first beat not yet confirmed) is transient stale', () => {
  const state = readyState();
  delete state.lastHeartbeatAt;
  const readiness = evaluate(state);
  assert.equal(readiness.ready, false);
  if (!readiness.ready) {
    assert.equal(readiness.code, 'POS_DEVICE_HEARTBEAT_STALE');
    assert.equal(readiness.transient, true);
    assert.equal(readiness.wakeHeartbeat, true);
  }
});

test('post-refresh eligibility warm-up is transient and wakes the heartbeat', () => {
  const readiness = evaluate(readyState({ futureProxyForwardingEligible: false }));
  assert.deepEqual(readiness, {
    ready: false,
    code: 'POS_DEVICE_PROOF_WARMING',
    transient: true,
    wakeHeartbeat: true,
  });
});

test('session refresh in flight is transient but must NOT inject a heartbeat', () => {
  const readiness = evaluate(readyState(), { sessionRefreshInFlight: true });
  assert.deepEqual(readiness, {
    ready: false,
    code: 'POS_DEVICE_REFRESH_IN_FLIGHT',
    transient: true,
    wakeHeartbeat: false,
  });
});

test('connecting / reconnecting states are transient without heartbeat injection', () => {
  for (const state of [
    readyState({ status: 'ACTIVE_SESSION_CONNECTING' }),
    readyState({ status: 'SESSION_EXPIRED_RETRYING' }),
    readyState({ connectionStatus: 'RECONNECTING' }),
    readyState({ connectionStatus: 'CHECKING_ACTIVATION' }),
  ]) {
    const readiness = evaluate(state);
    assert.equal(readiness.ready, false);
    if (!readiness.ready) {
      assert.equal(readiness.code, 'POS_DEVICE_NOT_CONNECTED');
      assert.equal(readiness.transient, true);
      assert.equal(readiness.wakeHeartbeat, false);
    }
  }
});

test('missing POS_TERMINAL capability is terminal and never auto-retried', () => {
  const readiness = evaluate(readyState({ capabilities: ['BARCODE_SCANNER'] }));
  assert.deepEqual(readiness, {
    ready: false,
    code: 'POS_DEVICE_CAPABILITY_MISSING',
    transient: false,
    wakeHeartbeat: false,
  });
});

test('revoked, denied, disabled, and unactivated devices stay terminally locked', () => {
  for (const state of [
    readyState({ status: 'REVOKED' }),
    readyState({ status: 'DENIED' }),
    readyState({ status: 'DISABLED' }),
    readyState({ status: 'PENDING_ACTIVATION' }),
    readyState({ status: 'RESET_REQUIRED' }),
    readyState({ serverStatus: 'REVOKED' }),
    readyState({ serverStatus: 'DISABLED' }),
  ]) {
    const readiness = evaluate(state);
    assert.equal(readiness.ready, false);
    if (!readiness.ready) {
      assert.equal(readiness.code, 'POS_DEVICE_NOT_ACTIVE');
      assert.equal(readiness.transient, false);
      assert.equal(readiness.wakeHeartbeat, false);
    }
  }
});

test('missing device session token is terminal', () => {
  const readiness = evaluate(readyState(), { hasSessionToken: false });
  assert.equal(readiness.ready, false);
  if (!readiness.ready) {
    assert.equal(readiness.code, 'POS_DEVICE_NOT_ACTIVE');
    assert.equal(readiness.transient, false);
  }
});

test('expired or malformed local session expiry is terminal for the request', () => {
  for (const state of [
    readyState({ sessionExpiresAt: new Date(NOW_MS - 1_000).toISOString() }),
    readyState({ sessionExpiresAt: 'not-a-date' }),
    readyState({ sessionExpiresAt: null }),
  ]) {
    const readiness = evaluate(state);
    assert.equal(readiness.ready, false);
    if (!readiness.ready) {
      assert.equal(readiness.code, 'POS_DEVICE_PROOF_EXPIRED');
      assert.equal(readiness.transient, false);
    }
  }
});

test('transient stale heartbeat becomes ready after a confirmed heartbeat', () => {
  // Simulates the fast path: stale → one immediate heartbeat completes
  // (fresh lastHeartbeatAt + eligibility true) → same evaluation now
  // passes, so the proof is issued within the same request.
  const stale = readyState({
    lastHeartbeatAt: new Date(NOW_MS - HEARTBEAT_FRESHNESS_MS - 1_000).toISOString(),
    futureProxyForwardingEligible: false,
  });
  const before = evaluate(stale);
  assert.equal(before.ready, false);
  const afterHeartbeat = readyState({
    lastHeartbeatAt: new Date(NOW_MS - 100).toISOString(),
    futureProxyForwardingEligible: true,
  });
  assert.deepEqual(evaluate(afterHeartbeat), { ready: true });
});

test('createSingleFlight shares one in-flight run across concurrent callers', async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const shared = createSingleFlight(async () => {
    runs += 1;
    await gate;
    return runs;
  });

  const first = shared();
  const second = shared();
  const third = shared();
  assert.equal(runs, 1, 'concurrent callers share one execution');
  release?.();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results, [1, 1, 1]);

  // After settling, the next call starts a fresh run.
  await shared();
  assert.equal(runs, 2);
});

test('createSingleFlight resets after rejection so later calls can retry', async () => {
  let attempts = 0;
  const flaky = createSingleFlight(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('TRANSIENT');
    return attempts;
  });

  await assert.rejects(flaky(), /TRANSIENT/);
  assert.equal(await flaky(), 2);
});
