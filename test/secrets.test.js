// -----------------------------------------------------------------------------
// The API key never leaves where it belongs: the Gladys configuration and the
// login call on the WebSocket. Not in the logs (at the most verbose level),
// not in the file under /data, not in anything sent to Gladys — whatever
// happens: login, dropped connection, expired session, refused key, NAS gone,
// connection test, widget, commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCENE_ACTIONS } from '../src/app.js';
import { WIDGET_KEY } from '../src/hub.js';
import { STATE_FILE } from '../src/store.js';
import { API_KEY, FakeTruenas } from './helpers/fakeTruenas.js';
import { captureLogs } from './helpers/logs.js';
import { CONFIG, createDevices, createWorld, tick } from './helpers/world.js';

test('the API key is never logged, sent to Gladys or written under /data', async () => {
  let world;
  const wrongKey = `${API_KEY}-typo`;
  const logs = (
    await captureLogs(async () => {
      world = await createWorld({
        nas: new FakeTruenas({ role: 'control' }),
        config: { ...CONFIG, allow_app_control: true, allow_power_actions: true },
      });
      await createDevices(world);
      world.nas.dropConnections();
      await tick(world);
      world.nas.expireSessions();
      await tick(world);
      world.nas.setPool('tank', { status: 'DEGRADED' });
      world.nas.addAlert({ id: 'x-1' });
      await tick(world);
      await world.fake.action('test_connection');
      await world.fake.widgetGet(WIDGET_KEY, { language: 'fr' });
      await world.fake.sceneAction(SCENE_ACTIONS.RESTART, {});
      world.nas.failure = 'down';
      world.nas.dropConnections();
      await tick(world);
      await tick(world);
      world.nas.failure = null;
      await world.fake.configUpdated({ ...CONFIG, api_key: wrongKey });
      await world.fake.action('test_connection');
      await world.app.stop();
    })
  ).join('\n');

  assert.ok(logs.length > 0, 'something was logged');
  assert.ok(world.nas.logins >= 4, 'several logins happened');
  const sentToGladys = JSON.stringify(world.fake.requests);
  const files = await readdir(world.dataDir);
  assert.deepEqual(files, [STATE_FILE]);
  const state = await readFile(join(world.dataDir, STATE_FILE), 'utf8');
  assert.ok(state.includes('x-1'), 'the state file was written');
  for (const secret of [API_KEY, wrongKey, API_KEY.slice(2)]) {
    assert.ok(!logs.includes(secret), 'the key is in the logs');
    assert.ok(!sentToGladys.includes(secret), 'the key was sent to Gladys');
    assert.ok(!state.includes(secret), 'the key is in the state file');
  }
  // The key travels only in the login call.
  const carrying = world.nas.requests.filter((r) => JSON.stringify(r.params).includes(API_KEY));
  assert.ok(carrying.every((r) => r.method === 'auth.login_with_api_key'));
});

test('a new key is checked for real: the open connection is not reused', async () => {
  const world = await createWorld();
  await world.fake.configUpdated({ ...CONFIG, api_key: `${API_KEY}-typo` });
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /API key refused/);
  await world.app.stop();
});
