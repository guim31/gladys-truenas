// -----------------------------------------------------------------------------
// The answers of the TrueNAS API -> one plain snapshot of the NAS, the only
// shape the rest of the integration knows. Pure functions, no I/O: the
// client (src/truenas/client.js) collects the answers, the tests feed the
// fixtures of test/fixtures/truenas.
//
// The fields read, per method (TrueNAS 25.04, 25.10 and 26.0 answer the same
// way unless said otherwise):
//
//   - system.info: hostname, version, uptime_seconds, physmem,
//     system_product, system_manufacturer;
//   - system.host_id: a sha256 of /etc/hostid, the identity of the NAS (it
//     survives upgrades; the serial number is often empty on a home-built NAS);
//   - reporting.netdata_get_data, graphs `cpu` (column `cpu`: total %),
//     `memory` (column `available`, bytes) and `cputemp` (one column per core,
//     °C): the last complete row;
//   - alert.list: uuid, level, klass, formatted, dismissed;
//   - pool.query: guid, name, status, healthy, scan (the last scrub or
//     resilver, dates as `{ $date: ms }`); pool.dataset.query on the root
//     dataset of each pool: used and available as the user sees them (the
//     pool sizes count the RAIDZ parity);
//   - disk.query: identifier, name, serial, model, size, type, pool;
//     disk.temperatures: name -> °C (null when the disk has no sensor);
//   - SMART: 25.04 has smart.test.results (the last self-test of each disk);
//     25.10 removed SMART from its API, its SMART* alerts name the disk;
//   - app.query: name, state, upgrade_available, image_updates_available;
//   - vm.query (id, name, status.state), virt.instance.query (25.04 and 25.10,
//     the Incus instances: id = name, status), container.query (26.0);
//   - update.status (25.10+: status.new_version) or update.check_available
//     (25.04: status AVAILABLE, version).
// -----------------------------------------------------------------------------

/** `{ $date: ms }` (the JSON of a datetime in the TrueNAS API) -> ms, or null. */
export function dateOf(value) {
  if (value && typeof value === 'object' && Number.isFinite(value.$date)) {
    return value.$date;
  }
  if (Number.isFinite(value)) {
    return value;
  }
  return null;
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const list = (value) => (Array.isArray(value) ? value : null);

/** The parts of an id the Gladys external ids keep: letters, digits, `.`, `_`, `-`. */
export const safeKey = (value) =>
  String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);

/**
 * The version of TrueNAS, `{ major, minor }`, from `25.10.1`, `25.04.2.6`,
 * `TrueNAS-SCALE-24.10.2` or `26.0.0-BETA.3`.
 */
export function parseVersion(version) {
  const match = String(version ?? '').match(/(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/** 25.04 still has SMART tests, check_available and the smartctl temperatures. */
export function isLegacy(version) {
  const parsed = parseVersion(version);
  return parsed ? parsed.major < 25 || (parsed.major === 25 && parsed.minor < 10) : false;
}

// --- Alerts ---------------------------------------------------------------------

// The levels of TrueNAS alerts, least to most serious (AlertLevel of the middleware).
export const ALERT_LEVELS = [
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

export const levelRank = (level) => ALERT_LEVELS.indexOf(level);

function parseAlert(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const id = text(raw.uuid) ?? text(raw.id);
  if (!id) {
    return null;
  }
  const level = String(raw.level ?? '').toLowerCase();
  return {
    id,
    level: ALERT_LEVELS.includes(level) ? level : 'warning',
    klass: text(raw.klass) ?? text(raw.source) ?? '',
    // The text of TrueNAS, in English: the NAS has no other language.
    text: (text(raw.formatted) ?? text(raw.text) ?? text(raw.klass) ?? '').replace(/\s+/g, ' '),
    dismissed: raw.dismissed === true,
    args: raw.args ?? null,
    at: dateOf(raw.datetime),
  };
}

// --- Pools -------------------------------------------------------------------------

// The state of a pool: from its ZFS status, `errors` when ONLINE but not
// healthy (checksum errors, a device with errors). `severity` orders them for
// the "Pool degraded" trigger.
export const POOL_STATES = Object.freeze({
  online: { alert: false, severity: 0 },
  errors: { alert: true, severity: 1 },
  degraded: { alert: true, severity: 1 },
  unknown: { alert: true, severity: 1 },
  offline: { alert: true, severity: 2 },
  faulted: { alert: true, severity: 2 },
  unavail: { alert: true, severity: 2 },
  removed: { alert: true, severity: 2 },
  suspended: { alert: true, severity: 2 },
});

/** The key of POOL_STATES for a pool of pool.query. */
export function poolState({ status, healthy }) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'online') {
    return healthy === false ? 'errors' : 'online';
  }
  return POOL_STATES[value] ? value : 'unknown';
}

function parsePool(raw, datasets) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const name = text(raw.name);
  const id = raw.guid ?? raw.id ?? name;
  if (!name || id === null || id === undefined) {
    return null;
  }
  // The root dataset tells the space as the user sees it; the pool sizes are
  // raw (parity included), the fallback only.
  const dataset = datasets?.get(name);
  let used = number(dataset?.used?.parsed);
  let free = number(dataset?.available?.parsed);
  if (used === null || free === null) {
    used = number(raw.allocated);
    free = number(raw.free);
  }
  const total = used !== null && free !== null ? used + free : null;
  const scan = raw.scan && typeof raw.scan === 'object' ? raw.scan : null;
  const isScrub = String(scan?.function ?? '').toUpperCase() === 'SCRUB';
  const scanState = String(scan?.state ?? '').toUpperCase();
  const pool = {
    key: safeKey(id),
    name,
    status: String(raw.status ?? 'UNKNOWN').toUpperCase(),
    healthy: raw.healthy !== false,
    used,
    free,
    total,
    percent: total ? (used / total) * 100 : null,
    // The last scrub that finished, and its errors (a resilver is not a scrub).
    lastScrubAt: isScrub && scanState === 'FINISHED' ? dateOf(scan.end_time) : null,
    scrubErrors: isScrub && scanState === 'FINISHED' ? number(scan.errors) : null,
    scrubbing: isScrub && scanState === 'SCANNING',
  };
  pool.state = poolState(pool);
  return pool;
}

// --- Disks ---------------------------------------------------------------------------

// The SMART summary of a disk: `failed` after a failed self-test (25.04) or a
// SMARTFailedSelfTest alert, `warning` while a SMART* alert names it, `ok`
// otherwise, `unknown` when the alerts could not be read.
export const DISK_STATES = Object.freeze({
  ok: { alert: false, severity: 0 },
  unknown: { alert: false, severity: 0 },
  warning: { alert: true, severity: 1 },
  failed: { alert: true, severity: 2 },
});

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a SMART alert names this disk (by serial number, else by name). */
function alertNames(alert, disk) {
  const haystack = `${alert.text} ${JSON.stringify(alert.args ?? '')}`;
  if (disk.serial && haystack.includes(disk.serial)) {
    return true;
  }
  return disk.name
    ? new RegExp(`(?<![A-Za-z0-9])${escape(disk.name)}(?![A-Za-z0-9])`).test(haystack)
    : false;
}

function smartOf(disk, alerts, tests) {
  const results = tests?.get(disk.name);
  const lastTest = results?.[0];
  let state = alerts ? 'ok' : 'unknown';
  if (String(lastTest?.status ?? '').toUpperCase() === 'FAILED') {
    state = 'failed';
  }
  for (const alert of alerts ?? []) {
    if (alert.dismissed || !alert.klass.startsWith('SMART') || !alertNames(alert, disk)) {
      continue;
    }
    if (alert.klass === 'SMARTFailedSelfTest') {
      state = 'failed';
    } else if (state !== 'failed') {
      state = 'warning';
    }
  }
  return state;
}

function parseDisks(rawDisks, temperatures, alerts, smartResults) {
  const rows = (list(rawDisks) ?? []).filter((d) => d && typeof d === 'object' && text(d.name));
  // Serial numbers identify a disk across reboots (sda may become sdb); some
  // USB bridges give none, or the same to every disk: then the identifier.
  const serials = rows.map((d) => text(d.serial));
  const tests = new Map();
  for (const entry of list(smartResults) ?? []) {
    if (entry && text(entry.disk) && Array.isArray(entry.tests)) {
      tests.set(entry.disk, entry.tests);
    }
  }
  return rows.map((raw, index) => {
    const serial = serials[index];
    const unique = serial && serials.filter((s) => s === serial).length === 1;
    const disk = {
      key: safeKey(unique ? serial : (text(raw.identifier) ?? raw.name)),
      name: raw.name,
      serial,
      model: text(raw.model),
      type: text(raw.type),
      size: number(raw.size),
      pool: text(raw.pool),
      temperature: number(temperatures?.[raw.name]),
    };
    disk.state = smartOf(disk, alerts, smartResults ? tests : null);
    return disk;
  });
}

// --- Apps and virtual machines ---------------------------------------------------------

// The state of an app (app.query), of a VM (vm.query, container.query) or of
// an Incus instance (virt.instance.query), lower case. Anything else is `unknown`.
export const RUN_STATES = Object.freeze([
  'running',
  'stopped',
  'deploying',
  'starting',
  'stopping',
  'crashed',
  'suspended',
  'error',
  'unknown',
]);

function runState(value) {
  const state = String(value ?? '').toLowerCase();
  if (state === 'frozen' || state === 'freezing') {
    return 'suspended';
  }
  if (state === 'aborting') {
    return 'stopping';
  }
  if (state === 'thawed') {
    return 'running';
  }
  return RUN_STATES.includes(state) ? state : 'unknown';
}

function parseApps(raw) {
  const apps = list(raw);
  if (!apps) {
    return null;
  }
  return apps
    .filter((app) => app && text(app.name))
    .map((app) => {
      const state = runState(app.state);
      return {
        key: safeKey(app.name),
        ref: app.name,
        name: app.name,
        state,
        running: state === 'running',
        update: app.upgrade_available === true || app.image_updates_available === true,
        version: text(app.human_version) ?? text(app.version),
      };
    });
}

// The kinds of virtual machine, each with its own methods (src/truenas/client.js).
export const VM_KINDS = Object.freeze({
  VM: 'vm',
  INSTANCE: 'instance',
  CONTAINER: 'container',
});

function parseVms({ vms, instances, containers }) {
  if (!list(vms) && !list(instances) && !list(containers)) {
    return null;
  }
  const out = [];
  for (const vm of list(vms) ?? []) {
    if (vm && Number.isFinite(vm.id) && text(vm.name)) {
      const state = runState(vm.status?.state);
      out.push({ key: `vm-${vm.id}`, kind: VM_KINDS.VM, ref: vm.id, name: vm.name, state });
    }
  }
  for (const instance of list(instances) ?? []) {
    const id = text(instance?.id) ?? text(instance?.name);
    if (id) {
      const state = runState(instance.status);
      out.push({
        key: `instance-${safeKey(id)}`,
        kind: VM_KINDS.INSTANCE,
        ref: id,
        name: text(instance.name) ?? id,
        state,
        // An Incus instance is a VM or a system container.
        container: String(instance.type ?? '').toUpperCase() === 'CONTAINER',
      });
    }
  }
  for (const container of list(containers) ?? []) {
    if (container && Number.isFinite(container.id) && text(container.name)) {
      const state = runState(container.status?.state);
      out.push({
        key: `container-${container.id}`,
        kind: VM_KINDS.CONTAINER,
        ref: container.id,
        name: container.name,
        state,
        container: true,
      });
    }
  }
  return out.map((vm) => ({ ...vm, running: vm.state === 'running' }));
}

// --- System -----------------------------------------------------------------------------

/** The last finite value of a column of a reporting graph (the last row may be partial). */
function lastValue(graph, columns) {
  const legend = list(graph?.legend);
  const rows = list(graph?.data);
  if (!legend || !rows) {
    return null;
  }
  const indexes = legend
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name !== 'time' && columns(name))
    .map(({ index }) => index);
  if (indexes.length === 0) {
    return null;
  }
  for (let row = rows.length - 1; row >= 0; row -= 1) {
    const values = indexes.map((index) => number(rows[row]?.[index])).filter((v) => v !== null);
    if (values.length > 0) {
      return Math.max(...values);
    }
  }
  return null;
}

function parseStats(graphs, physmem) {
  const byName = new Map((list(graphs) ?? []).map((graph) => [graph?.name, graph]));
  const cpuGraph = byName.get('cpu');
  const cpu = cpuGraph
    ? (lastValue(cpuGraph, (name) => name === 'cpu') ??
      lastValue(cpuGraph, (name) => name === 'usage'))
    : null;
  const available = lastValue(byName.get('memory'), (name) => name === 'available');
  const memory = available !== null && physmem ? ((physmem - available) / physmem) * 100 : null;
  const cpuTemperature = lastValue(byName.get('cputemp'), () => true);
  const clamp = (value) => (value === null ? null : Math.min(100, Math.max(0, value)));
  return {
    cpu: clamp(cpu),
    memory: clamp(memory),
    // 0 °C is a missing sensor, not a temperature.
    cpuTemperature: cpuTemperature && cpuTemperature > 0 ? cpuTemperature : null,
  };
}

/** The update offered: `{ version }`, null when up to date, undefined when unknown. */
function parseUpdate(raw) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  // 25.10+: update.status
  if ('status' in raw && (raw.status === null || typeof raw.status === 'object')) {
    if (raw.code === 'ERROR' || !raw.status) {
      return undefined;
    }
    const version = text(raw.status.new_version?.version);
    return version ? { version } : null;
  }
  // 25.04: update.check_available
  if (raw.status === 'AVAILABLE') {
    return { version: text(raw.version) ?? '?' };
  }
  if (raw.status === 'UNAVAILABLE' || raw.status === 'REBOOT_REQUIRED') {
    return null;
  }
  return undefined;
}

// What a board without DMI data says in place of a product name.
const PLACEHOLDER_PRODUCT = /to be filled|default string|system product name|not specified|^none$/i;
const realProduct = (value) => {
  const product = text(value);
  return product && !PLACEHOLDER_PRODUCT.test(product) ? product : null;
};

/**
 * Everything the integration knows of the NAS after one read. A part the NAS
 * did not answer is null (its error in `errors`): the hub keeps its previous
 * value instead of making devices disappear.
 * @param {object} raw the answers collected by the client
 */
export function parseSnapshot(raw) {
  const info = raw.info ?? {};
  const alerts = list(raw.alerts) ? raw.alerts.map(parseAlert).filter(Boolean) : null;
  const datasets = new Map(
    (list(raw.datasets) ?? []).filter((d) => d && text(d.id)).map((d) => [d.id, d]),
  );
  const pools = list(raw.pools)
    ? raw.pools.map((p) => parsePool(p, datasets)).filter(Boolean)
    : null;
  const active = alerts?.filter((alert) => !alert.dismissed) ?? null;
  const top = active?.reduce(
    (worst, alert) =>
      worst === null || levelRank(alert.level) > levelRank(worst) ? alert.level : worst,
    null,
  );
  const update = raw.update === undefined ? undefined : parseUpdate(raw.update);
  return {
    platformId: text(raw.hostId) ? safeKey(raw.hostId).slice(0, 16) : null,
    name: text(info.hostname),
    version: text(info.version),
    legacy: isLegacy(info.version),
    product: realProduct(info.system_product),
    manufacturer: text(info.system_manufacturer),
    uptime: number(info.uptime_seconds),
    physmem: number(info.physmem),
    ...parseStats(raw.stats, number(info.physmem)),
    alerts: active,
    alertLevel: active ? (top ?? 'none') : null,
    // undefined: not checked this time (kept from before by the hub).
    update,
    pools,
    disks: list(raw.disks) ? parseDisks(raw.disks, raw.temperatures, alerts, raw.smart) : null,
    apps: parseApps(raw.apps),
    vms: parseVms(raw),
    errors: { ...(raw.errors ?? {}) },
  };
}
