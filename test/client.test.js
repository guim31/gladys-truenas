// -----------------------------------------------------------------------------
// The TrueNAS client (src/truenas/client.js) against the in-memory TrueNAS:
// one login per connection, kept between reads; a dropped connection or a
// forgotten session opened again once; a refused key, a self-signed
// certificate, a URL without the API; the methods of 25.04 and 25.10; a part
// refused without failing the read; the start and stop of an app or a VM.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, TruenasClient } from '../src/truenas/client.js';
import { API_KEY, FakeTruenas, URL_OF_NAS } from './helpers/fakeTruenas.js';

const client = (nas, options = {}) =>
  new TruenasClient({
    url: URL_OF_NAS,
    apiKey: API_KEY,
    insecure: true,
    open: nas.open,
    jobPollMs: 1,
    ...options,
  });

const methods = (nas) => nas.requests.map((r) => r.method);

test('one login, kept for the next reads', async () => {
  const nas = new FakeTruenas();
  const c = client(nas);
  const raw = await c.read({ disks: true, update: true });
  assert.equal(raw.info.version, '25.10.1');
  await c.read({ disks: false });
  await c.read({ disks: false });
  assert.equal(nas.logins, 1);
  assert.equal(nas.connections, 1);
  assert.equal(methods(nas).filter((m) => m === 'system.host_id').length, 1);
  assert.equal(methods(nas).filter((m) => m === 'disk.query').length, 1);
  assert.equal(methods(nas).filter((m) => m === 'update.status').length, 1);
  assert.deepEqual(raw.errors, {});
  c.close();
});

test('25.10: no SMART test, no check_available; 25.04: the legacy methods', async () => {
  const recent = new FakeTruenas();
  const raw = await client(recent).read({ disks: true, update: true });
  assert.ok(!methods(recent).includes('smart.test.results'));
  assert.ok(!methods(recent).includes('update.check_available'));
  assert.deepEqual(recent.requests.find((r) => r.method === 'disk.temperatures').params, [
    [],
    false,
  ]);
  assert.equal(raw.smart, undefined);

  const legacy = new FakeTruenas({ version: '25.04' });
  const old = await client(legacy).read({ disks: true, update: true });
  assert.ok(methods(legacy).includes('smart.test.results'));
  assert.ok(methods(legacy).includes('update.check_available'));
  assert.ok(!methods(legacy).includes('update.status'));
  // smartctl is told not to wake a disk asleep.
  const [names, options] = legacy.requests.find((r) => r.method === 'disk.temperatures').params;
  assert.deepEqual(names, ['sda', 'sdb', 'sdc', 'sdd', 'nvme0n1']);
  assert.equal(options.powermode, 'STANDBY');
  assert.equal(old.update.status, 'AVAILABLE');
  // container.query (26.0) is absent: no error for it.
  assert.deepEqual(old.errors, {});
});

test('a connection dropped between two reads is opened again, once', async () => {
  const nas = new FakeTruenas();
  const c = client(nas);
  await c.read({ disks: false });
  nas.dropConnections();
  await c.read({ disks: false });
  assert.equal(nas.connections, 2);
  assert.equal(nas.logins, 2);
});

test('a session the NAS forgot logs in again', async () => {
  const nas = new FakeTruenas();
  const c = client(nas);
  await c.read({ disks: false });
  nas.expireSessions();
  const raw = await c.read({ disks: false });
  assert.equal(raw.info.hostname, 'truenas');
  assert.equal(nas.logins, 2);
});

test('the errors of the connection, in kinds', async () => {
  const kinds = async (nas, options) => {
    try {
      await client(nas, options).read();
      return null;
    } catch (err) {
      return err.kind;
    }
  };
  assert.equal(await kinds(new FakeTruenas(), { apiKey: '7-wrong' }), ERROR_KINDS.AUTH);
  assert.equal(await kinds(new FakeTruenas(), { insecure: false }), ERROR_KINDS.CERTIFICATE);
  assert.equal(
    await kinds(new FakeTruenas({ selfSigned: false }), { insecure: false }),
    null,
    'a valid certificate needs no option',
  );
  const down = new FakeTruenas();
  down.failure = 'down';
  assert.equal(await kinds(down), ERROR_KINDS.UNREACHABLE);
  const notFound = new FakeTruenas();
  notFound.failure = 'notfound';
  assert.equal(await kinds(notFound), ERROR_KINDS.NOT_TRUENAS);
  const blind = new FakeTruenas();
  blind.denied.add('system.info');
  assert.equal(await kinds(blind), ERROR_KINDS.PERMISSION);
});

test('a part refused is left out with its reason, the read goes on', async () => {
  const nas = new FakeTruenas();
  nas.denied.add('app.query');
  nas.denied.add('virt.instance.query');
  const raw = await client(nas).read({ disks: true });
  assert.equal(raw.apps, null);
  assert.deepEqual(raw.errors, { apps: 'app.query: access denied' });
  assert.equal(raw.pools.length, 2);
});

test('start and stop: refused to a read-only key, done and waited for with the right role', async () => {
  const readonly = new FakeTruenas();
  await assert.rejects(client(readonly).run('app', 'nextcloud', 'start'), (err) => {
    assert.equal(err.kind, ERROR_KINDS.PERMISSION);
    return true;
  });
  assert.deepEqual(readonly.commands, []);

  const nas = new FakeTruenas({ role: 'control' });
  const c = client(nas);
  await c.run('app', 'nextcloud', 'start');
  await c.run('vm', 2, 'start');
  await c.run('vm', 1, 'stop');
  assert.deepEqual(nas.commands, ['app.start nextcloud', 'vm.start 2', 'vm.stop 1']);
  // The jobs were followed, the stop of a VM is the graceful one.
  assert.ok(methods(nas).includes('core.get_jobs'));
  const stop = nas.requests.find((r) => r.method === 'vm.stop');
  assert.deepEqual(stop.params, [1, { force: false, force_after_timeout: false }]);
});

test('restart and shutdown need a full administrator', async () => {
  const control = new FakeTruenas({ role: 'control' });
  await assert.rejects(
    client(control).power('restart'),
    (err) => err.kind === ERROR_KINDS.PERMISSION,
  );
  const admin = new FakeTruenas({ role: 'admin' });
  await client(admin).power('shutdown');
  assert.deepEqual(admin.commands, ['system.shutdown']);
  assert.equal(admin.requests.at(-1).params[0], 'Requested by a Gladys scene');
});
