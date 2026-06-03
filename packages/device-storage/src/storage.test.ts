import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DevFileDeviceStorage } from './index.js';

test('pending device storage persists only safe activation metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jp-dev-agent-storage-'));
  try {
    const identityPath = join(dir, 'identity.json');
    const pendingPath = join(dir, 'pending.json');
    const storage = new DevFileDeviceStorage(identityPath, pendingPath);
    await storage.writePendingDevice({
      deviceId: 'd0000000-0000-4000-8000-000000000001',
      serverStatus: 'PENDING_ACTIVATION',
      branch: {
        id: 'b0000000-0000-4000-8000-000000000001',
        code: 'BKK',
        name: 'Bangkok',
      },
      allowedCapabilities: ['POS_TERMINAL', 'BARCODE_SCANNER'],
      safeHidPrefix: 'ABCD-12345678',
      deviceLabel: 'Front counter',
      claimedAt: '2026-06-04T01:00:00.000Z',
      setupCode: 'JPBD-SECRET',
      sessionToken: 'token-secret',
      privateKeyPem: 'private-secret',
      publicKeyPem: 'public-secret',
      hardwareFingerprintHash: 'fingerprint-secret',
    } as never);

    const raw = await readFile(pendingPath, 'utf8');
    assert.equal(raw.includes('JPBD-SECRET'), false);
    assert.equal(raw.includes('token-secret'), false);
    assert.equal(raw.includes('private-secret'), false);
    assert.equal(raw.includes('public-secret'), false);
    assert.equal(raw.includes('fingerprint-secret'), false);
    assert.equal(raw.includes('sessionToken'), false);
    assert.equal(raw.includes('privateKeyPem'), false);
    assert.equal(raw.includes('publicKeyPem'), false);
    assert.equal(raw.includes('hardwareFingerprintHash'), false);

    const restored = await storage.readPendingDevice();
    assert.equal(restored?.safeHidPrefix, 'ABCD-12345678');
    assert.deepEqual(restored?.allowedCapabilities, ['POS_TERMINAL', 'BARCODE_SCANNER']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
