import assert from 'node:assert/strict';
import test from 'node:test';

import { HidCaptureManager } from './main/hid-capture.js';

type Listener = (data: Buffer) => void;

function fakeHidModule(devices: Array<Record<string, unknown>>, options: {
  failOpenPaths?: Set<string>;
} = {}) {
  const opened: string[] = [];
  const listeners = new Map<string, Listener>();
  const closed: string[] = [];
  const mod = {
    devicesAsync: async () => devices,
    HIDAsync: {
      open: async (path: string) => {
        if (options.failOpenPaths?.has(path)) {
          throw new Error('cannot open');
        }
        opened.push(path);
        return {
          on(event: 'data' | 'error', listener: (arg: never) => void) {
            if (event === 'data') listeners.set(path, listener as Listener);
          },
          close() {
            closed.push(path);
          },
        };
      },
    },
  };
  return { mod, opened, closed, listeners };
}

const POS_INTERFACE = {
  vendorId: 0x05e0,
  productId: 0x1200,
  path: 'pos-interface-path',
  product: 'Symbol Bar Code Scanner',
  usagePage: 0x8c,
  usage: 0x02,
};

const KEYBOARD_INTERFACE = {
  vendorId: 0x05e0,
  productId: 0x1200,
  path: 'keyboard-interface-path',
  product: 'Symbol Bar Code Scanner',
  usagePage: 0x01,
  usage: 0x06,
};

function createManager(
  devices: Array<Record<string, unknown>>,
  options: { failOpenPaths?: Set<string> } = {},
) {
  const fake = fakeHidModule(devices, options);
  const scans: string[] = [];
  const persisted: unknown[] = [];
  const manager = new HidCaptureManager({
    submitScan: (assembled) => {
      scans.push(assembled);
    },
    persistPreference: (preference) => {
      persisted.push(preference);
    },
    loadModule: async () => fake.mod as never,
    platform: 'win32',
  });
  return { manager, fake, scans, persisted };
}

test('select + scan: HID reports flow through the assembler into submitScan', async () => {
  const { manager, fake, scans, persisted } = createManager([POS_INTERFACE]);
  const devices = await manager.listDevices();
  assert.equal(devices.length, 1);
  const status = await manager.selectDevice(devices[0]!.key);
  assert.equal(status.mode, 'HID_RAW');
  assert.equal(status.hidState, 'CAPTURING');
  assert.equal(persisted.length, 1);

  const push = fake.listeners.get('pos-interface-path');
  assert.ok(push, 'data listener registered');
  // 'a','b','c' then Enter — boot-protocol single-key reports.
  for (const usage of [0x04, 0x05, 0x06, 0x28]) {
    push!(Buffer.from([0, 0, usage, 0, 0, 0, 0, 0]));
    push!(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));
  }
  assert.deepEqual(scans, ['abc']);
});

test('open failure surfaces a safe reason code and keeps wedge mode', async () => {
  const { manager } = createManager([KEYBOARD_INTERFACE], {
    failOpenPaths: new Set(['keyboard-interface-path']),
  });
  const devices = await manager.listDevices();
  const status = await manager.selectDevice(devices[0]!.key);
  assert.equal(status.mode, 'WEDGE');
  assert.equal(status.hidState, 'ERROR');
  assert.equal(status.hidReasonCode, 'HID_OPEN_BLOCKED_OR_BUSY');
});

test('restorePreference prefers the scanner-class interface of a dual-interface device', async () => {
  const { manager, fake } = createManager([KEYBOARD_INTERFACE, POS_INTERFACE]);
  const status = await manager.restorePreference({
    vendorId: 0x05e0,
    productId: 0x1200,
    product: 'Symbol Bar Code Scanner',
  });
  assert.equal(status.mode, 'HID_RAW');
  assert.equal(status.hidState, 'CAPTURING');
  assert.deepEqual(fake.opened, ['pos-interface-path']);
  assert.equal(status.selectedDevice?.product, 'Symbol Bar Code Scanner');
});

test('restorePreference refuses to auto-pick between two identical scanner units', async () => {
  const unitA = { ...POS_INTERFACE, path: 'unit-a-path' };
  const unitB = { ...POS_INTERFACE, path: 'unit-b-path' };
  const { manager, fake } = createManager([unitA, unitB]);
  const status = await manager.restorePreference({
    vendorId: 0x05e0,
    productId: 0x1200,
    product: 'Symbol Bar Code Scanner',
  });
  assert.equal(status.mode, 'WEDGE');
  assert.equal(status.hidReasonCode, 'HID_MULTIPLE_MATCHES');
  assert.deepEqual(fake.opened, [], 'no device auto-opened');
});

test('restorePreference reports absence when the preferred device is unplugged', async () => {
  const { manager } = createManager([]);
  const status = await manager.restorePreference({
    vendorId: 0x05e0,
    productId: 0x1200,
    product: null,
  });
  assert.equal(status.hidReasonCode, 'HID_PREFERRED_DEVICE_ABSENT');
  assert.equal(status.mode, 'WEDGE');
});

test('wedge fallback closes the open device and persists the mode', async () => {
  const { manager, fake, persisted } = createManager([POS_INTERFACE]);
  const devices = await manager.listDevices();
  await manager.selectDevice(devices[0]!.key);
  const status = await manager.useWedgeMode();
  assert.equal(status.mode, 'WEDGE');
  assert.deepEqual(fake.closed, ['pos-interface-path']);
  assert.equal(persisted.length, 2);
});

test('status and device list never carry raw paths or full serials', async () => {
  const { manager } = createManager([
    { ...POS_INTERFACE, serialNumber: 'FULLSERIAL12345' },
  ]);
  const devices = await manager.listDevices();
  const status = await manager.selectDevice(devices[0]!.key);
  const exposed = JSON.stringify({ devices, status });
  assert.doesNotMatch(exposed, /pos-interface-path/);
  assert.doesNotMatch(exposed, /FULLSERIAL12345/);
  assert.match(exposed, /FU••••/);
});
