// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the
// TrueNAS fixtures (the NAS, two pools, five disks, three apps, two VMs) on
// 25.10 and on 25.04 (Incus instances, SMART tests), with and without the
// Start / stop switches, in every feature-name language, and for a NAS whose
// reporting graphs fail (no CPU temperature).
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeTruenas } from './helpers/fakeTruenas.js';
import { CONFIG, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

/** A NAS whose reporting graphs all fail (a virtual TrueNAS, netdata down). */
function blindNas() {
  const nas = new FakeTruenas();
  nas.denied.add('reporting.netdata_get_data');
  return nas;
}

async function discover(language, nas, extra = {}) {
  const world = await createWorld({ nas, config: { ...CONFIG, language, ...extra } });
  await world.app.stop();
  return world.fake.discoveredDevices;
}

const scenarios = [
  { label: '25.10, English names', language: 'en', nas: () => new FakeTruenas(), min: 13 },
  { label: '25.10, French names', language: 'fr', nas: () => new FakeTruenas(), min: 13 },
  { label: '25.10, German names', language: 'de', nas: () => new FakeTruenas(), min: 13 },
  { label: '25.10, Spanish names', language: 'es', nas: () => new FakeTruenas(), min: 13 },
  {
    label: '25.10 with Start / stop switches, French names',
    language: 'fr',
    nas: () => new FakeTruenas(),
    extra: { allow_app_control: true },
    min: 13,
  },
  {
    label: '25.04 (Incus instances, SMART tests), German names',
    language: 'de',
    nas: () => new FakeTruenas({ version: '25.04' }),
    extra: { allow_app_control: true },
    min: 15,
  },
  { label: 'reporting refused, Spanish names', language: 'es', nas: blindNas, min: 13 },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = await discover(scenario.language, scenario.nas(), scenario.extra);
    assert.ok(
      devices.length >= scenario.min,
      `expected the fixture devices, got ${devices.length}`,
    );
    assert.equal(
      new Set(devices.map((device) => device.external_id)).size,
      devices.length,
      'unique device external ids',
    );
    const allFeatureIds = new Set();

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          const allowed = table.units_by_category[feature.category];
          if (allowed) {
            assert.ok(
              allowed.includes(feature.unit),
              `${at}: unit ${feature.unit} is not one of the ${feature.category} units`,
            );
          }
        }

        assert.ok(!allFeatureIds.has(feature.external_id), `${at}: duplicate external_id`);
        allFeatureIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}

test('the states published for those devices fit their features', async () => {
  const world = await createWorld({ config: { ...CONFIG, allow_app_control: true } });
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  const features = new Map(
    world.fake.discoveredDevices.flatMap((device) =>
      device.features.map((feature) => [feature.external_id, feature]),
    ),
  );
  assert.ok(world.fake.states.length > 50);
  for (const state of world.fake.states) {
    const feature = features.get(state.device_feature_external_id);
    assert.ok(feature, `${state.device_feature_external_id} is a published feature`);
    if (feature.category === 'text') {
      assert.equal(typeof state.text, 'string');
      assert.ok(state.text.trim().length > 0, 'a text state is never empty');
    } else {
      assert.equal(typeof state.state, 'number');
      assert.ok(
        state.state >= feature.min && state.state <= feature.max,
        `${feature.name}: ${state.state} within [${feature.min}, ${feature.max}]`,
      );
    }
  }
  await world.app.stop();
});
