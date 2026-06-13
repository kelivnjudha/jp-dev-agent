import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHidKeyboardScanAssembler,
  hidSelectionKey,
  maskHidSerial,
  parseScannerHidPreference,
  projectSafeHidDeviceInfo,
} from './hid.js';
import { WedgeScannerHarnessAdapter } from './index.js';

// Helper — build the 8-byte boot-protocol report for one key press
// (followed by the all-zero release report).
function press(usage: number, modifiers = 0): number[][] {
  return [
    [modifiers, 0, usage, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ];
}

function typeString(
  assembler: { pushReport(report: readonly number[]): void },
  text: string,
): void {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits: Record<string, number> = {
    '1': 0x1e, '2': 0x1f, '3': 0x20, '4': 0x21, '5': 0x22,
    '6': 0x23, '7': 0x24, '8': 0x25, '9': 0x26, '0': 0x27,
  };
  for (const char of text) {
    let reports: number[][];
    if (lower.includes(char)) {
      reports = press(0x04 + lower.indexOf(char));
    } else if (lower.includes(char.toLowerCase())) {
      reports = press(0x04 + lower.indexOf(char.toLowerCase()), 0x02);
    } else if (digits[char] !== undefined) {
      reports = press(digits[char]!);
    } else if (char === '-') {
      reports = press(0x2d);
    } else {
      throw new Error(`typeString: unhandled char ${char}`);
    }
    for (const report of reports) assembler.pushReport(report);
  }
}

test('HID parser converts a report sequence into the scan string', () => {
  const scans: string[] = [];
  const assembler = createHidKeyboardScanAssembler({ onScan: (s) => scans.push(s) });
  typeString(assembler, 'JP-SKU-42');
  for (const report of press(0x28)) assembler.pushReport(report); // Enter
  assert.deepEqual(scans, ['JP-SKU-42']);
});

test('Enter, keypad Enter, and Tab terminators all complete a scan', () => {
  for (const terminator of [0x28, 0x58, 0x2b]) {
    const scans: string[] = [];
    const assembler = createHidKeyboardScanAssembler({ onScan: (s) => scans.push(s) });
    typeString(assembler, 'abc123');
    for (const report of press(terminator)) assembler.pushReport(report);
    assert.deepEqual(scans, ['abc123'], `terminator 0x${terminator.toString(16)}`);
  }
});

test('held keys across reports are a single press (no doubled chars)', () => {
  const scans: string[] = [];
  const assembler = createHidKeyboardScanAssembler({ onScan: (s) => scans.push(s) });
  // 'a' held for three consecutive reports, then released, then Enter.
  assembler.pushReport([0, 0, 0x04, 0, 0, 0, 0, 0]);
  assembler.pushReport([0, 0, 0x04, 0, 0, 0, 0, 0]);
  assembler.pushReport([0, 0, 0x04, 0, 0, 0, 0, 0]);
  assembler.pushReport([0, 0, 0, 0, 0, 0, 0, 0]);
  for (const report of press(0x28)) assembler.pushReport(report);
  assert.deepEqual(scans, ['a']);
});

test('unmappable usages become control placeholders that validation rejects', async () => {
  const scans: string[] = [];
  const assembler = createHidKeyboardScanAssembler({ onScan: (s) => scans.push(s) });
  typeString(assembler, 'abc');
  // F13 (0x68) — no printable mapping.
  for (const report of press(0x68)) assembler.pushReport(report);
  for (const report of press(0x28)) assembler.pushReport(report);
  assert.equal(scans.length, 1);

  const adapter = new WedgeScannerHarnessAdapter({
    now: () => new Date('2026-06-13T09:00:00.000Z'),
  });
  const result = await adapter.validateInput(scans[0]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SCAN_CONTROL_CHARS');
});

test('stale partial buffers reset after the inter-report timeout', () => {
  let nowMs = 1_000;
  const scans: string[] = [];
  const assembler = createHidKeyboardScanAssembler({
    now: () => nowMs,
    interReportTimeoutMs: 500,
    onScan: (s) => scans.push(s),
  });
  typeString(assembler, 'abc');
  nowMs += 1_000; // stall — partial 'abc' must be dropped
  typeString(assembler, '123');
  for (const report of press(0x28)) assembler.pushReport(report);
  assert.deepEqual(scans, ['123']);
});

test('HID-assembled EAN13 flows through the standard validation: good accepted, bad rejected', async () => {
  const adapter = new WedgeScannerHarnessAdapter({
    now: () => new Date('2026-06-13T09:00:00.000Z'),
  });
  const results: string[] = [];
  const assembler = createHidKeyboardScanAssembler({
    onScan: (assembled) => {
      results.push(assembled);
    },
  });
  typeString(assembler, '5901234123457'); // valid check digit
  for (const report of press(0x28)) assembler.pushReport(report);
  typeString(assembler, '5901234123458'); // bad check digit
  for (const report of press(0x28)) assembler.pushReport(report);

  const good = await adapter.validateInput(results[0]);
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.event.symbology, 'EAN13');
  const bad = await adapter.validateInput(results[1]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'SCAN_EAN_CHECK_DIGIT_INVALID');
});

test('duplicate HID scans are suppressed by the shared debounce policy', async () => {
  let nowMs = Date.parse('2026-06-13T09:00:00.000Z');
  let accepted = 0;
  const adapter = new WedgeScannerHarnessAdapter({
    now: () => new Date(nowMs),
    onAcceptedScan: () => {
      accepted += 1;
    },
  });
  const first = await adapter.validateInput('5901234123457');
  assert.equal(first.ok, true);
  nowMs += 200;
  const dup = await adapter.validateInput('5901234123457');
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.code, 'SCAN_DUPLICATE');
  assert.equal(accepted, 1);
});

test('rate limit applies to HID-assembled scans through the shared adapter', async () => {
  let nowMs = Date.parse('2026-06-13T09:00:00.000Z');
  const adapter = new WedgeScannerHarnessAdapter({ now: () => new Date(nowMs) });
  const codes = [
    '5901234123457',
    '4006381333931',
    '9780201379624',
    '4012345678901',
    '0123456789012',
    '5012345678900',
  ];
  const outcomes: boolean[] = [];
  for (const code of codes) {
    nowMs += 50; // six scans within the 1s window
    const result = await adapter.validateInput(code);
    outcomes.push(result.ok);
  }
  assert.deepEqual(outcomes.slice(0, 5), [true, true, true, true, true]);
  assert.equal(outcomes[5], false);
});

test('safe device projection masks serials and never exposes the raw path', () => {
  const safe = projectSafeHidDeviceInfo({
    vendorId: 0x05e0,
    productId: 0x1200,
    path: '\\\\?\\hid#vid_05e0&pid_1200#7&2bd5f3c&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}',
    serialNumber: 'S1234567890',
    manufacturer: 'Symbol Technologies',
    product: 'Symbol Bar Code Scanner',
    usagePage: 0x8c,
    usage: 0x02,
  });
  assert.equal(safe.serialMasked, 'S1••••');
  assert.equal(safe.likelyScanner, true);
  assert.equal(safe.keyboardClass, false);
  assert.match(safe.key, /^05e0:1200:[0-9a-f]{8}$/);
  const json = JSON.stringify(safe);
  assert.doesNotMatch(json, /hid#vid/i);
  assert.doesNotMatch(json, /1234567890/);
});

test('keyboard-class collections are flagged so the UI can explain Windows fallback', () => {
  const safe = projectSafeHidDeviceInfo({
    vendorId: 0x1234,
    productId: 0x0001,
    path: 'p',
    usagePage: 0x01,
    usage: 0x06,
    product: 'Generic Keyboard Device',
  });
  assert.equal(safe.keyboardClass, true);
});

test('selection keys are stable per path and differ across paths', () => {
  const base = { vendorId: 1, productId: 2 };
  const a1 = hidSelectionKey({ ...base, path: 'path-a' });
  const a2 = hidSelectionKey({ ...base, path: 'path-a' });
  const b = hidSelectionKey({ ...base, path: 'path-b' });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('serial masking handles short and missing serials', () => {
  assert.equal(maskHidSerial('AB'), 'AB••••');
  assert.equal(maskHidSerial('A'), 'A••••');
  assert.equal(maskHidSerial(''), null);
  assert.equal(maskHidSerial(undefined), null);
});

test('persisted scanner preference parses safe fields only', () => {
  assert.deepEqual(
    parseScannerHidPreference({ vendorId: 1504, productId: 4608, product: 'Scanner' }),
    { vendorId: 1504, productId: 4608, product: 'Scanner' },
  );
  assert.equal(parseScannerHidPreference({ vendorId: 'x' }), null);
  assert.equal(parseScannerHidPreference(null), null);
  // Unknown fields (path, serial) are dropped, not round-tripped.
  const parsed = parseScannerHidPreference({
    vendorId: 1,
    productId: 2,
    product: 'S',
    path: 'raw-os-path',
    serialNumber: 'FULLSERIAL',
  });
  assert.deepEqual(parsed, { vendorId: 1, productId: 2, product: 'S' });
});


// ─── Review fixes — multi-key reports in a single HID frame ───────

test('data and terminator coalesced into ONE report keep the data (both slot orders)', () => {
  for (const slots of [
    [0x04, 0x28], // 'a' before Enter
    [0x28, 0x04], // Enter slot BEFORE 'a' — order must not drop data
  ]) {
    const scans: string[] = [];
    const assembler = createHidKeyboardScanAssembler({ onScan: (s) => scans.push(s) });
    assembler.pushReport([0, 0, slots[0]!, slots[1]!, 0, 0, 0, 0]);
    assert.deepEqual(scans, ['a'], `slots ${slots.join(',')}`);
  }
});

test('multiple data keys in one report are all captured before a later terminator', () => {
  const scans: string[] = [];
  const assembler = createHidKeyboardScanAssembler({ onScan: (s) => scans.push(s) });
  // 'a' + 'b' pressed in the same frame, released, then Enter.
  assembler.pushReport([0, 0, 0x04, 0x05, 0, 0, 0, 0]);
  assembler.pushReport([0, 0, 0, 0, 0, 0, 0, 0]);
  assembler.pushReport([0, 0, 0x28, 0, 0, 0, 0, 0]);
  assert.equal(scans.length, 1);
  assert.equal(scans[0]?.length, 2);
  assert.equal([...scans[0]!].sort().join(''), 'ab');
});

// ─── Phase 3D — device classification + default filtering ─────────

test('HID-POS usage page is classified SCANNER and recommended USE', () => {
  const safe = projectSafeHidDeviceInfo({
    vendorId: 0x05e0, productId: 0x1200, path: 'p',
    product: 'Symbol Bar Code Scanner', usagePage: 0x8c, usage: 0x02,
  });
  assert.equal(safe.category, 'SCANNER');
  assert.equal(safe.recommendation, 'USE');
  assert.equal(safe.defaultVisible, true);
});

test('scanner-named keyboard-class device is KEYBOARD_SCANNER with a TRY_HID_MODE warning', () => {
  const safe = projectSafeHidDeviceInfo({
    vendorId: 0x05e0, productId: 0x1300, path: 'p',
    product: 'Honeywell Barcode Scanner', usagePage: 0x01, usage: 0x06,
  });
  assert.equal(safe.category, 'KEYBOARD_SCANNER');
  assert.equal(safe.recommendation, 'TRY_HID_MODE');
  assert.equal(safe.keyboardClass, true);
  assert.equal(safe.defaultVisible, true);
});

test('plain keyboards, mice, and LED controllers are NOT recommended and hidden by default', () => {
  const keyboard = projectSafeHidDeviceInfo({
    vendorId: 0x1234, productId: 1, path: 'p',
    product: 'USB Keyboard', usagePage: 0x01, usage: 0x06,
  });
  assert.equal(keyboard.category, 'KEYBOARD');
  assert.equal(keyboard.defaultVisible, false);
  assert.equal(keyboard.recommendation, 'NOT_RECOMMENDED');

  const mouse = projectSafeHidDeviceInfo({
    vendorId: 0x1234, productId: 2, path: 'p',
    product: 'USB Optical Mouse', usagePage: 0x01, usage: 0x02,
  });
  assert.equal(mouse.category, 'POINTER');
  assert.equal(mouse.defaultVisible, false);

  const led = projectSafeHidDeviceInfo({
    vendorId: 0x0b05, productId: 0x18 , path: 'p',
    product: 'AURA LED Controller', manufacturer: 'ASUSTeK',
    usagePage: 0xff01, usage: 0x01,
  });
  assert.equal(led.category, 'SYSTEM_CONTROLLER');
  assert.equal(led.defaultVisible, false);
  assert.equal(led.recommendation, 'NOT_RECOMMENDED');

  const consumer = projectSafeHidDeviceInfo({
    vendorId: 0x046d, productId: 0xc52b, path: 'p',
    product: 'USB Receiver', usagePage: 0x0c, usage: 0x01,
  });
  assert.equal(consumer.category, 'SYSTEM_CONTROLLER');
  assert.equal(consumer.defaultVisible, false);
});

test('classification never exposes raw path or serial in its safe output', () => {
  const safe = projectSafeHidDeviceInfo({
    vendorId: 1, productId: 2,
    path: '\\\\?\\hid#vid_0001&pid_0002#secretpath',
    serialNumber: 'FULLSERIAL999', product: 'Scanner', usagePage: 0x8c, usage: 2,
  });
  const json = JSON.stringify(safe);
  assert.doesNotMatch(json, /secretpath/);
  assert.doesNotMatch(json, /FULLSERIAL999/);
});