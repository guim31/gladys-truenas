// -----------------------------------------------------------------------------
// Quiet logs: a normal read cycle writes nothing above the debug level, a
// failure that repeats on every read writes one line when it starts and one
// when it ends, and each action of the user writes one info line.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLogs } from './helpers/logs.js';
import { createDevices, createWorld, tick } from './helpers/world.js';

const above = (lines, levels) =>
  lines.filter((line) => levels.some((l) => line.includes(`[${l}]`)));

test('a normal read cycle writes nothing at the info level', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);

  const info = await captureLogs(async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      world.nas.setCpu(20 + cycle);
      world.clock.advance(60_000);
      await tick(world);
    }
    // A dropped connection opened again is part of a normal life.
    world.nas.dropConnections();
    await tick(world);
  }, 'info');
  assert.deepEqual(info, []);

  const debug = await captureLogs(async () => {
    world.nas.setCpu(42);
    await tick(world);
  }, 'debug');
  assert.ok(
    debug.some((line) => line.includes('[DEBUG]')),
    'the cycles are logged at debug',
  );
});

test('a failure that repeats writes one line when it starts and one when it ends', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const publish = world.gladys.publishChangedStates.bind(world.gladys);

  const lines = await captureLogs(async () => {
    world.gladys.publishChangedStates = async () => {
      throw new Error('Gladys is restarting');
    };
    for (let cycle = 0; cycle < 4; cycle += 1) {
      world.nas.setCpu(30 + cycle);
      await tick(world);
    }
    world.gladys.publishChangedStates = publish;
    world.nas.setCpu(50);
    await tick(world);
    await tick(world);
  }, 'info');
  assert.equal(above(lines, ['WARN', 'ERROR']).length, 1, lines.join('\n'));
  assert.match(lines[0], /States refused: Gladys is restarting/);
  assert.equal(above(lines, ['INFO']).length, 1, lines.join('\n'));
  assert.match(lines[1], /states: back to normal/);
});

test('a part the key may not read: one line, then silence, then one line when it comes back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lines = await captureLogs(async () => {
    world.nas.denied.add('app.query');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await tick(world);
    }
    world.nas.denied.delete('app.query');
    await tick(world);
    await tick(world);
  }, 'info');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*apps.*access denied/);
  assert.match(lines[1], /\[INFO\].*part apps: back to normal/);
});

test('an unreachable NAS writes one line when lost and one when back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);

  const lines = await captureLogs(async () => {
    world.nas.failure = 'down';
    world.nas.dropConnections();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await tick(world);
    }
    world.nas.failure = null;
    await tick(world);
    await tick(world);
  }, 'info');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /\[WARN\]/);
  assert.match(lines[1], /\[INFO\].*answers again/);
});

test('each action of the user writes one info line', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lines = await captureLogs(() => world.fake.action('test_connection'), 'info');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /Connection test requested/);
});
