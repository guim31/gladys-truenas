// -----------------------------------------------------------------------------
// The configuration: the address typed by the user becomes the wss:// URL of
// the API (never plain HTTP: TrueNAS would revoke the key), and every field
// gets its default.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isComplete, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: bare host, port, URL copied from the browser', () => {
  assert.deepEqual(parseAddress('192.0.2.20'), {
    url: 'wss://192.0.2.20/api/current',
    insecure: false,
  });
  assert.equal(parseAddress(' truenas.local ').url, 'wss://truenas.local/api/current');
  assert.equal(parseAddress('192.0.2.20:8443').url, 'wss://192.0.2.20:8443/api/current');
  assert.equal(parseAddress('https://192.0.2.20/ui/dashboard').url, 'wss://192.0.2.20/api/current');
  assert.equal(parseAddress('https://192.0.2.20:443').url, 'wss://192.0.2.20/api/current');
  assert.equal(
    parseAddress('wss://nas.example:9443/api/current').url,
    'wss://nas.example:9443/api/current',
  );
  assert.equal(parseAddress('[2001:db8::20]').url, 'wss://[2001:db8::20]/api/current');
});

test('plain HTTP is refused, so is anything not understood', () => {
  assert.deepEqual(parseAddress('http://192.0.2.20'), { url: null, insecure: true });
  assert.deepEqual(parseAddress('ws://192.0.2.20/api/current'), { url: null, insecure: true });
  assert.equal(parseAddress('ftp://192.0.2.20').url, null);
  assert.equal(parseAddress('https://root:secret@192.0.2.20').url, null);
  assert.equal(parseAddress('').url, null);
  assert.equal(parseAddress(42).url, null);
});

test('normalization: defaults, a pasted key trimmed, the address problems told apart', () => {
  const config = normalizeConfig({});
  assert.equal(config.url, null);
  assert.equal(config.insecure, DEFAULT_CONFIG.accept_self_signed);
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.appControl, false);
  assert.equal(config.powerActions, false);
  assert.equal(config.language, 'fr');
  assert.equal(isComplete(config), false);

  const full = normalizeConfig({
    address: '192.0.2.20',
    api_key: '  1-abc\n',
    accept_self_signed: 'true',
    poll_interval: 300,
    allow_app_control: true,
    language: 'de',
  });
  assert.equal(full.apiKey, '1-abc');
  assert.equal(full.insecure, true);
  assert.equal(full.pollIntervalMs, 300_000);
  assert.equal(full.appControl, true);
  assert.equal(full.language, 'de');
  assert.equal(isComplete(full), true);

  assert.equal(normalizeConfig({ poll_interval: '7' }).pollIntervalMs, 60_000);
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
  assert.equal(normalizeConfig({ address: 'http://192.0.2.20' }).addressInsecure, true);
  assert.equal(normalizeConfig({ address: 'http://192.0.2.20' }).addressInvalid, false);
  assert.equal(normalizeConfig({ address: 'ftp://x' }).addressInvalid, true);
});
