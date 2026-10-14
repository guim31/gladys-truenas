// -----------------------------------------------------------------------------
// The hub (src/hub.js) through the SDK's fake Gladys: discovery, states after
// "Add to Gladys", the scene triggers (pool degraded, new alert) fired on
// transitions only and remembered across restarts, a NAS lost and back, a
// refused key never retried on the timer, the Start / stop switch gated by
// the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TYPES } from '../src/devices.js';
import { MAX_ALERT_EVENTS_PER_READ, TRIGGERS } from '../src/hub.js';
import { FakeTruenas } from './helpers/fakeTruenas.js';
import { CONFIG, createDevices, createWorld, deviceId, featureId, tick } from './helpers/world.js';

const POOL_TANK = '8811223344556677001';

test('discovery: nothing created on the user’s behalf, should_poll false', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.equal(world.fake.devices.length, 0);
  assert.ok(world.fake.discoveredDevices.every((d) => d.should_poll === false));
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('a device added gets its states at once, and its badge', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const before = world.fake.states.length;
  await createDevices(
    world,
    (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.POOL, POOL_TANK),
  );
  assert.ok(world.fake.states.length > before);
  assert.equal(
    world.fake.lastState(featureId(world.gladys, DEVICE_TYPES.POOL, POOL_TANK, 'state')),
    'Online',
  );
  // The fixture scrub ended 5 days before 1792000000000 (2026-10-14T17:46:40Z).
  const days = Math.floor((world.clock.now() - (1792000000000 - 5 * 86400_000)) / 86400_000);
  assert.equal(
    world.fake.lastState(featureId(world.gladys, DEVICE_TYPES.POOL, POOL_TANK, 'last_scrub')),
    days,
  );
  assert.ok(world.fake.transports.some((e) => e.transport === 'local'));
});

test('pool degraded: fired on the transition only, again when it gets worse', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fired = () => world.fake.sceneEvents.filter((e) => e.key === TRIGGERS.POOL);
  await tick(world);
  assert.equal(fired().length, 0, 'nothing at the start');
  world.nas.setPool('tank', { status: 'DEGRADED', healthy: false });
  await tick(world);
  await tick(world);
  assert.equal(fired().length, 1);
  assert.deepEqual(fired()[0].data, {
    pool: deviceId(world.gladys, DEVICE_TYPES.POOL, POOL_TANK),
    nas_name: 'truenas',
    pool_name: 'tank',
    state: 'Degraded',
  });
  world.nas.setPool('tank', { status: 'FAULTED' });
  await tick(world);
  assert.equal(fired().length, 2);
  world.nas.setPool('tank', { status: 'DEGRADED' });
  await tick(world);
  assert.equal(fired().length, 2, 'getting better is not announced');
  world.nas.setPool('tank', { status: 'ONLINE', healthy: true });
  await tick(world);
  world.nas.setPool('tank', { status: 'ONLINE', healthy: false });
  await tick(world);
  assert.equal(fired().length, 3, 're-armed, errors on an online pool count');
  assert.equal(fired()[2].data.state, 'Errors');
});

test('new alert: once per alert, with level and text; dismissed and known alerts are silent', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, language: 'fr' } });
  t.after(() => world.app.stop());
  const fired = () => world.fake.sceneEvents.filter((e) => e.key === TRIGGERS.ALERT);
  await tick(world);
  assert.equal(fired().length, 0, 'the alerts present at the start are not news');
  world.nas.addAlert({
    id: 'a-1',
    level: 'CRITICAL',
    klass: 'SMARTUncorrectedErrors',
    formatted: 'Device: /dev/sdc [SAT], 8 Currently unreadable (pending) sectors.',
  });
  await tick(world);
  await tick(world);
  assert.equal(fired().length, 1);
  assert.deepEqual(fired()[0].data, {
    level: 'critical',
    nas_name: 'truenas',
    text: 'Device: /dev/sdc [SAT], 8 Currently unreadable (pending) sectors.',
    alert_class: 'SMARTUncorrectedErrors',
  });
  // The disk named by the alert shows it.
  const disk = featureId(world.gladys, DEVICE_TYPES.DISK, 'TESTDISK0003', 'alert');
  await createDevices(
    world,
    (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.DISK, 'TESTDISK0003'),
  );
  world.clock.advance(5 * 60_000);
  await tick(world);
  assert.equal(world.fake.lastState(disk), 1);
});

test('an alert storm announces a bounded number of alerts', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (let i = 0; i < 30; i += 1) {
    world.nas.addAlert({ id: `storm-${i}` });
  }
  await tick(world);
  assert.equal(
    world.fake.sceneEvents.filter((e) => e.key === TRIGGERS.ALERT).length,
    MAX_ALERT_EVENTS_PER_READ,
  );
});

test('a restart neither repeats an announcement nor misses one', async () => {
  const first = await createWorld();
  first.nas.addAlert({ id: 'before-restart' });
  await tick(first);
  assert.equal(first.fake.sceneEvents.length, 1);
  await first.app.stop();

  // Same /data, same NAS: the known alert is not news, a new one is.
  first.nas.addAlert({ id: 'during-restart' });
  first.nas.setPool('tank', { status: 'DEGRADED' });
  const second = await createWorld({ nas: first.nas, dataDir: first.dataDir });
  const keys = second.fake.sceneEvents.map((e) => [e.key, e.data.text ?? e.data.pool_name]);
  assert.deepEqual(keys, [
    [TRIGGERS.POOL, 'tank'],
    [TRIGGERS.ALERT, 'Something happened.'],
  ]);
  await second.app.stop();
});

test('a NAS lost: offline after two failed reads, online again when back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world, (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.NAS));
  const online = featureId(world.gladys, DEVICE_TYPES.NAS, null, 'online');
  assert.equal(world.fake.lastState(online), 1);
  world.nas.failure = 'down';
  world.nas.dropConnections();
  await tick(world);
  assert.equal(world.fake.lastState(online), 1, 'one failure is a blip');
  await tick(world);
  assert.equal(world.fake.lastState(online), 0);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /does not answer/);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  world.nas.failure = null;
  await tick(world);
  assert.equal(world.fake.lastState(online), 1);
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('a refused key is not retried on the timer, but on a manual request', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, api_key: '7-wrong-key' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /API key refused/);
  assert.equal(world.nas.failedLogins, 1);
  await tick(world);
  await tick(world);
  assert.equal(world.nas.failedLogins, 1, 'the timer does not try again');
  await world.fake.action('test_connection');
  assert.equal(world.nas.failedLogins, 2);
  await world.fake.configUpdated({ ...CONFIG });
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('plain HTTP is refused before anything is sent', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, address: 'http://192.0.2.20' } });
  t.after(() => world.app.stop());
  assert.equal(world.nas.connections, 0);
  assert.match(world.fake.connectionStatus.message.en, /HTTPS only/);
});

test('the Start / stop switch: absent by default, refused when the option is off', async (t) => {
  const world = await createWorld({ nas: new FakeTruenas({ role: 'control' }) });
  t.after(() => world.app.stop());
  const app = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.APP, 'app-nextcloud'),
  );
  assert.deepEqual(
    app.features.map((f) => f.external_id.split(':').at(-1)),
    ['running', 'state', 'update_available'],
  );
  assert.ok(app.features.every((f) => f.read_only));

  // The option turned on: the switch appears (Update in the Discover tab).
  await world.fake.configUpdated({ ...CONFIG, allow_app_control: true });
  const withSwitch = world.fake.discoveredDevices.find((d) => d.external_id === app.external_id);
  const power = withSwitch.features.find((f) => f.external_id.endsWith(':power'));
  assert.equal(power.category, 'switch');
  assert.equal(power.read_only, false);
  await world.fake.deviceCreated(withSwitch);
  const ack = await world.fake.setValue(withSwitch, power, 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.nas.commands, ['app.start nextcloud']);
  assert.equal(
    world.fake.lastState(featureId(world.gladys, DEVICE_TYPES.APP, 'app-nextcloud', 'running')),
    1,
  );

  // Turned off again: the switch of the device already created is refused.
  await world.fake.configUpdated({ ...CONFIG, allow_app_control: false });
  const refused = await world.fake.setValue(withSwitch, power, 0);
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /disabled in the configuration/);
  assert.deepEqual(world.nas.commands, ['app.start nextcloud']);
});

test('the switch with a read-only key: TrueNAS refuses, the user is told why', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, allow_app_control: true } });
  t.after(() => world.app.stop());
  const vm = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.VM, 'vm-2'),
  );
  await world.fake.deviceCreated(vm);
  const power = vm.features.find((f) => f.external_id.endsWith(':power'));
  const ack = await world.fake.setValue(vm, power, 1);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /lacks a right/);
  assert.deepEqual(world.nas.commands, []);
});

test('25.04: an Incus instance is started with its own method', async (t) => {
  const world = await createWorld({
    nas: new FakeTruenas({ version: '25.04', role: 'control' }),
    config: { ...CONFIG, allow_app_control: true },
  });
  t.after(() => world.app.stop());
  const instance = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.VM, 'instance-pihole'),
  );
  assert.equal(instance.model, 'Container');
  await world.fake.deviceCreated(instance);
  const power = instance.features.find((f) => f.external_id.endsWith(':power'));
  assert.equal((await world.fake.setValue(instance, power, 1)).success, true);
  assert.deepEqual(world.nas.commands, ['virt.instance.start pihole']);
});

test('the update check runs every 6 hours only; the disks every 5 minutes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const count = (method) => world.nas.requests.filter((r) => r.method === method).length;
  assert.equal(count('update.status'), 1);
  assert.equal(count('disk.query'), 1);
  for (let i = 0; i < 4; i += 1) {
    world.clock.advance(60_000);
    await tick(world);
  }
  assert.equal(count('update.status'), 1);
  assert.equal(count('disk.query'), 1);
  world.clock.advance(60_000);
  await tick(world);
  assert.equal(count('disk.query'), 2);
  world.clock.advance(6 * 3600_000);
  await tick(world);
  assert.equal(count('update.status'), 2);
  // The update stays known between two checks.
  const update = featureId(world.gladys, DEVICE_TYPES.NAS, null, 'update_available');
  await createDevices(world, (d) => d.external_id === deviceId(world.gladys, DEVICE_TYPES.NAS));
  assert.equal(world.fake.lastState(update), 1);
});

test('no host id yet: nothing is published under a makeshift id', async (t) => {
  const nas = new FakeTruenas();
  nas.denied.add('system.host_id');
  const world = await createWorld({ nas });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 0);
  assert.equal(world.fake.connectionStatus.connected, true);
  nas.denied.delete('system.host_id');
  await tick(world);
  assert.ok(world.fake.discoveredDevices.length > 0);
  assert.ok(
    world.fake.discoveredDevices.every((d) => d.external_id.includes(`:${'5f2b9c1e8a7d6043'}`)),
  );
});
