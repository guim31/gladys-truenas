// -----------------------------------------------------------------------------
// The integration refreshes on its own: the devices are published with
// should_poll: false and the hub reads the NAS on its own timer, without
// Gladys ever calling onPoll (Gladys#3198). An unchanged value is still sent
// again well within the 12 hours after which the dashboard would end up
// showing "no recent value".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { DEVICE_TYPES } from '../src/devices.js';
import { HUB_TIMINGS } from '../src/hub.js';
import { createDevices, createWorld, featureId } from './helpers/world.js';

const MINUTE = 60_000;

/** Lets the timer's reads (promises on the fake socket) settle. */
async function settle() {
  for (let i = 0; i < 40; i += 1) {
    await flush();
  }
}

test('the hub reads the NAS on its own timer, without onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 14, 10) });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.ok(world.fake.discoveredDevices.every((device) => device.should_poll === false));
  // From here on, nothing calls onPoll (world.fake.poll): only the timer runs.
  const cpu = featureId(world.gladys, DEVICE_TYPES.NAS, null, 'cpu');
  const reads = () => world.nas.requests.filter((r) => r.method === 'system.info').length;
  for (const value of [33.3, 44.4, 55.5]) {
    const before = reads();
    world.nas.setCpu(value);
    t.mock.timers.tick(MINUTE); // poll_interval: 60 s
    await settle();
    assert.ok(reads() > before, 'the NAS was read by the timer');
    assert.equal(world.fake.lastState(cpu), value);
  }
});

test('an unchanged value is sent again at least every 12 hours', async (t) => {
  assert.ok(HUB_TIMINGS.heartbeatMs <= 12 * 3600_000);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 14, 10) });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  const cpu = featureId(world.gladys, DEVICE_TYPES.NAS, null, 'cpu');
  const sent = () =>
    world.fake.states.filter((state) => state.device_feature_external_id === cpu).length;

  const first = sent();
  // Nothing changes on the NAS for 12 hours, read every minute.
  for (let minute = 0; minute < 12 * 60; minute += 1) {
    t.mock.timers.tick(MINUTE);
    await settle();
  }
  assert.ok(sent() - first >= 2, `cpu sent ${sent() - first} time(s) in 12 h`);
  assert.ok(sent() - first <= 3, 'only the heartbeat, not every read');
});
