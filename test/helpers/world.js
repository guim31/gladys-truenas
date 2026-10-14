// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake TrueNAS behind the
// socket seam, a temporary /data and a manual clock, with the integration
// wired on top through registerHandlers. No timer runs unless asked
// (`timers: true`, under mocked timers): the tests read the NAS with
// `tick(world)`. (Adapted from guim31/gladys-qnap.)
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { deviceIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { API_KEY, FakeTruenas, HOST_ID } from './fakeTruenas.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const NAS_ID = HOST_ID;

export const CONFIG = {
  address: '192.0.2.20',
  api_key: API_KEY,
  accept_self_signed: true,
  poll_interval: '60',
  allow_app_control: false,
  allow_power_actions: false,
  language: 'en',
};

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = Date.UTC(2026, 9, 14, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * @param {object} [options]
 * @param {FakeTruenas} [options.nas]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers] the hub's own timers (mock them first)
 */
export async function createWorld({
  clock = createClock(),
  nas = new FakeTruenas(),
  config = CONFIG,
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-truenas-')),
  timings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    open: nas.open,
    timers,
    timings,
    now: clock.now,
    client: { jobPollMs: 1 },
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, nas, app, hub: app.hub, clock, dataDir };
}

/** External id of a device: the NAS (`key` omitted), a pool, a disk, an app, a VM. */
export const deviceId = (gladys, type, key = null) => deviceIds(gladys, type, NAS_ID, key).device;

export const featureId = (gladys, type, key, feature) =>
  deviceIds(gladys, type, NAS_ID, key).feature(feature);

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

/** One read of the NAS, as the timer does. */
export async function tick(world) {
  await world.hub.afterChanges(await world.hub.poll());
}
