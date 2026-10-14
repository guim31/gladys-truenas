// -----------------------------------------------------------------------------
// The answers of the TrueNAS API -> snapshot (src/truenas/model.js), on the
// fixtures of test/fixtures/truenas: 25.10 and 25.04, the space of a pool as
// the user sees it, the last scrub, the SMART state from a failed self-test
// (25.04) or from a SMART alert (25.10), apps, VMs and Incus instances, the
// update offered.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dateOf,
  isLegacy,
  parseSnapshot,
  parseVersion,
  poolState,
  safeKey,
} from '../src/truenas/model.js';

const fixture = (version, name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/truenas/${version}/${name}.json`, import.meta.url), 'utf8'),
  );

function raw2510(overrides = {}) {
  const f = (name) => fixture('25.10', name);
  return {
    info: f('system.info'),
    hostId: f('system.host_id'),
    stats: [...f('reporting.cpu'), ...f('reporting.memory'), ...f('reporting.cputemp')],
    alerts: f('alert.list'),
    pools: f('pool.query'),
    datasets: f('pool.dataset.query'),
    apps: f('app.query'),
    vms: f('vm.query'),
    instances: f('virt.instance.query'),
    containers: null,
    disks: f('disk.query'),
    temperatures: f('disk.temperatures'),
    update: f('update.status'),
    errors: {},
    ...overrides,
  };
}

test('versions: 25.04 is the legacy API, 25.10 and 26.0 are not', () => {
  assert.deepEqual(parseVersion('25.10.1'), { major: 25, minor: 10 });
  assert.deepEqual(parseVersion('TrueNAS-SCALE-24.10.2'), { major: 24, minor: 10 });
  assert.equal(isLegacy('25.04.2.6'), true);
  assert.equal(isLegacy('25.10.0'), false);
  assert.equal(isLegacy('26.0.0-BETA.3'), false);
  assert.equal(dateOf({ $date: 1000 }), 1000);
  assert.equal(dateOf(null), null);
  assert.equal(safeKey('{serial_lunid}AB 12/x'), '_serial_lunid_AB_12_x');
});

test('the NAS: identity, version, CPU, memory, temperature, uptime, alerts, update', () => {
  const s = parseSnapshot(raw2510());
  assert.equal(s.platformId, '5f2b9c1e8a7d6043');
  assert.equal(s.name, 'truenas');
  assert.equal(s.version, '25.10.1');
  assert.equal(s.legacy, false);
  assert.equal(s.cpu, 14.6);
  // 32 GiB, 22573744128 bytes available.
  assert.equal(Math.round(s.memory * 10) / 10, 34.3);
  assert.equal(s.cpuTemperature, 45);
  assert.equal(Math.round(s.uptime), 176523);
  // The dismissed alert does not count.
  assert.deepEqual(
    s.alerts.map((a) => [a.level, a.klass]),
    [['info', 'HasUpdate']],
  );
  assert.equal(s.alertLevel, 'info');
  assert.deepEqual(s.update, { version: '25.10.2' });
});

test('no active alert: level none; alerts not read: unknown', () => {
  assert.equal(parseSnapshot(raw2510({ alerts: [] })).alertLevel, 'none');
  const s = parseSnapshot(raw2510({ alerts: null }));
  assert.equal(s.alerts, null);
  assert.equal(s.alertLevel, null);
});

test('pools: space of the root dataset, state, last scrub and its errors', () => {
  const [tank, backup] = parseSnapshot(raw2510()).pools;
  assert.equal(tank.key, '8811223344556677001');
  assert.equal(tank.state, 'online');
  assert.equal(tank.used, 5331486070784);
  assert.equal(tank.free, 5331486070784);
  assert.equal(tank.percent, 50);
  assert.equal(tank.scrubErrors, 0);
  assert.equal(tank.lastScrubAt, 1792000000000 - 5 * 86400000);
  assert.equal(Math.round(backup.percent), 90);
  assert.equal(backup.scrubErrors, 2);
  // Without the datasets: the raw sizes of the pool.
  const raw = parseSnapshot(raw2510({ datasets: null })).pools[0];
  assert.equal(raw.total, 15994458210304);
});

test('pool states: degraded, faulted, online with errors, a scrub running', () => {
  assert.equal(poolState({ status: 'DEGRADED', healthy: false }), 'degraded');
  assert.equal(poolState({ status: 'ONLINE', healthy: false }), 'errors');
  assert.equal(poolState({ status: 'SUSPENDED' }), 'suspended');
  assert.equal(poolState({ status: 'SOMETHING' }), 'unknown');
  const pools = fixture('25.10', 'pool.query');
  pools[0].scan = { ...pools[0].scan, state: 'SCANNING', end_time: null };
  const [tank] = parseSnapshot(raw2510({ pools })).pools;
  assert.equal(tank.scrubbing, true);
  assert.equal(tank.lastScrubAt, null);
});

test('disks: serial as key, temperatures by name, SMART alert of 25.10', () => {
  const alerts = fixture('25.10', 'alert.list');
  alerts.push({
    uuid: 'smart-1',
    klass: 'SMARTUncorrectedErrors',
    level: 'CRITICAL',
    formatted: 'Device: /dev/sdc [SAT], 8 Currently unreadable (pending) sectors.',
    args: { device: '/dev/sdc [SAT]', message: '8 Currently unreadable (pending) sectors.' },
    dismissed: false,
  });
  const disks = parseSnapshot(raw2510({ alerts })).disks;
  assert.deepEqual(
    disks.map((d) => [d.key, d.temperature, d.state]),
    [
      ['TESTDISK0001', 35, 'ok'],
      ['TESTDISK0002', 36, 'ok'],
      ['TESTDISK0003', 38, 'warning'],
      ['TESTDISK0004', 33, 'ok'],
      ['TESTDISK0005', 41.85, 'ok'],
    ],
  );
});

test('disks with the same serial (a USB bridge) are known by their identifier', () => {
  const rows = fixture('25.10', 'disk.query');
  rows[0].serial = 'SAME';
  rows[1].serial = 'SAME';
  const [a, b, c] = parseSnapshot(raw2510({ disks: rows })).disks;
  assert.notEqual(a.key, b.key);
  assert.match(a.key, /^_serial_lunid_/);
  assert.equal(c.key, 'TESTDISK0003');
});

test('25.04: failed SMART self-test, check_available, Incus instances', () => {
  const s = parseSnapshot(
    raw2510({
      info: fixture('25.04', 'system.info'),
      smart: fixture('25.04', 'smart.test.results'),
      update: fixture('25.04', 'update.check_available'),
      instances: fixture('25.04', 'virt.instance.query'),
    }),
  );
  assert.equal(s.legacy, true);
  assert.deepEqual(
    s.disks.map((d) => d.state),
    ['ok', 'failed', 'ok', 'ok', 'ok'],
  );
  assert.deepEqual(s.update, { version: '25.04.2.7' });
  assert.deepEqual(
    s.vms.map((v) => [v.key, v.kind, v.state, v.running, Boolean(v.container)]),
    [
      ['vm-1', 'vm', 'running', true, false],
      ['vm-2', 'vm', 'stopped', false, false],
      ['instance-homeassistant', 'instance', 'running', true, false],
      ['instance-pihole', 'instance', 'stopped', false, true],
    ],
  );
});

test('update: up to date, unknown, error', () => {
  const upToDate = { code: 'NORMAL', error: null, status: { new_version: null } };
  assert.equal(parseSnapshot(raw2510({ update: upToDate })).update, null);
  assert.equal(parseSnapshot(raw2510({ update: undefined })).update, undefined);
  const failed = { code: 'ERROR', status: null, error: { errname: 'ETIMEDOUT' } };
  assert.equal(parseSnapshot(raw2510({ update: failed })).update, undefined);
  assert.equal(parseSnapshot(raw2510({ update: { status: 'UNAVAILABLE' } })).update, null);
});

test('apps: state, running, update (chart or image)', () => {
  assert.deepEqual(
    parseSnapshot(raw2510()).apps.map((a) => [a.key, a.state, a.running, a.update]),
    [
      ['jellyfin', 'running', true, true],
      ['nextcloud', 'stopped', false, false],
      ['home-assistant', 'running', true, true],
    ],
  );
  assert.equal(parseSnapshot(raw2510({ apps: null })).apps, null);
});

test('reporting graphs missing: no CPU, memory or temperature, the rest is read', () => {
  const s = parseSnapshot(raw2510({ stats: [] }));
  assert.equal(s.cpu, null);
  assert.equal(s.memory, null);
  assert.equal(s.cpuTemperature, null);
  assert.equal(s.pools.length, 2);
});

test('a placeholder product name of the board is not a model', () => {
  const info = { ...fixture('25.04', 'system.info') };
  assert.equal(parseSnapshot(raw2510({ info })).product, null);
  assert.equal(parseSnapshot(raw2510()).product, 'X11SCL-F');
});
