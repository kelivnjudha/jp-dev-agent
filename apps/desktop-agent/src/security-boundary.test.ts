import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function readSource(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), 'utf8');
}

test('renderer clears setup code before sending claim request', async () => {
  const renderer = await readSource('apps/desktop-agent/src/renderer/renderer.ts');
  const clearIndex = renderer.indexOf("setupInput.value = ''");
  const claimIndex = renderer.indexOf('.claimSetupCode(code, label)');

  assert.ok(clearIndex > -1, 'setup input is cleared');
  assert.ok(claimIndex > -1, 'claim bridge is called');
  assert.ok(clearIndex < claimIndex, 'setup input clears before IPC claim');
});

test('preload exposes only safe setup and status bridge functions', async () => {
  const preload = await readSource('apps/desktop-agent/src/preload/preload.ts');

  assert.match(preload, /getAgentStatus/);
  assert.match(preload, /claimSetupCode/);
  assert.match(preload, /checkActivation/);
  assert.doesNotMatch(preload, /submitSetupCode/);
  assert.doesNotMatch(preload, /privateKeyPem/);
  assert.doesNotMatch(preload, /publicKeyPem/);
  assert.doesNotMatch(preload, /hardwareFingerprintHash/);
  assert.doesNotMatch(preload, /sessionToken/);
});

test('renderer never reads raw device identifiers or secret identity fields', async () => {
  const renderer = await readSource('apps/desktop-agent/src/renderer/renderer.ts');

  assert.doesNotMatch(renderer, /innerHTML/);
  assert.doesNotMatch(renderer, /deviceId/);
  assert.doesNotMatch(renderer, /privateKeyPem/);
  assert.doesNotMatch(renderer, /publicKeyPem/);
  assert.doesNotMatch(renderer, /hardwareFingerprintHash/);
  assert.doesNotMatch(renderer, /sessionToken/);
  assert.doesNotMatch(renderer, /signingPayload/);
  assert.doesNotMatch(renderer, /signature/);
});

test('mock activation controls are hidden by default and gated in main process', async () => {
  const [html, main] = await Promise.all([
    readSource('apps/desktop-agent/src/renderer/index.html'),
    readSource('apps/desktop-agent/src/main/main.ts'),
  ]);

  assert.match(html, /id="dev-controls"[^>]*hidden/);
  assert.match(main, /JDA_ENABLE_MOCK_DEVICE_FLOW === 'true'/);

  const mockGateIndex = main.indexOf("ipcMain.handle('agent:mockActivate'");
  const mockNoOpIndex = main.indexOf('if (!MOCK_FLOW_ENABLED) return getSnapshot();', mockGateIndex);
  const mockActivateIndex = main.indexOf('mockActivateDevice(state', mockGateIndex);
  assert.ok(mockGateIndex > -1);
  assert.ok(mockNoOpIndex > mockGateIndex);
  assert.ok(mockActivateIndex > mockNoOpIndex);
});

test('real setup-code claim is main-process only', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.ts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /claimBranchDeviceSetupCode/);
  assert.doesNotMatch(preload, /claimBranchDeviceSetupCode/);
  assert.doesNotMatch(renderer, /claimBranchDeviceSetupCode/);
});

test('session challenge, signing, and token handling stay main-process only', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.ts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /requestBranchDeviceSessionChallenge/);
  assert.match(main, /issueBranchDeviceSession/);
  assert.match(main, /signDeviceSessionPayload/);
  assert.match(main, /let deviceSessionToken: string \| null = null/);
  assert.doesNotMatch(preload, /requestBranchDeviceSessionChallenge/);
  assert.doesNotMatch(preload, /issueBranchDeviceSession/);
  assert.doesNotMatch(preload, /signDeviceSessionPayload/);
  assert.doesNotMatch(preload, /privateKeyPem/);
  assert.doesNotMatch(preload, /sessionToken/);
  assert.doesNotMatch(renderer, /requestBranchDeviceSessionChallenge/);
  assert.doesNotMatch(renderer, /issueBranchDeviceSession/);
  assert.doesNotMatch(renderer, /signDeviceSessionPayload/);
  assert.doesNotMatch(renderer, /sessionToken/);
});

test('heartbeat handling stays main-process only and guarded against duplicate loops', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.ts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /sendBranchDeviceHeartbeat/);
  assert.match(main, /heartbeatInFlight/);
  assert.match(main, /heartbeatLifecycleVersion/);
  assert.match(main, /HEARTBEAT_RECONNECT_DELAYS_MS/);
  assert.doesNotMatch(preload, /sendBranchDeviceHeartbeat/);
  assert.doesNotMatch(preload, /heartbeatInFlight/);
  assert.doesNotMatch(preload, /sessionToken/);
  assert.doesNotMatch(renderer, /sendBranchDeviceHeartbeat/);
  assert.doesNotMatch(renderer, /sessionToken/);
});

test('heartbeat lifecycle stops clear token and timers on sensitive state changes', async () => {
  const main = await readSource('apps/desktop-agent/src/main/main.ts');

  assert.match(main, /function stopHeartbeatLifecycle/);
  assert.match(main, /clearHeartbeatTimer\(\)/);
  assert.match(main, /clearDeviceSessionToken\(\)/);
  assert.match(main, /failHeartbeatTerminal\(state, 'SESSION_TOKEN_MISSING'\)/);
  assert.match(main, /failHeartbeatTerminal\(state, errorCode\)/);
  assert.match(main, /ipcMain\.handle\('agent:claimSetupCode'[\s\S]*stopHeartbeatLifecycle\(\)/);
  assert.match(main, /ipcMain\.handle\('agent:disable'[\s\S]*stopHeartbeatLifecycle\(\)/);
});

test('local proxy remains non-forwarding during heartbeat phase', async () => {
  const proxy = await readSource('packages/agent-proxy/src/index.ts');

  assert.doesNotMatch(proxy, /fetch\(/);
  assert.doesNotMatch(proxy, /sessionToken/);
  assert.match(proxy, /DEV_ONLY_NO_UPSTREAM_FORWARDING/);
});
