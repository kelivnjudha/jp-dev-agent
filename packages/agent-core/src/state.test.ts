import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialAgentStateFromPending,
  createPendingActivationState,
  createInitialAgentState,
  disableDevice,
  failSetupCodeClaim,
  maskSetupCode,
  mockActivateDevice,
  mockSubmitSetupCodeForPendingActivation,
  safeSetupCodeClaimErrorMessage,
  startSetupCodeClaim,
} from './index.js';

test('maskSetupCode keeps only a safe prefix', () => {
  assert.equal(maskSetupCode('JPDA-1234-SECRET'), 'JPDA••••');
});

test('real claim state does not retain setup-code-derived values', () => {
  const initial = createInitialAgentState(false);
  assert.equal(initial.status, 'UNREGISTERED');
  const submitting = startSetupCodeClaim(initial);
  assert.equal(submitting.status, 'SETUP_CODE_SUBMITTING');
  assert.equal(JSON.stringify(submitting).includes('JPDA'), false);
});

test('successful real claim stores safe pending activation details only', () => {
  const pending = createPendingActivationState({
    deviceId: 'd0000000-0000-4000-8000-000000000001',
    serverStatus: 'PENDING_ACTIVATION',
    branch: { id: 'b0000000-0000-4000-8000-000000000001', code: 'BKK', name: 'Bangkok' },
    allowedCapabilities: ['POS_TERMINAL', 'BARCODE_SCANNER'],
    safeHidPrefix: 'ABCD-12345678',
    deviceLabel: 'Front counter',
    claimedAt: '2026-06-04T01:00:00.000Z',
  });
  assert.equal(pending.status, 'PENDING_ACTIVATION');
  assert.equal(pending.safeHidPrefix, 'ABCD-12345678');
  assert.equal(JSON.stringify(pending).includes('JPBD-'), false);
  assert.equal(JSON.stringify(pending).includes('publicKeyPem'), false);
  assert.equal(JSON.stringify(pending).includes('privateKeyPem'), false);
  assert.equal(JSON.stringify(pending).includes('hardwareFingerprintHash'), false);
});

test('initial state restores safe pending activation when present', () => {
  const restored = createInitialAgentStateFromPending(
    {
      deviceId: 'd0000000-0000-4000-8000-000000000001',
      serverStatus: 'PENDING_ACTIVATION',
      branch: null,
      allowedCapabilities: ['SHOP_CHECKPOINT'],
      safeHidPrefix: 'ABCD-12345678',
      claimedAt: '2026-06-04T01:00:00.000Z',
    },
    true,
  );
  assert.equal(restored.status, 'PENDING_ACTIVATION');
  assert.deepEqual(restored.capabilities, ['SHOP_CHECKPOINT']);
});

test('safe claim errors never include raw setup code or API bodies', () => {
  const failed = failSetupCodeClaim(
    createInitialAgentState(false),
    'SETUP_CODE_INVALID',
  );
  assert.equal(
    failed.message,
    'This setup code cannot be used. Ask an admin for a new setup code.',
  );
  assert.equal(safeSetupCodeClaimErrorMessage('MALFORMED_RESPONSE').includes('JPBD'), false);
});

test('mock activation only works from pending state', () => {
  const initial = createInitialAgentState(false);
  const bad = mockActivateDevice(initial);
  assert.equal(bad.status, 'ERROR');

  const pending = mockSubmitSetupCodeForPendingActivation(initial, 'JPDA-1234');
  const active = mockActivateDevice(pending, ['POS_TERMINAL', 'BARCODE_SCANNER']);
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.mode, 'POS');
});

test('disableDevice moves to disabled without dropping safe details', () => {
  const pending = mockSubmitSetupCodeForPendingActivation(
    createInitialAgentState(false),
    'JPDA-1234',
  );
  const disabled = disableDevice(pending, 'Mock disabled');
  assert.equal(disabled.status, 'DISABLED');
  assert.equal(disabled.safeHidPrefix, 'DEV-MOCK');
});
