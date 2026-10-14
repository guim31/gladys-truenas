// -----------------------------------------------------------------------------
// The `nas` widget: valid for the core in every state and language (the SDK
// validator: vocabulary, budget, lengths), the problems first, and the Refresh
// button that reads the NAS again.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { ACTIONS, MAX_ROWS } from '../src/widgets.js';
import { CONFIG, createWorld, tick } from './helpers/world.js';

const LANGUAGES = ['en', 'fr', 'de', 'es'];

async function content(world, language = 'en') {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { language });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
}

const status = (widget) => widget.components.find((c) => c.type === 'status');

test('a NAS that answers: valid, three tiles, the rows, a Refresh button', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const language of LANGUAGES) {
    const widget = await content(world, language);
    assert.deepEqual(validateWidgetContent(widget), [], language);
    assert.deepEqual(
      widget.components.map((c) => c.type),
      ['text', 'gauge', 'gauge', 'value', 'status', 'button'],
    );
  }
  const widget = await content(world, 'fr');
  assert.equal(widget.components[0].text, 'truenas');
  assert.equal(widget.components[3].value, 45);
  assert.deepEqual(
    status(widget).items.map((item) => [item.label, item.value]),
    [
      ['Mise à jour', '25.10.2'],
      ['Alertes', 'Aucune'],
      ['tank', '50 % · 5,3 To libres'],
      ['backup', '90 % · 387 Go libres'],
      ['Applications en marche', '2 / 3'],
      ['VM en marche', '1 / 2'],
      ['En marche depuis', '2 j 1 h'],
    ],
  );
});

test('the problems come first: alerts by level, pool, disk, crashed app', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.nas.addAlert({ id: 'w', level: 'WARNING', formatted: 'Certificate expires in 7 days.' });
  world.nas.addAlert({
    id: 'c',
    level: 'CRITICAL',
    klass: 'SMARTFailedSelfTest',
    formatted: 'Device /dev/sdb: self-test failed.',
  });
  world.nas.addAlert({ id: 'i', level: 'NOTICE', formatted: 'Scrub of pool tank finished.' });
  world.nas.setPool('backup', { status: 'DEGRADED', healthy: false });
  world.nas.setApp('nextcloud', { state: 'CRASHED' });
  world.clock.advance(5 * 60_000);
  await world.fake.widgetAction(WIDGET_KEY, ACTIONS.REFRESH);
  const widget = await content(world);
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.deepEqual(
    status(widget)
      .items.slice(0, 6)
      .map((item) => [item.label, item.value, item.color]),
    [
      ['Critical', 'Device /dev/sdb: self-test failed.', 'danger'],
      ['Warning', 'Certificate expires in 7 days.', 'warning'],
      ['Other alerts', '+1', 'info'],
      ['backup', 'Degraded', 'warning'],
      ['sdb (TESTDISK0002)', 'SMART test failed', 'danger'],
      ['nextcloud', 'Crashed', 'danger'],
    ],
  );
  assert.equal(status(widget).items.length, MAX_ROWS);
  assert.equal(status(widget).items.at(-1).label, 'Others');
});

test('a NAS that does not answer says so, and Refresh reads it again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.nas.failure = 'down';
  world.nas.dropConnections();
  await tick(world);
  for (const language of LANGUAGES) {
    const widget = await content(world, language);
    assert.deepEqual(validateWidgetContent(widget), []);
    assert.deepEqual(
      widget.components.map((c) => c.type),
      ['text', 'text', 'button'],
    );
  }
  world.nas.failure = null;
  const ack = await world.fake.widgetAction(WIDGET_KEY, ACTIONS.REFRESH);
  assert.equal(ack.success, true);
  assert.equal(ack.data.message.en, 'NAS read again.');
  assert.equal((await content(world)).components[1].type, 'gauge');
});

test('not configured, or over HTTP: one sentence', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, api_key: '' } });
  t.after(() => world.app.stop());
  const widget = await content(world, 'de');
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.match(widget.components[0].text, /Gib die Adresse/);
  await world.fake.configUpdated({ ...CONFIG, address: 'http://192.0.2.20' });
  assert.match((await content(world, 'es')).components[0].text, /Solo HTTPS/);
});

test('an unknown widget action is refused', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.widgetAction(WIDGET_KEY, 'reboot');
  assert.equal(ack.success, false);
});
