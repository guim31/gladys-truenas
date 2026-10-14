// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `nas`.
//
// The use case: a glance at the wall tablet tells whether the NAS is fine.
// Two gauges (CPU, memory) and the CPU temperature as a tile, then the rows:
// what needs attention first (the most serious active alerts, a pool not
// online, a disk with a SMART alert, an app that crashed, an update), then
// every pool with its use and free space, the apps running and the uptime.
// A NAS that does not answer says so in words.
//
// No setting: one NAS per installation. The figures are sent as values, not
// bound to device features: the widget works before any device is added.
//
// Budget (8 components, 6 tiles, 2 texts, 1 status, 4 buttons): a heading,
// three tiles, one status list of eight rows at most and a Refresh button;
// a heading, one text and the button when the NAS does not answer.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { DISK_STATES, POOL_STATES, levelRank } from './truenas/model.js';
import {
  ALERT_LEVEL_TEXT,
  CONNECTION_TEXT,
  DISK_STATE_TEXT,
  ERROR_TEXT,
  POOL_STATE_TEXT,
  RUN_STATE_TEXT,
  formatPercent,
  formatSize,
  formatUptime,
  labelled,
  pick,
} from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 8;
// Alerts shown one by one, the most serious first; the others are counted.
export const MAX_ALERT_ROWS = 2;

export const TEXT = {
  waiting: {
    en: 'Waiting for the first answer of the NAS…',
    fr: 'En attente de la première réponse du NAS…',
    de: 'Warte auf die erste Antwort des NAS …',
    es: 'Esperando la primera respuesta del NAS…',
  },
  cpu: { en: 'CPU', fr: 'Processeur', de: 'Prozessor', es: 'Procesador' },
  memory: { en: 'Memory', fr: 'Mémoire', de: 'Speicher', es: 'Memoria' },
  temperature: { en: 'Temperature', fr: 'Température', de: 'Temperatur', es: 'Temperatura' },
  uptime: { en: 'Uptime', fr: 'En marche depuis', de: 'Läuft seit', es: 'En marcha desde' },
  free: { en: 'free', fr: 'libres', de: 'frei', es: 'libres' },
  alerts: { en: 'Alerts', fr: 'Alertes', de: 'Warnungen', es: 'Alertas' },
  otherAlerts: {
    en: 'Other alerts',
    fr: 'Autres alertes',
    de: 'Weitere Warnungen',
    es: 'Otras alertas',
  },
  noAlert: { en: 'None', fr: 'Aucune', de: 'Keine', es: 'Ninguna' },
  apps: {
    en: 'Apps running',
    fr: 'Applications en marche',
    de: 'Laufende Apps',
    es: 'Aplicaciones en marcha',
  },
  vms: { en: 'VMs running', fr: 'VM en marche', de: 'Laufende VMs', es: 'VM en marcha' },
  update: { en: 'Update', fr: 'Mise à jour', de: 'Update', es: 'Actualización' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'NAS read again.',
    fr: 'NAS relu.',
    de: 'NAS neu gelesen.',
    es: 'NAS leído de nuevo.',
  },
};

const t = (value, language) => pick(value, language);
const fit = (value, max) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** Danger from 90, warning from 75: what a monitoring tool shows in red and orange. */
const usageColor = (value) =>
  value >= 90 ? WIDGET_COLORS.DANGER : value >= 75 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS;
const temperatureColor = (celsius) =>
  celsius >= 80
    ? WIDGET_COLORS.DANGER
    : celsius >= 65
      ? WIDGET_COLORS.WARNING
      : WIDGET_COLORS.NEUTRAL;
const severityColor = (severity) => (severity >= 2 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.WARNING);
/** ERROR and above in red, WARNING in orange, the rest as information. */
const alertColor = (level) =>
  levelRank(level) >= levelRank('error')
    ? WIDGET_COLORS.DANGER
    : levelRank(level) >= levelRank('warning')
      ? WIDGET_COLORS.WARNING
      : WIDGET_COLORS.INFO;

function message(value, language, ttl = 300) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: t(value, language) }],
  };
}

const refreshButton = (language) => ({
  type: 'button',
  label: t(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

const gauge = (label, value, language) => ({
  type: 'gauge',
  value: Math.round(value),
  min: 0,
  max: 100,
  unit: '%',
  label: t(label, language),
  color: usageColor(value),
});

function alertRows(alerts, language) {
  if (!alerts) {
    return { problems: [], others: [] };
  }
  if (alerts.filter((alert) => alert.klass !== 'HasUpdate').length === 0) {
    return {
      problems: [],
      others: [
        {
          label: t(TEXT.alerts, language),
          value: t(TEXT.noAlert, language),
          icon: 'bell',
          color: WIDGET_COLORS.SUCCESS,
        },
      ],
    };
  }
  // The update alert says what the Update row already says.
  const sorted = alerts
    .filter((alert) => alert.klass !== 'HasUpdate')
    .sort((a, b) => levelRank(b.level) - levelRank(a.level));
  const problems = sorted.slice(0, MAX_ALERT_ROWS).map((alert) => ({
    label: t(ALERT_LEVEL_TEXT[alert.level], language),
    value: fit(alert.text || alert.klass, 40),
    icon: 'bell',
    color: alertColor(alert.level),
  }));
  if (sorted.length > MAX_ALERT_ROWS) {
    problems.push({
      label: t(TEXT.otherAlerts, language),
      value: `+${sorted.length - MAX_ALERT_ROWS}`,
      icon: 'bell',
      color: alertColor(sorted[MAX_ALERT_ROWS].level),
    });
  }
  return { problems, others: [] };
}

/** The rows of the status list, the problems first. */
function rows(snapshot, language) {
  const { problems, others } = alertRows(snapshot.alerts, language);
  for (const pool of snapshot.pools ?? []) {
    const state = POOL_STATES[pool.state];
    if (state.alert) {
      problems.push({
        label: fit(pool.name, 40),
        value: t(POOL_STATE_TEXT[pool.state], language),
        icon: 'alert-triangle',
        color: severityColor(state.severity),
      });
      continue;
    }
    const parts = [];
    if (pool.percent !== null) {
      parts.push(formatPercent(pool.percent, language));
    }
    if (pool.free !== null) {
      parts.push(`${formatSize(pool.free, language)} ${t(TEXT.free, language)}`);
    }
    others.push({
      label: fit(pool.name, 40),
      value: fit(parts.join(' · ') || t(POOL_STATE_TEXT[pool.state], language), 40),
      icon: 'database',
      color: pool.percent === null ? WIDGET_COLORS.NEUTRAL : usageColor(pool.percent),
    });
  }
  for (const disk of snapshot.disks ?? []) {
    const state = DISK_STATES[disk.state];
    if (state.alert) {
      problems.push({
        label: fit(disk.serial ? `${disk.name} (${disk.serial})` : disk.name, 40),
        value: t(DISK_STATE_TEXT[disk.state], language),
        icon: 'alert-octagon',
        color: severityColor(state.severity),
      });
    }
  }
  for (const item of [...(snapshot.apps ?? []), ...(snapshot.vms ?? [])]) {
    if (item.state === 'crashed' || item.state === 'error') {
      problems.push({
        label: fit(item.name, 40),
        value: t(RUN_STATE_TEXT[item.state], language),
        icon: 'x-octagon',
        color: WIDGET_COLORS.DANGER,
      });
    }
  }
  if (snapshot.update) {
    problems.push({
      label: t(TEXT.update, language),
      value: fit(snapshot.update.version, 40),
      icon: 'download',
      color: WIDGET_COLORS.INFO,
    });
  }
  for (const [list, label, icon] of [
    [snapshot.apps, TEXT.apps, 'box'],
    [snapshot.vms, TEXT.vms, 'monitor'],
  ]) {
    if (list && list.length > 0) {
      others.push({
        label: t(label, language),
        value: `${list.filter((item) => item.running).length} / ${list.length}`,
        icon,
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  }
  if (snapshot.uptime !== null) {
    others.push({
      label: t(TEXT.uptime, language),
      value: formatUptime(snapshot.uptime, language),
      icon: 'clock',
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  const all = [...problems, ...others];
  if (all.length <= MAX_ROWS) {
    return all;
  }
  const shown = all.slice(0, MAX_ROWS - 1);
  shown.push({
    label: t(TEXT.more, language),
    value: `+${all.length - shown.length}`,
    icon: 'more-horizontal',
    color: WIDGET_COLORS.NEUTRAL,
  });
  return shown;
}

/** The tiles and the rows of a NAS that answers. */
function nasComponents(snapshot, language) {
  const components = [];
  if (snapshot.cpu !== null) {
    components.push(gauge(TEXT.cpu, snapshot.cpu, language));
  }
  if (snapshot.memory !== null) {
    components.push(gauge(TEXT.memory, snapshot.memory, language));
  }
  if (snapshot.cpuTemperature !== null) {
    components.push({
      type: 'value',
      value: Math.round(snapshot.cpuTemperature),
      unit: '°C',
      label: t(TEXT.temperature, language),
      icon: 'thermometer',
      color: temperatureColor(snapshot.cpuTemperature),
    });
  }
  const items = rows(snapshot, language);
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  return components;
}

async function get(hub, { language = 'en' } = {}) {
  const view = hub.view();
  if (!view.configured) {
    let text = CONNECTION_TEXT.notConfigured;
    if (hub.config?.addressInsecure) {
      text = CONNECTION_TEXT.insecureAddress;
    } else if (hub.config?.addressInvalid) {
      text = CONNECTION_TEXT.invalidAddress;
    }
    return message(text, language);
  }
  if (!view.online) {
    if (!view.error) {
      return message(TEXT.waiting, language, 30);
    }
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'heading', text: fit(view.name, 40) },
        {
          type: 'text',
          variant: 'body',
          text: labelled(view.name, t(ERROR_TEXT[view.error.kind], language), language),
        },
        refreshButton(language),
      ],
    };
  }
  return {
    ttl_seconds: 60,
    components: [
      { type: 'text', variant: 'heading', text: fit(view.name, 40) },
      ...nasComponents(view.snapshot, language),
      refreshButton(language),
    ],
  };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  // A manual request: also tries again a key refused before.
  await hub.afterChanges(await hub.poll({ manual: true }));
  return TEXT.refreshed;
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
