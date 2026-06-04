import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import test from 'node:test';

import {
  computeHardwareFingerprintHash,
  createSafeHidPrefix,
  generateDeviceKeyPair,
  signDeviceSessionPayload,
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

test('signDeviceSessionPayload returns a base64url Ed25519 signature', () => {
  const pair = generateDeviceKeyPair();
  const payload = 'JP_BRANCH_DEVICE_SESSION_V1\ndevice\nchallenge\ntimestamp';
  const signature = signDeviceSessionPayload({
    privateKeyPem: pair.privateKeyPem,
    payload,
  });
  assert.match(signature, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    verify(
      null,
      Buffer.from(payload, 'utf8'),
      pair.publicKeyPem,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});
