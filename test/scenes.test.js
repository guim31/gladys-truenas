// -----------------------------------------------------------------------------
// The two scene actions, restart and shut down: refused while the option of
// the configuration is off (the default), refused when the NAS is not
// connected, sent once allowed, and reported in words when TrueNAS refuses a
// key that is not a full administrator's. Nothing reaches the NAS before the
// user ticked the option.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_ACTIONS } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { FakeTruenas } from './helpers/fakeTruenas.js';
import { CONFIG, createWorld } from './helpers/world.js';

const ALLOWED = { ...CONFIG, allow_power_actions: true };

test('off by default: both actions refused, nothing sent to the NAS', async (t) => {
  assert.equal(DEFAULT_CONFIG.allow_power_actions, false);
  const world = await createWorld({
    nas: new FakeTruenas({ role: 'admin' }),
    config: { ...CONFIG, allow_power_actions: undefined },
  });
  t.after(() => world.app.stop());
  for (const key of Object.values(SCENE_ACTIONS)) {
    const ack = await world.fake.sceneAction(key, {});
    assert.equal(ack.success, false, key);
    assert.match(String(ack.error), /disabled in the configuration/);
  }
  assert.deepEqual(world.nas.commands, []);
});

test('allowed: restart and shutdown are sent', async (t) => {
  const world = await createWorld({ nas: new FakeTruenas({ role: 'admin' }), config: ALLOWED });
  t.after(() => world.app.stop());
  assert.equal((await world.fake.sceneAction(SCENE_ACTIONS.RESTART, {})).success, true);
  assert.equal((await world.fake.sceneAction(SCENE_ACTIONS.SHUTDOWN, {})).success, true);
  assert.deepEqual(world.nas.commands, ['system.reboot', 'system.shutdown']);
});

test('the option turned off again: refused again', async (t) => {
  const world = await createWorld({ nas: new FakeTruenas({ role: 'admin' }), config: ALLOWED });
  t.after(() => world.app.stop());
  await world.fake.configUpdated({ ...ALLOWED, allow_power_actions: false });
  const ack = await world.fake.sceneAction(SCENE_ACTIONS.RESTART, {});
  assert.equal(ack.success, false);
  assert.deepEqual(world.nas.commands, []);
});

test('in the configured language, refused when the NAS does not answer', async (t) => {
  const world = await createWorld({ config: { ...ALLOWED, language: 'fr' } });
  t.after(() => world.app.stop());
  world.nas.failure = 'down';
  world.nas.dropConnections();
  await world.hub.afterChanges(await world.hub.poll());
  const ack = await world.fake.sceneAction(SCENE_ACTIONS.SHUTDOWN, {});
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /pas connecté/);
});

test('a read-only key: TrueNAS refuses, the scene is told why', async (t) => {
  const world = await createWorld({ config: ALLOWED });
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction(SCENE_ACTIONS.RESTART, {});
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /lacks a right/);
  assert.deepEqual(world.nas.commands, []);
});
