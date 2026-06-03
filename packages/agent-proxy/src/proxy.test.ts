import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_PROXY_PATHS,
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
  ]);
  assert.equal(isAllowedProxyPath('/proxy/test'), true);
  assert.equal(isAllowedProxyPath('/proxy/test/anything'), false);
  assert.equal(isAllowedProxyPath('/http://example.com'), false);
});

test('proxy URL parsing rejects absolute and protocol-relative request targets', () => {
  assert.equal(resolveLocalProxyPath('/health?check=1'), '/health');
  assert.equal(resolveLocalProxyPath('health'), null);
  assert.equal(resolveLocalProxyPath('//example.test/health'), null);
  assert.equal(resolveLocalProxyPath('http://example.test/health'), null);
});
