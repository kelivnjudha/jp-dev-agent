import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __INTERNAL_AGENT_PROXY_TESTING,
  ALLOWED_PROXY_PATHS,
  createAgentProxyServer,
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  isAllowedProxyPath,
  resolveLocalProxyPath,
} from './index.js';

test('proxy binds to loopback defaults only', () => {
  assert.equal(DEFAULT_PROXY_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PROXY_PORT, 17681);
});

test('allowed proxy paths are exact and small', () => {
  assert.deepEqual([...ALLOWED_PROXY_PATHS], [
    '/health',
    '/device/status',
    '/proxy/test',
    '/pos/device-proof',
  ]);
  assert.equal(isAllowedProxyPath('/proxy/test'), true);
  assert.equal(isAllowedProxyPath('/pos/device-proof'), true);
  assert.equal(isAllowedProxyPath('/proxy/test/anything'), false);
  assert.equal(isAllowedProxyPath('/http://example.com'), false);
});

test('proxy URL parsing rejects absolute and protocol-relative request targets', () => {
  assert.equal(resolveLocalProxyPath('/health?check=1'), '/health');
  assert.equal(resolveLocalProxyPath('health'), null);
  assert.equal(resolveLocalProxyPath('//example.test/health'), null);
  assert.equal(resolveLocalProxyPath('http://example.test/health'), null);
});

async function withProxyServer<T>(
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createAgentProxyServer({
    getHealth: () => ({
      ok: true,
      mode: 'SETUP',
      deviceStatus: 'UNREGISTERED',
      proxy: {
        enabled: true,
        host: DEFAULT_PROXY_HOST,
        port: DEFAULT_PROXY_PORT,
        futureForwardingEligible: false,
      },
      capabilities: [],
      appVersion: 'test',
      updatedAt: new Date('2026-06-11T10:00:00.000Z').toISOString(),
    }),
    getDeviceStatus: () => ({
      status: 'UNREGISTERED',
      mode: 'SETUP',
      capabilities: [],
      message: 'test',
      updatedAt: new Date('2026-06-11T10:00:00.000Z').toISOString(),
    }),
    allowedPosOrigin: 'http://127.0.0.1:3002',
    getPosDeviceProof: async () => ({
      proof: 'aaaaaaaa.bbbbbbbb.cccccccc',
      expiresAt: new Date('2026-06-11T10:01:00.000Z').toISOString(),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_PROXY_HOST, resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await run(`http://${DEFAULT_PROXY_HOST}:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('POS device proof endpoint requires exact allowed origin and returns proof envelope only', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.posProofRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pos/device-proof?binding=${'a'.repeat(43)}`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3002');
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'proof']);
    assert.doesNotMatch(JSON.stringify(body), /sessionToken|privateKey|publicKey|fingerprint/);
  });
});

test('POS device proof endpoint rejects unapproved origins without wildcard CORS', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.posProofRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/pos/device-proof?binding=${'a'.repeat(43)}`, {
      headers: { origin: 'http://evil.test' },
    });
    assert.equal(response.status, 403);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.code, 'POS_DEVICE_PROOF_ORIGIN_NOT_ALLOWED');
  });
});

test('POS device proof endpoint rate limits after 30 requests per minute', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.posProofRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${baseUrl}/pos/device-proof?binding=${'a'.repeat(43)}`, {
        headers: { origin: 'http://127.0.0.1:3002' },
      });
      assert.equal(response.status, 200);
    }
    const response = await fetch(`${baseUrl}/pos/device-proof?binding=${'a'.repeat(43)}`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.code, 'POS_DEVICE_PROOF_RATE_LIMITED');
  });
});
