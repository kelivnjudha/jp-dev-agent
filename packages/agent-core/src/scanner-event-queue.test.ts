import assert from 'node:assert/strict';
import test from 'node:test';

import { createScannerEventQueue, type ScannerQueueEvent } from './index.js';

function scanEvent(overrides: Partial<ScannerQueueEvent> = {}): ScannerQueueEvent {
  return {
    type: 'SCAN',
    scanId: `scan-${Math.abs(overrides.valueLength ?? 13)}-${overrides.scanId ?? 'a'}`,
    capturedAt: '2026-06-12T10:00:00.000Z',
    source: 'WEDGE',
    symbology: 'EAN13',
    value: '4006381333931',
    valueLength: 13,
    valueHashPrefix: 'abcd1234',
    ...overrides,
  };
}

test('push + listAfter(0) delivers the event and advances the cursor', () => {
  const queue = createScannerEventQueue();
  queue.push(scanEvent({ scanId: 'one' }));
  const batch = queue.listAfter(0);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0]?.scanId, 'one');
  assert.equal(batch.cursor, 1);
});

test('cursor returns only newer events', () => {
  const queue = createScannerEventQueue();
  queue.push(scanEvent({ scanId: 'one' }));
  queue.push(scanEvent({ scanId: 'two' }));
  const first = queue.listAfter(0);
  assert.equal(first.events.length, 2);
  const second = queue.listAfter(first.cursor);
  assert.equal(second.events.length, 0);
  assert.equal(second.cursor, first.cursor);
  queue.push(scanEvent({ scanId: 'three' }));
  const third = queue.listAfter(first.cursor);
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0]?.scanId, 'three');
});

test('reads are non-destructive — a reconnect redelivers the same scanIds for dedupe', () => {
  const queue = createScannerEventQueue();
  queue.push(scanEvent({ scanId: 'dup' }));
  const a = queue.listAfter(0);
  const b = queue.listAfter(0);
  assert.deepEqual(
    a.events.map((event) => event.scanId),
    b.events.map((event) => event.scanId),
  );
});

test('TTL expiry removes old events (and their raw values) from memory', () => {
  let nowMs = 1_000_000;
  const queue = createScannerEventQueue({ ttlMs: 30_000, now: () => nowMs });
  queue.push(scanEvent({ scanId: 'old' }));
  nowMs += 30_001;
  const batch = queue.listAfter(0);
  assert.equal(batch.events.length, 0);
  assert.equal(queue.size(), 0);
});

test('queue is bounded to maxEvents (oldest dropped first)', () => {
  const queue = createScannerEventQueue({ maxEvents: 3 });
  for (let index = 1; index <= 5; index += 1) {
    queue.push(scanEvent({ scanId: `s${index}` }));
  }
  const batch = queue.listAfter(0);
  assert.equal(batch.events.length, 3);
  assert.deepEqual(
    batch.events.map((event) => event.scanId),
    ['s3', 's4', 's5'],
  );
});

test('a cursor beyond the latest sequence snaps back after an agent restart', () => {
  const queue = createScannerEventQueue();
  queue.push(scanEvent({ scanId: 'fresh' }));
  // Consumer kept cursor=500 from a previous agent run.
  const batch = queue.listAfter(500);
  assert.equal(batch.events.length, 0);
  assert.equal(batch.cursor, 1);
  queue.push(scanEvent({ scanId: 'after-restart' }));
  const next = queue.listAfter(batch.cursor);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0]?.scanId, 'after-restart');
});

test('waitForAfter resolves early when a scan is pushed mid-wait', async () => {
  const queue = createScannerEventQueue();
  const pending = queue.waitForAfter(0, 1_000);
  setTimeout(() => {
    queue.push(scanEvent({ scanId: 'live' }));
  }, 20);
  const startedAt = Date.now();
  const batch = await pending;
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0]?.scanId, 'live');
  assert.ok(Date.now() - startedAt < 900, 'resolved before the full wait');
});

test('waitForAfter times out empty when nothing is scanned', async () => {
  const queue = createScannerEventQueue();
  const batch = await queue.waitForAfter(0, 40);
  assert.equal(batch.events.length, 0);
});
