import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CONNECTION_STATUSES,
  BranchDeviceSessionChallengeValidationError,
  buildBranchDeviceSessionSigningPayload,
  validateBranchDeviceSessionChallengeSigningPayload,
} from './index.js';

const DEVICE_ID = 'd0000000-0000-4000-8000-000000000001';
const TIMESTAMP = '2026-06-04T01:00:00.000Z';
const EXPIRES_AT = '2026-06-04T01:02:00.000Z';
const CHALLENGE = 'challenge-value';

function validSigningPayload(): string {
  return buildBranchDeviceSessionSigningPayload({
    deviceId: DEVICE_ID,
    challenge: CHALLENGE,
    timestamp: TIMESTAMP,
  });
}

test('device session signing payload is canonical and ordered', () => {
  assert.equal(
    buildBranchDeviceSessionSigningPayload({
      deviceId: DEVICE_ID,
      challenge: CHALLENGE,
      timestamp: TIMESTAMP,
    }),
    'JP_BRANCH_DEVICE_SESSION_V1\nd0000000-0000-4000-8000-000000000001\nchallenge-value\n2026-06-04T01:00:00.000Z',
  );
});

test('agent connection statuses include refreshing without changing registration state enum', () => {
  assert.ok(AGENT_CONNECTION_STATUSES.includes('REFRESHING'));
});

test('valid session challenge returns the exact server signing payload', () => {
  assert.equal(
    validateBranchDeviceSessionChallengeSigningPayload({
      deviceId: DEVICE_ID,
      challenge: {
        challenge: CHALLENGE,
        timestamp: TIMESTAMP,
        expiresAt: EXPIRES_AT,
        signingPayload: validSigningPayload(),
      },
      nowMs: new Date('2026-06-04T00:59:00.000Z').getTime(),
    }),
    validSigningPayload(),
  );
});

test('session challenge signing payload mismatch fails closed', () => {
  assert.throws(
    () =>
      validateBranchDeviceSessionChallengeSigningPayload({
        deviceId: DEVICE_ID,
        challenge: {
          challenge: CHALLENGE,
          timestamp: TIMESTAMP,
          expiresAt: EXPIRES_AT,
          signingPayload: `${validSigningPayload()}-tampered`,
        },
        nowMs: new Date('2026-06-04T00:59:00.000Z').getTime(),
      }),
    (error) => {
      assert.ok(error instanceof BranchDeviceSessionChallengeValidationError);
      assert.equal(error.code, 'SIGNING_PAYLOAD_MISMATCH');
      return true;
    },
  );
});

test('expired or near-expired session challenge fails closed', () => {
  assert.throws(
    () =>
      validateBranchDeviceSessionChallengeSigningPayload({
        deviceId: DEVICE_ID,
        challenge: {
          challenge: CHALLENGE,
          timestamp: TIMESTAMP,
          expiresAt: EXPIRES_AT,
          signingPayload: validSigningPayload(),
        },
        nowMs: new Date('2026-06-04T01:01:56.000Z').getTime(),
      }),
    (error) => {
      assert.ok(error instanceof BranchDeviceSessionChallengeValidationError);
      assert.equal(error.code, 'CHALLENGE_EXPIRED');
      return true;
    },
  );
});

test('malformed session challenge fails closed', () => {
  assert.throws(
    () =>
      validateBranchDeviceSessionChallengeSigningPayload({
        deviceId: DEVICE_ID,
        challenge: {
          challenge: CHALLENGE,
          timestamp: 'not-a-date',
          expiresAt: EXPIRES_AT,
          signingPayload: validSigningPayload(),
        },
      }),
    (error) => {
      assert.ok(error instanceof BranchDeviceSessionChallengeValidationError);
      assert.equal(error.code, 'SESSION_CHALLENGE_INVALID');
      return true;
    },
  );
});
