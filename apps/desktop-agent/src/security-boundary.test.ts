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

test('preload exposes only safe setup status and scanner bridge functions', async () => {
  const preload = await readSource('apps/desktop-agent/src/preload/preload.cts');

  assert.match(preload, /getAgentStatus/);
  assert.match(preload, /claimSetupCode/);
  assert.match(preload, /checkActivation/);
  assert.match(preload, /validateScannerInput/);
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
    readSource('apps/desktop-agent/src/preload/preload.cts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /claimBranchDeviceSetupCode/);
  assert.doesNotMatch(preload, /claimBranchDeviceSetupCode/);
  assert.doesNotMatch(renderer, /claimBranchDeviceSetupCode/);
});

test('session challenge, signing, and token handling stay main-process only', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
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

test('activation polling stays main-process only and reuses activation runner', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /ACTIVATION_POLL_INITIAL_DELAY_MS = 5_000/);
  assert.match(main, /ACTIVATION_POLL_INTERVAL_MS = 12_000/);
  assert.match(main, /ACTIVATION_POLL_API_RETRY_DELAYS_MS = \[15_000, 30_000, 60_000\]/);
  assert.match(main, /let activationPollTimer/);
  assert.match(main, /activationPollLifecycleVersion/);
  assert.match(main, /activationCheckInFlight/);
  assert.match(main, /async function runActivationCheck/);
  assert.match(main, /scheduleActivationRetry/);
  assert.match(main, /startActivationPolling\(ACTIVATION_POLL_INITIAL_DELAY_MS\)/);
  assert.doesNotMatch(preload, /activationPollTimer|runActivationCheck|requestBranchDeviceSessionChallenge/);
  assert.doesNotMatch(renderer, /setTimeout|setInterval|requestBranchDeviceSessionChallenge/);
  assert.doesNotMatch(renderer, /privateKeyPem|sessionToken|signDeviceSessionPayload/);
});

test('activation polling stops on active, terminal, mock, disable, and app quit paths', async () => {
  const main = await readSource('apps/desktop-agent/src/main/main.ts');

  const runActivationIndex = main.indexOf('async function runActivationCheck');
  const successStopIndex = main.indexOf('stopActivationPolling();', main.indexOf('assertValidSessionIssue(sessionIssue)', runActivationIndex));
  const terminalStopIndex = main.indexOf('stopActivationPolling();', main.indexOf('state = failActivationCheck(state, errorCode)', runActivationIndex));
  const mockIndex = main.indexOf("ipcMain.handle('agent:mockActivate'");
  const disableIndex = main.indexOf("ipcMain.handle('agent:disable'");
  const quitIndex = main.indexOf("app.on('before-quit'");

  assert.ok(runActivationIndex > -1);
  assert.ok(successStopIndex > runActivationIndex);
  assert.ok(terminalStopIndex > runActivationIndex);
  assert.match(main, /ipcMain\.handle\('agent:claimSetupCode'[\s\S]*stopActivationPolling\(\)/);
  assert.ok(main.indexOf('stopActivationPolling();', mockIndex) > mockIndex);
  assert.ok(main.indexOf('stopActivationPolling();', disableIndex) > disableIndex);
  assert.ok(main.indexOf('stopActivationPolling();', quitIndex) > quitIndex);
});

test('automatic activation success starts heartbeat only after session issue validation', async () => {
  const main = await readSource('apps/desktop-agent/src/main/main.ts');
  const activationStart = main.indexOf('async function runActivationCheck');
  const issueIndex = main.indexOf('const sessionIssue = await issueBranchDeviceSession', activationStart);
  const validateIndex = main.indexOf('assertValidSessionIssue(sessionIssue)', issueIndex);
  const tokenIndex = main.indexOf('deviceSessionToken = sessionIssue.sessionToken', validateIndex);
  const completeIndex = main.indexOf('completeActivationCheck(state, sessionIssue.session)', tokenIndex);
  const heartbeatIndex = main.indexOf('startHeartbeatLifecycle()', completeIndex);

  assert.ok(issueIndex > activationStart);
  assert.ok(validateIndex > issueIndex);
  assert.ok(tokenIndex > validateIndex);
  assert.ok(completeIndex > tokenIndex);
  assert.ok(heartbeatIndex > completeIndex);
});

test('heartbeat handling stays main-process only and guarded against duplicate loops', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
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

test('session refresh stays main-process only and guarded against stale-token races', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /SESSION_REFRESH_SAFETY_WINDOW_MS = 60_000/);
  assert.match(main, /sessionRefreshInFlight/);
  assert.match(main, /sessionRefreshLifecycleVersion/);
  assert.match(main, /scheduleSessionRefreshTimer/);
  assert.match(main, /pauseHeartbeatForSessionRefresh/);
  assert.match(main, /validateBranchDeviceSessionChallengeSigningPayload/);
  assert.match(main, /startSessionRefresh\(state\)/);
  assert.doesNotMatch(preload, /runSessionRefresh/);
  assert.doesNotMatch(preload, /sessionRefreshInFlight/);
  assert.doesNotMatch(preload, /sessionToken/);
  assert.doesNotMatch(renderer, /runSessionRefresh/);
  assert.doesNotMatch(renderer, /sessionToken/);
});

test('session refresh replaces memory token only after a validated issue response', async () => {
  const main = await readSource('apps/desktop-agent/src/main/main.ts');
  const refreshStart = main.indexOf('async function runSessionRefresh');
  const issueIndex = main.indexOf('const sessionIssue = await issueBranchDeviceSession', refreshStart);
  const validateIndex = main.indexOf('assertValidSessionIssue(sessionIssue)', issueIndex);
  const replaceIndex = main.indexOf('deviceSessionToken = sessionIssue.sessionToken', validateIndex);

  assert.ok(refreshStart > -1);
  assert.ok(issueIndex > refreshStart);
  assert.ok(validateIndex > issueIndex);
  assert.ok(replaceIndex > validateIndex);
});

test('heartbeat session expired triggers only the narrow refresh path', async () => {
  const main = await readSource('apps/desktop-agent/src/main/main.ts');
  const expiredCheckIndex = main.indexOf("errorCode === 'SESSION_EXPIRED'");
  const identityGuardIndex = main.indexOf('canAttemptHeartbeatSessionExpiredRefresh', expiredCheckIndex);
  const singleAttemptIndex = main.indexOf('sessionExpiredRefreshAttempted = true', identityGuardIndex);
  const refreshIndex = main.indexOf("runSessionRefresh(refreshVersion, 'heartbeat_session_expired')", singleAttemptIndex);

  assert.ok(expiredCheckIndex > -1);
  assert.ok(identityGuardIndex > expiredCheckIndex);
  assert.ok(singleAttemptIndex > identityGuardIndex);
  assert.ok(refreshIndex > singleAttemptIndex);
  assert.doesNotMatch(main, /SESSION_TOKEN_INVALID'[\s\S]{0,160}runSessionRefresh/);
  assert.doesNotMatch(main, /SESSION_TOKEN_MISSING'[\s\S]{0,160}runSessionRefresh/);
});

test('heartbeat lifecycle stops clear token and timers on sensitive state changes', async () => {
  const main = await readSource('apps/desktop-agent/src/main/main.ts');

  assert.match(main, /function stopHeartbeatLifecycle/);
  assert.match(main, /clearHeartbeatTimer\(\)/);
  assert.match(main, /clearSessionRefreshTimer\(\)/);
  assert.match(main, /clearReconnectTimer\(\)/);
  assert.match(main, /clearDeviceSessionToken\(\)/);
  assert.match(main, /failHeartbeatTerminal\(state, 'SESSION_TOKEN_MISSING'\)/);
  assert.match(main, /failHeartbeatTerminal\(state, errorCode\)/);
  assert.match(main, /failSessionRefreshTerminal\(state, errorCode\)/);
  assert.match(main, /ipcMain\.handle\('agent:claimSetupCode'[\s\S]*stopHeartbeatLifecycle\(\)/);
  assert.match(main, /ipcMain\.handle\('agent:disable'[\s\S]*stopHeartbeatLifecycle\(\)/);
});

test('local proxy remains non-forwarding during heartbeat phase', async () => {
  const proxy = await readSource('packages/agent-proxy/src/index.ts');

  assert.doesNotMatch(proxy, /fetch\(/);
  assert.doesNotMatch(proxy, /sessionToken/);
  assert.match(proxy, /DEV_ONLY_NO_UPSTREAM_FORWARDING/);
});

test('POS proof signing stays main-process only and uses exact local origin allowlist', async () => {
  const [main, core, proxy, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('packages/agent-core/src/index.ts'),
    readSource('packages/agent-proxy/src/index.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  assert.match(main, /createPosDeviceProofAssertion/);
  assert.match(main, /evaluatePosDeviceProofReadiness/);
  assert.match(core, /futureProxyForwardingEligible !== true/);
  assert.match(main, /JDA_POS_ALLOWED_ORIGIN/);
  assert.match(proxy, /access-control-allow-origin/);
  assert.doesNotMatch(proxy, /access-control-allow-origin': '\*'/);
  assert.doesNotMatch(preload, /createPosDeviceProofAssertion|JDA_POS_ALLOWED_ORIGIN|deviceSessionToken/);
  assert.doesNotMatch(renderer, /createPosDeviceProofAssertion|deviceSessionToken|privateKeyPem/);
});

test('POS proof fast readiness wake-up is bounded, single-flight, and main-process only', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);

  // Bounded wait below JPPOS's 2.5s proof-fetch timeout, paced polling
  // (no busy loop), and a shared single-flight heartbeat wake so retry
  // bursts cannot stack refreshes.
  assert.match(main, /POS_PROOF_READY_WAIT_MS = 1_800/);
  assert.match(main, /POS_PROOF_READY_POLL_MS = 120/);
  assert.match(main, /createSingleFlight\(/);
  assert.match(main, /wakeHeartbeatForPosProof/);
  assert.match(main, /await sleepMs\(POS_PROOF_READY_POLL_MS\)/);

  // The wake re-runs the lifecycle's own heartbeat (which reschedules
  // itself) — it must be guarded against concurrent refresh/heartbeat.
  const wakeIndex = main.indexOf('const wakeHeartbeatForPosProof = createSingleFlight');
  const guardIndex = main.indexOf('if (heartbeatInFlight || sessionRefreshInFlight) return;', wakeIndex);
  const runIndex = main.indexOf('await runHeartbeat(heartbeatLifecycleVersion || 1);', guardIndex);
  assert.ok(wakeIndex > -1);
  assert.ok(guardIndex > wakeIndex);
  assert.ok(runIndex > guardIndex);

  // Terminal readiness reasons must never enter the wait loop.
  const awaitIndex = main.indexOf('async function awaitPosProofReadiness');
  const terminalShortCircuit = main.indexOf(
    'if (readiness.ready || !readiness.transient) return readiness;',
    awaitIndex,
  );
  assert.ok(awaitIndex > -1);
  assert.ok(terminalShortCircuit > awaitIndex);

  assert.doesNotMatch(preload, /wakeHeartbeatForPosProof|awaitPosProofReadiness|runHeartbeat/);
  assert.doesNotMatch(renderer, /wakeHeartbeatForPosProof|awaitPosProofReadiness|runHeartbeat/);
});

test('scanner bridge is narrow and does not expose device secrets', async () => {
  const [main, preload, renderer] = await Promise.all([
    readSource('apps/desktop-agent/src/main/main.ts'),
    readSource('apps/desktop-agent/src/preload/preload.cts'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
  ]);
  const scannerBridgeIndex = preload.indexOf('validateScannerInput');
  const scannerMainIndex = main.indexOf("ipcMain.handle('agent:validateScannerInput'");

  assert.ok(scannerBridgeIndex > -1);
  assert.ok(scannerMainIndex > -1);
  assert.match(main, /scannerAdapter\.validateInput\(input\)/);
  assert.doesNotMatch(preload.slice(scannerBridgeIndex), /privateKeyPem|publicKeyPem|hardwareFingerprintHash|sessionToken/);
  assert.doesNotMatch(renderer, /innerHTML/);
  assert.doesNotMatch(renderer, /window\.open|location\.href|eval\(/);
});

test('scanner capture field masks raw wedge input and documents wedge-only mode', async () => {
  const [html, renderer, main] = await Promise.all([
    readSource('apps/desktop-agent/src/renderer/index.html'),
    readSource('apps/desktop-agent/src/renderer/renderer.ts'),
    readSource('apps/desktop-agent/src/main/main.ts'),
  ]);

  assert.match(html, /id="scanner-capture"[\s\S]*type="password"/);
  assert.match(html, /data-raw-hidden="true"/);
  assert.match(html, /Raw barcode values\s+are hidden by default/);
  assert.match(html, /Current mode[\s\S]*Keyboard Wedge/);
  assert.match(html, /Device selection[\s\S]*Not available in wedge mode/);
  assert.match(html, /Detect HID scanner[\s\S]*Coming next/);
  assert.match(html, /No native HID dependency is\s+included in this patch/);
  assert.match(renderer, /clearScannerDevValue\(\)/);
  assert.match(main, /JDA_SCANNER_DEV_SHOW_VALUE === 'true'/);
  assert.doesNotMatch(main, /node-hid|WebHID|navigator\.hid/);
});

test('device status proxy does not expose scanner capture material', async () => {
  const proxy = await readSource('packages/agent-proxy/src/index.ts');
  const statusPathIndex = proxy.indexOf("path === '/device/status'");
  const statusBodyIndex = proxy.indexOf('options.getDeviceStatus()', statusPathIndex);

  assert.ok(statusPathIndex > -1);
  assert.ok(statusBodyIndex > statusPathIndex);
  assert.doesNotMatch(proxy, /validateScannerInput/);
  assert.doesNotMatch(proxy, /valueHashPrefix/);
  assert.doesNotMatch(proxy, /ScanEvent/);
});
