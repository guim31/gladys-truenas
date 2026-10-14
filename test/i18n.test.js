// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code, the feature names. German says "du", never the polite "Sie"; Spanish
// says "usted". The store publishes docs/en.md and docs/fr.md, and since
// Gladys 5.2 docs/de.md and docs/es.md too: the four have the same sections
// and name every feature, trigger and button.
// (Adapted from guim31/gladys-qnap.)
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { NAMES } from '../src/devices.js';
import { ERROR_KINDS } from '../src/truenas/client.js';
import { ALERT_LEVELS, DISK_STATES, POOL_STATES, RUN_STATES } from '../src/truenas/model.js';
import {
  ALERT_LEVEL_TEXT,
  COMMAND_TEXT,
  CONNECTION_TEXT,
  DISK_STATE_TEXT,
  ERROR_TEXT,
  INIT_FAILED,
  POOL_STATE_TEXT,
  REPORT_TEXT,
  RUN_STATE_TEXT,
  UNIT_TEXT,
} from '../src/texts.js';
import { TEXT } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)(?!\p{L})/u;
// The familiar Spanish pronouns the "usted" register never uses (the
// verbs are left out: "usa" or "añade" are also the forms of "usted").
const FAMILIAR_SPANISH = /(?<!\p{L})(tú|tu|tus|te|ti|contigo)(?!\p{L})/iu;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 300,
  message: 200,
  short: 24,
  status: 40,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite German form: "${text}"`);
  }
  if (lang === 'es' && FAMILIAR_SPANISH.test(text)) {
    found.push(`${path} uses the familiar Spanish form: "${text}"`);
  }
  return found;
}

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max, render = (value) => value) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(render(value), `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  assert.deepEqual(Object.keys(NAMES), LANGS);
});

test('the name is the same in every language', () => {
  assert.equal(typeof manifest.name, 'string');
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 40, `only ${texts.length} texts found in the manifest`);
  const found = texts.flatMap(({ path, value, max }) => problems(value, path, max));
  assert.deepEqual(found, []);
});

test('the catalog description holds 10 characters at least in every language', () => {
  for (const lang of LANGS) {
    assert.ok(manifest.description[lang].length >= 10, `description.${lang} is too short`);
  }
});

test('every message table of the code has the four languages', () => {
  const longWidgetTexts = new Set(['waiting', 'refreshed']);
  const found = [
    ...problems(INIT_FAILED, 'INIT_FAILED', MAX.message),
    ...Object.entries(CONNECTION_TEXT).flatMap(([key, value]) =>
      problems(value, `CONNECTION_TEXT.${key}`, MAX.message),
    ),
    ...Object.entries(COMMAND_TEXT).flatMap(([key, value]) =>
      problems(value, `COMMAND_TEXT.${key}`, MAX.message),
    ),
    ...Object.entries(ERROR_TEXT).flatMap(([key, value]) =>
      problems(value, `ERROR_TEXT.${key}`, 100),
    ),
    // A state is a text feature, a widget row value (40) and a scene variable.
    ...[
      ['POOL_STATE_TEXT', POOL_STATE_TEXT],
      ['DISK_STATE_TEXT', DISK_STATE_TEXT],
      ['RUN_STATE_TEXT', RUN_STATE_TEXT],
      ['ALERT_LEVEL_TEXT', ALERT_LEVEL_TEXT],
    ].flatMap(([name, table]) =>
      Object.entries(table).flatMap(([key, value]) => problems(value, `${name}.${key}`, MAX.short)),
    ),
    ...Object.entries(UNIT_TEXT).flatMap(([key, value]) => problems(value, `UNIT_TEXT.${key}`, 6)),
    ...Object.entries(TEXT).flatMap(([key, value]) =>
      problems(value, `TEXT.${key}`, longWidgetTexts.has(key) ? MAX.message : MAX.short),
    ),
  ];
  assert.deepEqual(found, []);
  assert.deepEqual(sorted(Object.keys(ERROR_TEXT)), sorted(Object.values(ERROR_KINDS)));
  assert.deepEqual(sorted(Object.keys(POOL_STATE_TEXT)), sorted(Object.keys(POOL_STATES)));
  assert.deepEqual(sorted(Object.keys(DISK_STATE_TEXT)), sorted(Object.keys(DISK_STATES)));
  assert.deepEqual(sorted(Object.keys(RUN_STATE_TEXT)), sorted(RUN_STATES));
  assert.deepEqual(sorted(Object.keys(ALERT_LEVEL_TEXT)), sorted(['none', ...ALERT_LEVELS]));
});

test('the feature names exist in every language', () => {
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName), []);
});

test('the connection report exists in every language', () => {
  const render = (value) => (typeof value === 'function' ? value(12) : value);
  assert.deepEqual(tableProblems(REPORT_TEXT, 'REPORT_TEXT', MAX.message, render), []);
});

test('the guard catches a missing language, an empty text and the wrong register', () => {
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: 'Licht' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: '', es: 'Luz' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Gerät', 'Ihre IP', 'mit Ihrem', 'Ihnen']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  for (const familiar of ['Elige tu NAS', 'tus discos', 'Te avisa']) {
    assert.equal(
      problems({ en: 'a', fr: 'a', de: 'a', es: familiar }, 'x', 60).length,
      1,
      familiar,
    );
  }
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'Elija su NAS' }, 'x', 60),
    [],
  );
  const forgotten = structuredClone(manifest);
  delete forgotten.scene_triggers[0].fields[0].label.de;
  const found = manifestTexts(forgotten).flatMap(({ path, value, max }) =>
    problems(value, path, max),
  );
  assert.deepEqual(found, [
    'manifest.scene_triggers[0].fields[0].label has [en,fr,es], expected exactly [en,fr,de,es]',
  ]);
});

// --- Documentation -------------------------------------------------------------

const DOC_LANGS = LANGS;
const docs = Object.fromEntries(
  await Promise.all(
    DOC_LANGS.map(async (lang) => [
      lang,
      await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8'),
    ]),
  ),
);

const headings = (markdown) =>
  markdown
    .split('\n')
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.match(/^#+/)[0].length);

test('the four documentation files exist and have the same sections', () => {
  for (const lang of DOC_LANGS) {
    assert.ok(docs[lang].length >= 300, `docs/${lang}.md is too short for the store`);
    assert.deepEqual(headings(docs[lang]), headings(docs.en), `docs/${lang}.md sections`);
  }
  assert.ok(headings(docs.en).length >= 10);
});

test('the documentation names every trigger, action, feature, state and widget button', () => {
  for (const lang of DOC_LANGS) {
    const doc = docs[lang];
    const expected = [
      ...manifest.scene_triggers.map((item) => item.label[lang]),
      ...manifest.actions.map((item) => item.label[lang]),
      ...manifest.scene_actions.map((item) => item.label[lang]),
      ...manifest.config_schema
        .filter((field) => field.type !== 'section')
        .map((field) => field.label[lang]),
      ...manifest.widgets.map((item) => item.label[lang]),
      ...Object.values(NAMES[lang]),
      ...[POOL_STATE_TEXT, DISK_STATE_TEXT, RUN_STATE_TEXT, ALERT_LEVEL_TEXT].flatMap((table) =>
        Object.values(table)
          .filter((text) => text.en !== 'Unknown')
          .map((text) => text[lang]),
      ),
      TEXT.refresh[lang],
    ];
    for (const text of expected) {
      assert.ok(doc.includes(text), `docs/${lang}.md: "${text}"`);
    }
  }
});

test('the documentation says it was developed without the hardware, and is not affiliated', () => {
  assert.match(docs.en, /Developed without the hardware: feedback welcome/);
  assert.match(docs.fr, /Développée sans le matériel : retours bienvenus/);
  assert.match(docs.en, /Not affiliated with iXsystems/);
  assert.match(docs.fr, /Non affiliée à iXsystems/);
  assert.match(docs.de, /Ohne die Hardware entwickelt: Rückmeldungen willkommen/);
  assert.match(docs.de, /Nicht mit iXsystems verbunden/);
  assert.match(docs.es, /Desarrollada sin el hardware: se agradecen los comentarios/);
  assert.match(docs.es, /No afiliada a iXsystems/);
  for (const lang of DOC_LANGS) {
    assert.match(docs[lang], /github\.com\/guim31\/gladys-truenas\/issues/);
  }
});

test('the German documentation says "du", the Spanish one "usted"', () => {
  assert.doesNotMatch(docs.de, POLITE_GERMAN);
  assert.doesNotMatch(docs.es, FAMILIAR_SPANISH);
});
