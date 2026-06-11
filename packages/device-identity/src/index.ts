import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { hostname, platform, release } from 'node:os';

import type { DeviceCapability, SafeDeviceIdentity } from '@jade-dev-agent/protocol';

export interface DeviceKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export const POS_DEVICE_PROOF_VERSION = 'JP_POS_DEVICE_PROOF_V1';
export const POS_DEVICE_PROOF_HEADER_TYP = 'JP-POS-DEVICE-PROOF';
export const POS_DEVICE_PROOF_TTL_MS = 60_000;

export interface CreatePosDeviceProofInput {
  privateKeyPem: string;
  deviceId: string;
  branchId: string;
  binding: string;
  capabilities: readonly DeviceCapability[];
  now?: Date;
  nonce?: string;
}

export interface PosDeviceProofAssertion {
  proof: string;
  expiresAt: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: {
      format: 'pem',
      type: 'pkcs8',
    },
    publicKeyEncoding: {
      format: 'pem',
      type: 'spki',
    },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export function computeHardwareFingerprintHash(seed?: string): string {
  const stableParts = [
    'jp-dev-agent-scaffold-v1',
    platform(),
    release(),
    hostname(),
    seed || 'no-seed',
  ];
  return createHash('sha256').update(stableParts.join('|')).digest('hex');
}

export function createSafeHidPrefix(fingerprintHash: string): string {
  const safe = fingerprintHash.replace(/[^a-f0-9]/gi, '').toUpperCase();
  return safe.length >= 12 ? `${safe.slice(0, 4)}-${safe.slice(4, 12)}` : 'HID-UNKNOWN';
}

export function createSafeDeviceIdentity(seed = randomBytes(16).toString('hex')): {
  identity: SafeDeviceIdentity;
  privateKeyPem: string;
} {
  const keyPair = generateDeviceKeyPair();
  const hardwareFingerprintHash = computeHardwareFingerprintHash(seed);
  return {
    identity: {
      publicKeyPem: keyPair.publicKeyPem,
      hardwareFingerprintHash,
      safeHidPrefix: createSafeHidPrefix(hardwareFingerprintHash),
    },
    privateKeyPem: keyPair.privateKeyPem,
  };
}

export function signDeviceSessionPayload({
  privateKeyPem,
  payload,
}: {
  privateKeyPem: string;
  payload: string;
}): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64url');
}

export function buildPosDeviceProofSigningPayload({
  deviceId,
  branchId,
  binding,
  timestamp,
  nonce,
}: {
  deviceId: string;
  branchId: string;
  binding: string;
  timestamp: string;
  nonce: string;
}): string {
  return [
    POS_DEVICE_PROOF_VERSION,
    deviceId.trim(),
    branchId.trim(),
    binding.trim(),
    timestamp.trim(),
    nonce.trim(),
  ].join('\n');
}

function encodeJsonBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createPosDeviceProofAssertion({
  privateKeyPem,
  deviceId,
  branchId,
  binding,
  capabilities,
  now = new Date(),
  nonce = randomBytes(18).toString('base64url'),
}: CreatePosDeviceProofInput): PosDeviceProofAssertion {
  const timestamp = now.toISOString();
  const payload = {
    v: POS_DEVICE_PROOF_VERSION,
    deviceId: deviceId.trim(),
    branchId: branchId.trim(),
    binding: binding.trim(),
    timestamp,
    nonce,
    capabilities: [...capabilities],
  };
  const header = {
    alg: 'EdDSA',
    typ: POS_DEVICE_PROOF_HEADER_TYP,
    v: POS_DEVICE_PROOF_VERSION,
  };
  const signingPayload = buildPosDeviceProofSigningPayload(payload);
  const signature = signDeviceSessionPayload({ privateKeyPem, payload: signingPayload });
  return {
    proof: `${encodeJsonBase64Url(header)}.${encodeJsonBase64Url(payload)}.${signature}`,
    expiresAt: new Date(now.getTime() + POS_DEVICE_PROOF_TTL_MS).toISOString(),
  };
}
