import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { hostname, platform, release } from 'node:os';

import type { SafeDeviceIdentity } from '@jade-dev-agent/protocol';

export interface DeviceKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
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
