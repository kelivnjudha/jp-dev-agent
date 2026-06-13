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
  assert.equal(status.hidReasonCode, 'SELECT_SCANNER');
  assert.equal(status.ready, true, 'wedge fallback keeps the terminal ready');
  assert.equal(status.captureSource, 'WEDGE');
  assert.deepEqual(fake.opened, [], 'no device auto-opened');
});

test('restorePreference reports absence when the preferred device is unplugged', async () => {
  const { manager } = createManager([]);
  const status = await manager.restorePreference({
    vendorId: 0x05e0,
    productId: 0x1200,
    product: null,
  });
  assert.equal(status.hidReasonCode, 'NO_SCANNER');
  assert.equal(status.mode, 'WEDGE');
  assert.equal(status.ready, true);
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


// ─── Phase 3E — watchdog reconnect + readiness ────────────────────

interface PendingTimer { id: number; cb: () => void | Promise<void>; ms: number; }

// The device 'error' callback fire-and-forgets an async disconnect
// handler (close → set state → schedule retry); flush several
// microtasks so it has fully settled before asserting.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function createWatchdogManager(initial: Array<Record<string, unknown>>) {
  let currentDevices = [...initial];
  const opened: string[] = [];
  const closed: string[] = [];
  const errorListeners = new Map<string, (err: unknown) => void>();
  const failOpenPaths = new Set<string>();
  const timers: PendingTimer[] = [];
  let nextId = 1;
  const mod = {
    devicesAsync: async () => [...currentDevices],
    HIDAsync: {
      open: async (path: string) => {
        if (failOpenPaths.has(path)) throw new Error('cannot open');
        opened.push(path);
        return {
          on(event: 'data' | 'error', listener: (arg: never) => void) {
            if (event === 'error') errorListeners.set(path, listener as (e: unknown) => void);
          },
          close() { closed.push(path); },
        };
      },
    },
  };
  const manager = new HidCaptureManager({
    submitScan: () => {},
    persistPreference: () => {},
    loadModule: async () => mod as never,
    platform: 'win32',
    setTimer: ((cb: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, cb, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimer: ((handle: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((t) => t.id === (handle as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    }),
  });
  return {
    manager, opened, closed, failOpenPaths,
    setDevices: (d: Array<Record<string, unknown>>) => { currentDevices = [...d]; },
    fireError: (path: string) => errorListeners.get(path)?.(new Error('disconnect')),
    runNextTimer: async () => {
      const t = timers.shift();
      if (t) { await t.cb(); await flushMicrotasks(); }
    },
    pendingTimers: () => timers.length,
    lastDelay: () => (timers.length ? timers[timers.length - 1]!.ms : null),
  };
}

test('a unique saved scanner auto-restores to a ready HID capture on startup', async () => {
  const wd = createWatchdogManager([KEYBOARD_INTERFACE, POS_INTERFACE]);
  const status = await wd.manager.restorePreference({
    vendorId: 0x05e0, productId: 0x1200, product: 'Symbol Bar Code Scanner',
  });
  assert.equal(status.mode, 'HID_RAW');
  assert.equal(status.hidState, 'CAPTURING');
  assert.equal(status.ready, true);
  assert.equal(status.captureSource, 'HID');
  assert.deepEqual(wd.opened, ['pos-interface-path']);
});

test('disconnect → watchdog reconnects the same scanner when it returns', async () => {
  const wd = createWatchdogManager([POS_INTERFACE]);
  const devices = await wd.manager.listDevices();
  const posKey = devices.find((d) => d.usagePage === 0x8c)!.key;
  const live = await wd.manager.selectDevice(posKey);
  assert.equal(live.hidState, 'CAPTURING');

  // Unplug: fire the device error → RECONNECTING + a scheduled retry.
  wd.fireError('pos-interface-path');
  await flushMicrotasks();
  const dropped = wd.manager.getStatus();
  assert.equal(dropped.hidState, 'RECONNECTING');
  assert.equal(dropped.reconnecting, true);
  assert.equal(dropped.ready, false);
  assert.equal(wd.pendingTimers(), 1);
  assert.equal(wd.lastDelay(), 2_000, 'first backoff is 2s');

  // Device still present → next tick reopens it.
  await wd.runNextTimer();
  const back = wd.manager.getStatus();
  assert.equal(back.hidState, 'CAPTURING');
  assert.equal(back.reconnecting, false);
  assert.equal(back.ready, true);
});

test('watchdog backs off while the scanner stays absent, then reconnects on return', async () => {
  const wd = createWatchdogManager([POS_INTERFACE]);
  const devices = await wd.manager.listDevices();
  const posKey = devices.find((d) => d.usagePage === 0x8c)!.key;
  await wd.manager.selectDevice(posKey);

  wd.setDevices([]); // unplugged before the error fires
  wd.fireError('pos-interface-path');
  await flushMicrotasks();
  assert.equal(wd.lastDelay(), 2_000);

  await wd.runNextTimer(); // still absent → back off to 5s
  assert.equal(wd.manager.getStatus().hidState, 'RECONNECTING');
  assert.equal(wd.lastDelay(), 5_000);

  await wd.runNextTimer(); // still absent → 10s
  assert.equal(wd.lastDelay(), 10_000);

  wd.setDevices([POS_INTERFACE]); // replugged
  await wd.runNextTimer();
  assert.equal(wd.manager.getStatus().hidState, 'CAPTURING');
  assert.equal(wd.pendingTimers(), 0, 'no further reconnect scheduled');
});

test('switching to wedge cancels the reconnect watchdog', async () => {
  const wd = createWatchdogManager([POS_INTERFACE]);
  const devices = await wd.manager.listDevices();
  const posKey = devices.find((d) => d.usagePage === 0x8c)!.key;
  await wd.manager.selectDevice(posKey);
  wd.setDevices([]);
  wd.fireError('pos-interface-path');
  await flushMicrotasks();
  assert.equal(wd.pendingTimers(), 1);

  const wedge = await wd.manager.useWedgeMode();
  assert.equal(wedge.mode, 'WEDGE');
  assert.equal(wedge.ready, true);
  assert.equal(wedge.reconnecting, false);
  assert.equal(wd.pendingTimers(), 0, 'watchdog timer cleared');
});

test('readiness status carries no raw path/serial even across reconnect', async () => {
  const wd = createWatchdogManager([{ ...POS_INTERFACE, serialNumber: 'SECRETSERIAL42' }]);
  const devices = await wd.manager.listDevices();
  const posKey = devices.find((d) => d.usagePage === 0x8c)!.key;
  await wd.manager.selectDevice(posKey);
  wd.fireError('pos-interface-path');
  await flushMicrotasks();
  await wd.runNextTimer();
  const json = JSON.stringify({ devices, status: wd.manager.getStatus() });
  assert.doesNotMatch(json, /pos-interface-path/);
  assert.doesNotMatch(json, /SECRETSERIAL42/);
});