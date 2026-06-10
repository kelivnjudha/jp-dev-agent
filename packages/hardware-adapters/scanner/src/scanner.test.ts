import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WedgeScannerHarnessAdapter,
  buildSafeScannerLogEvent,
  validateScanPayload,
} from './index.js';

const NOW = new Date('2026-06-10T09:00:00.000Z');

test('accepts valid EAN13 with correct check digit', () => {
  const result = validateScanPayload('5901234123457', { now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.symbology, 'EAN13');
  assert.equal(result.event.valueLength, 13);
  assert.equal(result.event.value, undefined);
});

test('rejects EAN13 with bad check digit', () => {
  const result = validateScanPayload('5901234123458', { now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'SCAN_EAN_CHECK_DIGIT_INVALID');
});

test('accepts Code128-style printable ASCII within length', () => {
  const result = validateScanPayload('JP-SKU-ABC-1234', { now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.symbology, 'CODE128');
  assert.equal(result.event.valueLength, 15);
});

test('trims CR LF TAB terminators and surrounding whitespace', () => {
  const result = validateScanPayload('\r\n\t 5901234123457 \t\n', { now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.symbology, 'EAN13');
  assert.equal(result.event.valueLength, 13);
});

test('rejects embedded TAB ESC and other control characters', () => {
  for (const input of ['ABC\t123', 'ABC\u001b123', 'ABC\u0000123']) {
    const result = validateScanPayload(input, { now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, 'SCAN_CONTROL_CHARS');
  }
});

test('rejects empty scans', () => {
  const result = validateScanPayload('\r\n\t ', { now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'SCAN_EMPTY');
});

test('rejects scans over 256 chars', () => {
  const result = validateScanPayload('A'.repeat(257), { now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'SCAN_TOO_LONG');
});

test('parses AIM prefix and infers symbology', () => {
  const ean = validateScanPayload(']E05901234123457', { now: NOW });
  const code128 = validateScanPayload(']C1JP-SKU-ABC', { now: NOW });
  const qr = validateScanPayload(']Q1https://example.invalid/not-opened', { now: NOW });

  assert.equal(ean.ok, true);
  if (ean.ok) assert.equal(ean.event.symbology, 'EAN13');
  assert.equal(code128.ok, true);
  if (code128.ok) assert.equal(code128.event.symbology, 'CODE128');
  assert.equal(qr.ok, true);
  if (qr.ok) assert.equal(qr.event.symbology, 'QR');
});

test('duplicate scan within one second returns SCAN_DUPLICATE', async () => {
  let nowMs = NOW.getTime();
  const adapter = new WedgeScannerHarnessAdapter({
    now: () => new Date(nowMs),
  });

  const first = await adapter.validateInput('5901234123457');
  const second = await adapter.validateInput('5901234123457');
  nowMs += 1_100;
  const third = await adapter.validateInput('5901234123457');
  const status = await adapter.getStatus();

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, 'SCAN_DUPLICATE');
  assert.equal(third.ok, true);
  assert.equal(status.duplicateCount, 1);
});

test('sustained rate cap returns SCAN_RATE_LIMITED', async () => {
  let counter = 0;
  const adapter = new WedgeScannerHarnessAdapter({
    now: () => new Date(NOW.getTime() + counter++ * 100),
  });

  const results = await Promise.all([
    adapter.validateInput('JP-SKU-1'),
    adapter.validateInput('JP-SKU-2'),
    adapter.validateInput('JP-SKU-3'),
    adapter.validateInput('JP-SKU-4'),
    adapter.validateInput('JP-SKU-5'),
    adapter.validateInput('JP-SKU-6'),
  ]);

  assert.equal(results.slice(0, 5).every((result) => result.ok), true);
  const sixth = results[5];
  assert.equal(sixth?.ok, false);
  if (sixth && !sixth.ok) assert.equal(sixth.code, 'SCAN_RATE_LIMITED');
});

test('raw value is not logged in safe scanner log event', () => {
  const result = validateScanPayload('JP-SKU-SECRETISH', { now: NOW, includeValue: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const logEvent = buildSafeScannerLogEvent(result);
  const text = JSON.stringify(logEvent);

  assert.doesNotMatch(text, /JP-SKU-SECRETISH/);
  assert.doesNotMatch(text, /value["']/);
  assert.match(text, /valueHashPrefix/);
});
