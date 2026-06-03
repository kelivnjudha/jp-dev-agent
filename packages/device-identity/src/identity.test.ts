import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeHardwareFingerprintHash,
  createSafeHidPrefix,
  generateDeviceKeyPair,
} from './index.js';

test('generateDeviceKeyPair returns PEM public/private shapes', () => {
  const pair = generateDeviceKeyPair();
  assert.match(pair.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(pair.privateKeyPem, /BEGIN PRIVATE KEY/);
});

test('computeHardwareFingerprintHash returns a sha256 hex digest', () => {
  const hash = computeHardwareFingerprintHash('test-seed');
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('createSafeHidPrefix truncates the fingerprint for display', () => {
  assert.equal(createSafeHidPrefix('abcdef1234567890'), 'ABCD-EF123456');
});
