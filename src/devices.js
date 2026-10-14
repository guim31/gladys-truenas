// -----------------------------------------------------------------------------
// The Gladys devices of a TrueNAS NAS, proposed in the Discovery tab: the user
// adds the ones to follow, nothing is created on their behalf.
//
//   - the NAS itself: online, CPU, memory, CPU temperature, uptime, TrueNAS
//     version, update available, number of active alerts and the highest
//     level among them;
//   - one device per pool: state, alert, space used (%), free space,
//     capacity, days since the last scrub, errors found by it;
//   - one device per disk: temperature, SMART state, alert;
//   - one device per app: running, state, update available;
//   - one device per virtual machine (and Incus instance or container):
//     running, state.
// Apps and VMs get a Start / stop switch only when the configuration allows
// it (off by default): a new feature, which the Discovery tab offers to add
// with its "Update" button.
//
// Identity: the host id of the NAS (system.host_id), then the pool guid, the
// serial number of the disk (its identifier when the serial is missing or
// shared), the name of the app (fixed by TrueNAS at install), the id of the
// VM. Never a label: a disk named sda today is sdb after a reboot.
//
// Category/type couples come from the core table (see
// test/gladys-rules.test.js). Percentages are `level-sensor/liquid-level-
// percent` (the couple of guim31/gladys-qnap and gladys-ugreen-nas: the core
// has no generic percent), counts `counter-sensor/integer`, states `text/text`
// words in the configured language next to an `input/binary` alert or
// running flag that scenes and history can use.
//
// Published with should_poll: false: the integration reads the NAS on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { DISK_STATES, POOL_STATES } from './truenas/model.js';
import {
  ALERT_LEVEL_TEXT,
  DISK_STATE_TEXT,
  POOL_STATE_TEXT,
  RUN_STATE_TEXT,
  pick,
} from './texts.js';

export const DEVICE_TYPES = Object.freeze({
  NAS: 'nas',
  POOL: 'pool',
  DISK: 'disk',
  APP: 'app',
  VM: 'vm',
});

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  ONLINE: 'online',
  CPU: 'cpu',
  MEMORY: 'memory',
  CPU_TEMPERATURE: 'cpu_temperature',
  UPTIME: 'uptime',
  VERSION: 'version',
  UPDATE: 'update_available',
  ALERTS: 'alerts',
  ALERT_LEVEL: 'alert_level',
  STATE: 'state',
  ALERT: 'alert',
  USED_PERCENT: 'used_percent',
  FREE: 'free',
  CAPACITY: 'capacity',
  LAST_SCRUB: 'last_scrub',
  SCRUB_ERRORS: 'scrub_errors',
  TEMPERATURE: 'temperature',
  RUNNING: 'running',
  POWER: 'power',
});

const K = FEATURE_KEYS;

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
// `disk` names the disk devices.
export const NAMES = {
  en: {
    [K.ONLINE]: 'Online',
    [K.CPU]: 'CPU',
    [K.MEMORY]: 'Memory',
    [K.CPU_TEMPERATURE]: 'CPU temperature',
    [K.UPTIME]: 'Uptime',
    [K.VERSION]: 'TrueNAS version',
    [K.UPDATE]: 'Update available',
    [K.ALERTS]: 'Active alerts',
    [K.ALERT_LEVEL]: 'Highest alert level',
    [K.STATE]: 'State',
    [K.ALERT]: 'Alert',
    [K.USED_PERCENT]: 'Space used',
    [K.FREE]: 'Free space',
    [K.CAPACITY]: 'Capacity',
    [K.LAST_SCRUB]: 'Days since last scrub',
    [K.SCRUB_ERRORS]: 'Last scrub errors',
    [K.TEMPERATURE]: 'Temperature',
    [K.RUNNING]: 'Running',
    [K.POWER]: 'Start / stop',
    disk: 'disk',
  },
  fr: {
    [K.ONLINE]: 'En ligne',
    [K.CPU]: 'Processeur',
    [K.MEMORY]: 'Mémoire',
    [K.CPU_TEMPERATURE]: 'Température du processeur',
    [K.UPTIME]: 'Durée de fonctionnement',
    [K.VERSION]: 'Version de TrueNAS',
    [K.UPDATE]: 'Mise à jour disponible',
    [K.ALERTS]: 'Alertes actives',
    [K.ALERT_LEVEL]: "Niveau d'alerte le plus haut",
    [K.STATE]: 'État',
    [K.ALERT]: 'Alerte',
    [K.USED_PERCENT]: 'Espace utilisé',
    [K.FREE]: 'Espace libre',
    [K.CAPACITY]: 'Capacité',
    [K.LAST_SCRUB]: 'Jours depuis le dernier scrub',
    [K.SCRUB_ERRORS]: 'Erreurs du dernier scrub',
    [K.TEMPERATURE]: 'Température',
    [K.RUNNING]: 'En marche',
    [K.POWER]: 'Marche / arrêt',
    disk: 'disque',
  },
  de: {
    [K.ONLINE]: 'Online',
    [K.CPU]: 'Prozessor',
    [K.MEMORY]: 'Arbeitsspeicher',
    [K.CPU_TEMPERATURE]: 'Prozessortemperatur',
    [K.UPTIME]: 'Laufzeit',
    [K.VERSION]: 'TrueNAS-Version',
    [K.UPDATE]: 'Update verfügbar',
    [K.ALERTS]: 'Aktive Warnungen',
    [K.ALERT_LEVEL]: 'Höchste Warnstufe',
    [K.STATE]: 'Zustand',
    [K.ALERT]: 'Warnung',
    [K.USED_PERCENT]: 'Belegter Speicher',
    [K.FREE]: 'Freier Speicher',
    [K.CAPACITY]: 'Kapazität',
    [K.LAST_SCRUB]: 'Tage seit dem letzten Scrub',
    [K.SCRUB_ERRORS]: 'Fehler des letzten Scrubs',
    [K.TEMPERATURE]: 'Temperatur',
    [K.RUNNING]: 'Läuft',
    [K.POWER]: 'Start / Stopp',
    disk: 'Festplatte',
  },
  es: {
    [K.ONLINE]: 'En línea',
    [K.CPU]: 'Procesador',
    [K.MEMORY]: 'Memoria',
    [K.CPU_TEMPERATURE]: 'Temperatura del procesador',
    [K.UPTIME]: 'Tiempo en marcha',
    [K.VERSION]: 'Versión de TrueNAS',
    [K.UPDATE]: 'Actualización disponible',
    [K.ALERTS]: 'Alertas activas',
    [K.ALERT_LEVEL]: 'Nivel de alerta más alto',
    [K.STATE]: 'Estado',
    [K.ALERT]: 'Alerta',
    [K.USED_PERCENT]: 'Espacio usado',
    [K.FREE]: 'Espacio libre',
    [K.CAPACITY]: 'Capacidad',
    [K.LAST_SCRUB]: 'Días desde el último scrub',
    [K.SCRUB_ERRORS]: 'Errores del último scrub',
    [K.TEMPERATURE]: 'Temperatura',
    [K.RUNNING]: 'En marcha',
    [K.POWER]: 'Encender / apagar',
    disk: 'disco',
  },
};

// Display bounds (the core never applies them on write). Fixed: a bound that
// moves changes the device structure.
export const BOUNDS = Object.freeze({
  TEMPERATURE: [-50, 150],
  UPTIME_MAX_DAYS: 36500,
  SIZE_MAX_GB: 10000000,
  SCRUB_MAX_DAYS: 36500,
  COUNT_MAX: 1000000,
});

/** External ids of a device: the NAS (`key` null), or one of its pools, disks, apps, VMs. */
export function deviceIds(gladys, type, nasId, key = null) {
  return gladys.externalIds(type, key === null ? nasId : `${nasId}-${key}`);
}

const round = (value, digits) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const percent = () => ({
  definition: {
    category: CATEGORY.LEVEL_SENSOR,
    type: TYPE.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
    unit: UNIT.PERCENT,
    min: 0,
    max: 100,
  },
  digits: 1,
});
const binary = () => ({
  definition: { category: CATEGORY.INPUT, type: TYPE.SENSOR.BINARY, min: 0, max: 1 },
  digits: 0,
});
const temperature = () => ({
  definition: {
    category: CATEGORY.DEVICE_TEMPERATURE_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.CELSIUS,
    min: BOUNDS.TEMPERATURE[0],
    max: BOUNDS.TEMPERATURE[1],
  },
  digits: 0,
});
const size = () => ({
  definition: {
    category: CATEGORY.DATA,
    type: TYPE.DATA.SIZE,
    unit: UNIT.GIGABYTE,
    min: 0,
    max: BOUNDS.SIZE_MAX_GB,
  },
  digits: 1,
});
const counter = () => ({
  definition: {
    category: CATEGORY.COUNTER_SENSOR,
    type: TYPE.SENSOR.INTEGER,
    min: 0,
    max: BOUNDS.COUNT_MAX,
  },
  digits: 0,
});
// A text state: min/max are NOT NULL in the core, even for a text.
const textual = () => ({
  definition: { category: CATEGORY.TEXT, type: TYPE.TEXT.TEXT, min: 0, max: 0 },
  text: true,
});
// The Start / stop switch of an app or a VM, when the configuration allows it.
const powerSwitch = () => ({
  definition: { category: CATEGORY.SWITCH, type: TYPE.SWITCH.BINARY, min: 0, max: 1 },
  digits: 0,
  writable: true,
});

const toGigabytes = (bytes) => (bytes === null || bytes === undefined ? null : bytes / 1e9);
const binaryOf = (value) => (value === null || value === undefined ? null : value ? 1 : 0);
const DAY_MS = 86400_000;

/**
 * The features of a device for an item: what it stands for (the snapshot for
 * the NAS, a pool, a disk, an app, a VM). `item` null means it is gone: only
 * the features that do not need it remain (the NAS online flag). Each
 * feature: { key, definition, digits | text, writable?, value(item, ctx) };
 * `ctx` carries { online, language, now }. `options.control` adds the switch
 * of the apps and VMs.
 */
function blueprint(type, item, { control = false } = {}) {
  switch (type) {
    case DEVICE_TYPES.NAS: {
      const features = [
        { key: K.ONLINE, ...binary(), value: (_, ctx) => (ctx.online ? 1 : 0) },
        { key: K.CPU, ...percent(), value: (x) => x?.cpu },
        { key: K.MEMORY, ...percent(), value: (x) => x?.memory },
      ];
      // A NAS without sensor (a virtual machine) never says its temperature.
      if (item?.cpuTemperature !== null) {
        features.push({
          key: K.CPU_TEMPERATURE,
          ...temperature(),
          value: (x) => x?.cpuTemperature,
        });
      }
      features.push(
        {
          key: K.UPTIME,
          definition: {
            category: CATEGORY.DURATION,
            type: TYPE.DURATION.DECIMAL,
            unit: UNIT.DAYS,
            min: 0,
            max: BOUNDS.UPTIME_MAX_DAYS,
          },
          digits: 2,
          value: (x) => (x?.uptime === null || x?.uptime === undefined ? null : x.uptime / 86400),
        },
        { key: K.VERSION, ...textual(), value: (x) => x?.version },
        {
          key: K.UPDATE,
          ...binary(),
          // Unknown until the first update check.
          value: (x) => (x?.update === undefined ? null : x.update ? 1 : 0),
        },
        { key: K.ALERTS, ...counter(), value: (x) => x?.alerts?.length },
        {
          key: K.ALERT_LEVEL,
          ...textual(),
          value: (x, ctx) =>
            x?.alertLevel ? pick(ALERT_LEVEL_TEXT[x.alertLevel], ctx.language) : null,
        },
      );
      return features;
    }
    case DEVICE_TYPES.POOL:
      return [
        {
          key: K.STATE,
          ...textual(),
          value: (p, ctx) => (p ? pick(POOL_STATE_TEXT[p.state], ctx.language) : null),
        },
        {
          key: K.ALERT,
          ...binary(),
          value: (p) => (p ? binaryOf(POOL_STATES[p.state].alert) : null),
        },
        { key: K.USED_PERCENT, ...percent(), value: (p) => p?.percent },
        { key: K.FREE, ...size(), value: (p) => toGigabytes(p?.free) },
        { key: K.CAPACITY, ...size(), value: (p) => toGigabytes(p?.total) },
        {
          key: K.LAST_SCRUB,
          definition: {
            category: CATEGORY.DURATION,
            type: TYPE.DURATION.INTEGER,
            unit: UNIT.DAYS,
            min: 0,
            max: BOUNDS.SCRUB_MAX_DAYS,
          },
          digits: 0,
          value: (p, ctx) =>
            p?.lastScrubAt ? Math.max(0, Math.floor((ctx.now - p.lastScrubAt) / DAY_MS)) : null,
        },
        { key: K.SCRUB_ERRORS, ...counter(), value: (p) => p?.scrubErrors },
      ];
    case DEVICE_TYPES.DISK:
      return [
        // Kept once seen: a disk asleep reports no temperature for a while.
        { key: K.TEMPERATURE, ...temperature(), value: (d) => d?.temperature },
        {
          key: K.STATE,
          ...textual(),
          value: (d, ctx) => (d ? pick(DISK_STATE_TEXT[d.state], ctx.language) : null),
        },
        {
          key: K.ALERT,
          ...binary(),
          value: (d) => (d ? binaryOf(DISK_STATES[d.state].alert) : null),
        },
      ];
    case DEVICE_TYPES.APP:
    case DEVICE_TYPES.VM: {
      const features = [
        { key: K.RUNNING, ...binary(), value: (a) => binaryOf(a?.running) },
        {
          key: K.STATE,
          ...textual(),
          value: (a, ctx) => (a ? pick(RUN_STATE_TEXT[a.state], ctx.language) : null),
        },
      ];
      if (type === DEVICE_TYPES.APP) {
        features.push({ key: K.UPDATE, ...binary(), value: (a) => binaryOf(a?.update) });
      }
      if (control) {
        features.push({ key: K.POWER, ...powerSwitch(), value: (a) => binaryOf(a?.running) });
      }
      return features;
    }
    default:
      throw new Error(`Unknown device type ${type}`);
  }
}

/** The feature keys a device of this type has for this item. */
export const featureKeys = (type, item, options) =>
  blueprint(type, item, options).map((f) => f.key);

/**
 * The discovery payload of a device.
 * @param {object} gladys SDK client
 * @param {object} options
 * @param {string} options.type one of DEVICE_TYPES
 * @param {string} options.nasId platform id of the NAS
 * @param {string|null} options.key item key (null for the NAS)
 * @param {string} options.name device name
 * @param {string} options.model device model
 * @param {object} options.item what the device stands for
 * @param {string} [options.language] feature names language
 * @param {boolean} [options.control] the Start / stop switch of apps and VMs
 */
export function buildDevice(
  gladys,
  { type, nasId, key = null, name, model, item, language = 'en', control = false },
) {
  const ids = deviceIds(gladys, type, nasId, key);
  const names = NAMES[language] ?? NAMES.en;
  const features = blueprint(type, item, { control }).map((feature) => ({
    name: names[feature.key],
    external_id: ids.feature(feature.key),
    ...feature.definition,
    read_only: !feature.writable,
    has_feedback: Boolean(feature.writable),
    keep_history: !feature.text,
  }));
  return {
    name: name.slice(0, 255),
    external_id: ids.device,
    model: (model ?? 'TrueNAS').slice(0, 255),
    should_poll: false,
    features,
  };
}

/**
 * The states of every feature of a device, in the `publishStates` format;
 * the features without a value are left out.
 * @returns {Array<{ device_feature_external_id: string, state?: number, text?: string }>}
 */
export function deviceStates(gladys, { type, nasId, key = null, item, context, control = false }) {
  const ids = deviceIds(gladys, type, nasId, key);
  const states = [];
  for (const feature of blueprint(type, item, { control })) {
    const raw = feature.value(item, context);
    const id = ids.feature(feature.key);
    if (feature.text) {
      // An empty text is ignored by the core: nothing to publish.
      if (typeof raw === 'string' && raw.trim()) {
        states.push({ device_feature_external_id: id, text: raw.slice(0, 255) });
      }
      continue;
    }
    const value = round(raw, feature.digits);
    if (value !== null) {
      states.push({ device_feature_external_id: id, state: value });
    }
  }
  return states;
}
