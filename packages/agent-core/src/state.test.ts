import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialAgentState,
  disableDevice,
  maskSetupCode,
  mockActivateDevice,
  mockSubmitSetupCodeForPendingActivation,
} from './index.js';

test('maskSetupCode keeps only a safe prefix', () => {
  assert.equal(maskSetupCode('JPDA-1234-SECRET'), 'JPDA••••');
});

test('state transitions require setup code before pending activation', () => {
  const initial = createInitialAgentState(false);
  assert.equal(initial.status, 'UNREGISTERED');
  const pending = mockSubmitSetupCodeForPendingActivation(initial, 'JPDA-1234');
  assert.equal(pending.status, 'PENDING_ACTIVATION');
  assert.equal(pending.setupCodeMasked, 'JPDA••••');
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
  assert.equal(disabled.setupCodeMasked, 'JPDA••••');
});
