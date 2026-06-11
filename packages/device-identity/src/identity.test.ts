import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import test from 'node:test';

import {
  buildPosDeviceProofSigningPayload,
  computeHardwareFingerprintHash,
  createPosDeviceProofAssertion,
  createSafeHidPrefix,
  generateDeviceKeyPair,
  POS_DEVICE_PROOF_HEADER_TYP,
  POS_DEVICE_PROOF_VERSION,
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

test('createPosDeviceProofAssertion returns compact signed proof without session token material', () => {
  const pair = generateDeviceKeyPair();
  const now = new Date('2026-06-11T10:00:00.000Z');
  const assertion = createPosDeviceProofAssertion({
    privateKeyPem: pair.privateKeyPem,
    deviceId: '33333333-3333-4333-8333-333333333333',
    branchId: '22222222-2222-4222-8222-222222222222',
    binding: 'abcdefghijklmnopqrstuvwxyz0123456789_-',
    capabilities: ['POS_TERMINAL'],
    now,
    nonce: 'nonce0123456789AB',
  });

  const parts = assertion.proof.split('.');
  assert.equal(parts.length, 3);
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.deepEqual(header, {
    alg: 'EdDSA',
    typ: POS_DEVICE_PROOF_HEADER_TYP,
    v: POS_DEVICE_PROOF_VERSION,
  });
  assert.equal(payload.v, POS_DEVICE_PROOF_VERSION);
  assert.equal(payload.timestamp, now.toISOString());
  assert.deepEqual(payload.capabilities, ['POS_TERMINAL']);
  assert.equal(assertion.expiresAt, new Date(now.getTime() + 60_000).toISOString());
  assert.doesNotMatch(JSON.stringify(assertion), /sessionToken|privateKeyPem/);
  assert.equal(
    verify(
      null,
      Buffer.from(buildPosDeviceProofSigningPayload(payload), 'utf8'),
      pair.publicKeyPem,
      Buffer.from(signaturePart, 'base64url'),
    ),
    true,
  );
});
