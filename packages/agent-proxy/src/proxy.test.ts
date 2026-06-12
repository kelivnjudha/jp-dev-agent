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
    '/scanner/events',
  ]);
  assert.equal(isAllowedProxyPath('/proxy/test'), true);
  assert.equal(isAllowedProxyPath('/pos/device-proof'), true);
  assert.equal(isAllowedProxyPath('/scanner/events'), true);
  assert.equal(isAllowedProxyPath('/scanner/events/anything'), false);
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
  overrides: {
    getScannerEvents?: (query: { cursor: number; waitMs: number }) => Promise<unknown>;
  } = {},
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
    ...overrides,
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

test('scanner events endpoint requires the exact allowed origin', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/scanner/events?cursor=0`, {
      headers: { origin: 'http://evil.test' },
    });
    assert.equal(denied.status, 403);
    assert.notEqual(denied.headers.get('access-control-allow-origin'), '*');
    const deniedBody = await denied.json();
    assert.equal(deniedBody.code, 'SCANNER_EVENTS_ORIGIN_NOT_ALLOWED');

    const noOrigin = await fetch(`${baseUrl}/scanner/events?cursor=0`);
    assert.equal(noOrigin.status, 403);
  }, {
    getScannerEvents: async () => ({ cursor: 0, events: [] }),
  });
});

test('scanner events endpoint passes cursor through and returns the opaque payload', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits.clear();
  const seenQueries: Array<{ cursor: number; waitMs: number }> = [];
  await withProxyServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/scanner/events?cursor=7&waitMs=9999`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3002');
    const body = await response.json();
    assert.deepEqual(body, { cursor: 9, events: [{ type: 'SCAN', scanId: 'x' }] });
    assert.deepEqual(seenQueries, [{ cursor: 7, waitMs: 1500 }], 'waitMs is capped at 1500');
  }, {
    getScannerEvents: async (query) => {
      seenQueries.push(query);
      return { cursor: 9, events: [{ type: 'SCAN', scanId: 'x' }] };
    },
  });
});

test('scanner events endpoint rejects malformed cursors and missing providers safely', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    const badCursor = await fetch(`${baseUrl}/scanner/events?cursor=abc`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(badCursor.status, 400);
    assert.equal((await badCursor.json()).code, 'SCANNER_EVENTS_CURSOR_INVALID');
  }, {
    getScannerEvents: async () => ({ cursor: 0, events: [] }),
  });

  __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/scanner/events?cursor=0`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'SCANNER_EVENTS_UNAVAILABLE');
  });
});

test('scanner events endpoint maps provider readiness failures to safe 423 codes', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/scanner/events?cursor=0`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(response.status, 423);
    const body = await response.json();
    assert.equal(body.code, 'POS_DEVICE_NOT_ACTIVE');
  }, {
    getScannerEvents: async () => {
      throw new Error('POS_DEVICE_NOT_ACTIVE');
    },
  });
});

test('scanner events endpoint has its own rate limit bucket', async () => {
  __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits.clear();
  __INTERNAL_AGENT_PROXY_TESTING.posProofRateLimits.clear();
  await withProxyServer(async (baseUrl) => {
    // Pre-fill the scanner bucket to its cap, then expect 429 — without
    // looping 240 live requests.
    const buckets = __INTERNAL_AGENT_PROXY_TESTING.scannerEventsRateLimits;
    const probe = await fetch(`${baseUrl}/scanner/events?cursor=0`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(probe.status, 200);
    for (const bucket of buckets.values()) {
      bucket.count = 240;
    }
    const limited = await fetch(`${baseUrl}/scanner/events?cursor=0`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'SCANNER_EVENTS_RATE_LIMITED');

    // The proof endpoint is unaffected by the scanner bucket.
    const proof = await fetch(`${baseUrl}/pos/device-proof?binding=${'a'.repeat(43)}`, {
      headers: { origin: 'http://127.0.0.1:3002' },
    });
    assert.equal(proof.status, 200);
  }, {
    getScannerEvents: async () => ({ cursor: 0, events: [] }),
  });
});
