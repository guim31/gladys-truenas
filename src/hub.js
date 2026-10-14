// -----------------------------------------------------------------------------
// The NAS hub: reads the NAS on a timer of the container (the interval chosen
// in the configuration, one minute at most often), publishes the states of the
// devices the user added when they change, fires the scene events on
// transitions (src/watcher.js), runs the start / stop of apps and VMs and the
// restart and shutdown the user allowed, and serves the views of the widget
// and of the "Test the connection" action.
//
// Gladys never polls these devices (should_poll: false, Gladys#3198): the
// configurable interval goes up to 5 minutes, beyond the fixed list of the
// core scheduler, and the scene events must fire for every pool and alert,
// added to Gladys or not.
//
// What one read costs the NAS (src/truenas/client.js): about ten light
// method calls on an open WebSocket at every read; the disks every 5 minutes
// at most often; the update check (the NAS asks the TrueNAS update server)
// every 6 hours.
//
// The 300 states per minute of Gladys: a few dozen features read once a minute
// at most, and only what changed is sent (publishChangedStates of the SDK);
// every value is sent again after 6 hours unchanged, before the front shows
// "no recent value".
//
// Logs stay quiet: a normal read writes at the debug level only, and a failure
// that repeats on every read (Gladys refusing the states, a NAS that stays
// silent, a part the API key may not read) writes one line when it starts and
// one when it ends.
//
// A refused API key is never retried on the timer: each try is a failed login
// in the audit log of the NAS. Saving the configuration, "Test the
// connection" or the Refresh button of the widget try again.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { hostOf, isComplete } from './config.js';
import {
  DEVICE_TYPES,
  FEATURE_KEYS,
  NAMES,
  buildDevice,
  deviceIds,
  deviceStates,
} from './devices.js';
import { ERROR_KINDS, POWER_ACTIONS, RUN_ACTIONS, TruenasClient } from './truenas/client.js';
import { VM_KINDS, parseSnapshot } from './truenas/model.js';
import {
  COMMAND_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  POOL_STATE_TEXT,
  REPORT_TEXT,
  labelled,
  pick,
} from './texts.js';
import { Watcher } from './watcher.js';

const logger = createLogger({ name: 'truenas-hub' });

export const WIDGET_KEY = 'nas';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  POOL: 'pool_degraded',
  ALERT: 'new_alert',
});

export const HUB_TIMINGS = {
  // A NAS that fails once is read again this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // Failures in a row before the NAS counts as offline.
  downAfterFailures: 2,
  // An unchanged value is sent again after this long.
  heartbeatMs: 6 * 3600_000,
  // The disks (temperatures, SMART) are read this often at most.
  diskIntervalMs: 5 * 60_000,
  // The update check, this often.
  updateIntervalMs: 6 * 3600_000,
};

// New alerts announced by one read at most: a NAS that raises fifty at once
// (a whole shelf of disks gone) must not flood the scenes.
export const MAX_ALERT_EVENTS_PER_READ = 10;

const MAX_TRANSPORTS_PER_REQUEST = 100;
// The errors that wait for the user instead of being retried on the timer.
const BLOCKING = new Set([ERROR_KINDS.AUTH, ERROR_KINDS.PERMISSION]);

const signature = (config) => JSON.stringify([config.url, config.apiKey, config.insecure]);

// The parts of a snapshot kept from the previous read when the NAS did not
// answer them this time, so the devices do not flicker.
const KEPT_PARTS = ['alerts', 'pools', 'disks', 'apps', 'vms'];

export class NasHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.open] WebSocket seam (src/truenas/socket.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   * @param {object} [options.client] TruenasClient options overrides (tests)
   */
  constructor({ gladys, store, open, timers = true, timings, now, client = {} }) {
    this.gladys = gladys;
    this.store = store;
    this.open = open;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.clientOptions = client;
    this.config = null;
    this.signature = null;
    this.client = null;
    this.watcher = new Watcher();
    this.resetRead();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.pollTimer = null;
    this.retryTimer = null;
    this.polling = null;
    this.stopped = false;
    /** The failures already logged, until they end (see failed/recovered). */
    this.failing = new Set();
  }

  resetRead() {
    /** @type {object|null} the last snapshot read (src/truenas/model.js) */
    this.snapshot = null;
    this.readAt = 0;
    this.disksAt = 0;
    this.updateAt = 0;
    this.error = null;
    this.failures = 0;
    this.down = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.watcher = new Watcher(await this.store.load());
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config, { force: true });
  }

  async reconfigure(config, { force = false } = {}) {
    const previous = this.config;
    this.config = config;
    const wanted = isComplete(config) ? signature(config) : null;
    if (wanted !== this.signature) {
      this.signature = wanted;
      this.client?.close();
      this.client = null;
      // Another address may be another NAS: nothing of the old one is kept.
      clearTimeout(this.retryTimer);
      this.resetRead();
      if (wanted) {
        this.client = new TruenasClient({
          url: config.url,
          apiKey: config.apiKey,
          insecure: config.insecure,
          now: this.now,
          ...(this.open ? { open: this.open } : {}),
          ...this.clientOptions,
        });
      }
    }
    if (previous?.language !== config.language || previous?.appControl !== config.appControl) {
      this.discovered = null;
    }
    if (this.client) {
      // Saving the configuration is a manual request: a refused key is tried again.
      await this.poll({ manual: true });
    }
    await this.afterChanges(true, { publish: true, force });
    this.schedulePoll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retryTimer);
    this.client?.close();
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.afterChanges(await this.poll());
        this.recovered('poll');
      } catch (err) {
        this.failed('poll', 'Read cycle failed', err);
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  // --- Names and identities ----------------------------------------------------

  /** The platform id of the NAS: its host id, else something stable enough. */
  get nasId() {
    if (this.snapshot?.platformId) {
      return this.snapshot.platformId;
    }
    if (this.watcher.saved.nas) {
      return this.watcher.saved.nas;
    }
    return this.config?.url
      ? `h${createHash('sha1').update(this.config.url).digest('hex').slice(0, 15)}`
      : null;
  }

  /** The NAS name: its host name, or its address. */
  get nasName() {
    return this.snapshot?.name ?? (this.config?.url ? hostOf(this.config.url) : 'TrueNAS');
  }

  nasDeviceId() {
    return deviceIds(this.gladys, DEVICE_TYPES.NAS, this.nasId).device;
  }

  /** Every device the snapshot proposes: the NAS, its pools, disks, apps and VMs. */
  items() {
    const { snapshot } = this;
    if (!snapshot) {
      return [];
    }
    const nas = this.nasName;
    const diskWord = (NAMES[this.config?.language] ?? NAMES.en).disk;
    return [
      {
        type: DEVICE_TYPES.NAS,
        key: null,
        name: nas,
        model: snapshot.product ? `TrueNAS (${snapshot.product})` : 'TrueNAS',
        item: snapshot,
      },
      ...(snapshot.pools ?? []).map((pool) => ({
        type: DEVICE_TYPES.POOL,
        key: pool.key,
        name: `${nas} ${pool.name}`,
        model: 'ZFS pool',
        item: pool,
      })),
      ...(snapshot.disks ?? []).map((disk) => ({
        type: DEVICE_TYPES.DISK,
        key: disk.key,
        // The serial number, as TrueNAS shows it: the name (sda) moves at reboot.
        name: `${nas} ${diskWord} ${disk.serial ?? disk.name}`,
        model: disk.model ?? 'Disk',
        item: disk,
      })),
      ...(snapshot.apps ?? []).map((app) => ({
        type: DEVICE_TYPES.APP,
        key: `app-${app.key}`,
        name: `${nas} ${app.name}`,
        model: 'TrueNAS app',
        item: app,
      })),
      ...(snapshot.vms ?? []).map((vm) => ({
        type: DEVICE_TYPES.VM,
        key: vm.key,
        name: `${nas} ${vm.name}`,
        model: vm.container ? 'Container' : 'Virtual machine',
        item: vm,
      })),
    ];
  }

  /** The created devices of this NAS, with what they stand for in the last read (null: gone). */
  createdDevices() {
    const nasId = this.nasId;
    if (!nasId) {
      return [];
    }
    const byId = new Map(
      this.items().map((entry) => [
        deviceIds(this.gladys, entry.type, nasId, entry.key).device,
        entry,
      ]),
    );
    const nasDevice = this.nasDeviceId();
    const created = [];
    for (const device of this.gladys.devices ?? []) {
      const entry = byId.get(device.external_id);
      if (entry) {
        created.push({ device, ...entry });
      } else if (device.external_id === nasDevice) {
        // The NAS before its first answer, or offline.
        created.push({ device, type: DEVICE_TYPES.NAS, key: null, item: null });
      }
    }
    return created;
  }

  isOurs(externalId) {
    return this.createdDevices().some(({ device }) => device.external_id === externalId);
  }

  // --- Devices -----------------------------------------------------------------

  discoveredDevices() {
    const nasId = this.nasId;
    return this.items().map((entry) =>
      buildDevice(this.gladys, {
        ...entry,
        nasId,
        language: this.config.language,
        control: this.config.appControl,
      }),
    );
  }

  /** Publish the Discovery list when it changed (a disk added, an app installed…). */
  async publishDevices({ force = false } = {}) {
    // The external ids hang on the host id of the NAS: never publish under a
    // makeshift id that would change at the next read (ids are forever).
    if (!this.snapshot || (!this.snapshot.platformId && !this.watcher.saved.nas)) {
      return;
    }
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.recovered('discovery');
    } catch (err) {
      this.failed('discovery', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read the NAS, publish the list again. */
  async rediscover() {
    this.disksAt = 0;
    await this.poll({ manual: true });
    await this.afterChanges(true, { publish: true });
  }

  /** The user added (or updated) a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    if (!this.isOurs(device.external_id)) {
      return;
    }
    // A device deleted then added again is a new row in Gladys: no badge yet.
    this.transports.delete(device.external_id);
    await this.publishStates({ force: true, only: device.external_id });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  onDeviceDeleted(device) {
    if (typeof device?.external_id === 'string') {
      this.transports.delete(device.external_id);
    }
  }

  // --- Reading the NAS -----------------------------------------------------------

  /**
   * Read the NAS and apply what changed. Concurrent calls share the read. A
   * refused key is only tried again on a manual request.
   * @returns {Promise<boolean>} whether the widget should be refreshed now
   */
  poll({ manual = false } = {}) {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!manual && this.error && BLOCKING.has(this.error.kind)) {
      return Promise.resolve(false);
    }
    const client = this.client;
    this.polling ??= this.read(client).finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /**
   * onPoll, should Gladys ever poll: the hub already reads on its own timer,
   * so a read less than half an interval old is enough.
   */
  async pollIfStale() {
    if (this.readAt && this.now() - this.readAt < this.config.pollIntervalMs / 2) {
      return false;
    }
    return this.poll();
  }

  async read(client) {
    const now = this.now();
    const disks = !this.snapshot?.disks || now - this.disksAt >= this.timings.diskIntervalMs;
    const update = now - this.updateAt >= this.timings.updateIntervalMs;
    try {
      const raw = await client.read({ disks, update });
      if (client !== this.client) {
        return false;
      }
      if (disks) {
        this.disksAt = now;
      }
      if (update) {
        this.updateAt = now;
      }
      return await this.applySuccess(raw, { disks });
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      return client === this.client ? this.applyFailure(err) : false;
    }
  }

  /** Keep what a part that failed (or was not read) this time said before. */
  merge(snapshot, { disks }) {
    const previous = this.snapshot;
    if (!disks) {
      snapshot.disks = previous?.disks ?? null;
    }
    if (snapshot.update === undefined) {
      snapshot.update = previous?.update;
    }
    for (const part of KEPT_PARTS) {
      if (snapshot[part] === null && previous?.[part]) {
        snapshot[part] = previous[part];
        if (part === 'alerts') {
          snapshot.alertLevel = previous.alertLevel;
        }
      }
    }
    // A graph that failed this time: the feature stays (its structure does not move).
    for (const key of ['cpu', 'memory', 'cpuTemperature']) {
      if (snapshot[key] === null && previous?.[key] !== null && previous?.[key] !== undefined) {
        const graph = { cpu: 'cpu', memory: 'memory', cpuTemperature: 'cputemp' }[key];
        if (snapshot.errors[`graph ${graph}`]) {
          snapshot[key] = previous[key];
        }
      }
    }
    // A pool whose last scan is now a resilver keeps the date of its last scrub.
    for (const pool of snapshot.pools ?? []) {
      const before = previous?.pools?.find((p) => p.key === pool.key);
      if (pool.lastScrubAt === null && before?.lastScrubAt) {
        pool.lastScrubAt = before.lastScrubAt;
        pool.scrubErrors = before.scrubErrors;
      }
    }
    // A disk asleep tells no temperature: the last one stays.
    for (const disk of snapshot.disks ?? []) {
      const before = previous?.disks?.find((d) => d.key === disk.key);
      if (disk.temperature === null && before?.temperature !== null) {
        disk.temperature = before?.temperature ?? null;
      }
    }
    return snapshot;
  }

  async applySuccess(raw, parts) {
    const snapshot = this.merge(parseSnapshot(raw), parts);
    logger.debug(
      `Read: ${snapshot.pools?.length ?? 0} pool(s), ${snapshot.disks?.length ?? 0} disk(s), ` +
        `${snapshot.apps?.length ?? 0} app(s), ${snapshot.vms?.length ?? 0} VM(s), ` +
        `${snapshot.alerts?.length ?? 0} alert(s)`,
    );
    const widgetChanged = this.error !== null || this.readAt === 0 || this.down;
    if (this.error || this.down) {
      logger.info(`${this.config.url ? hostOf(this.config.url) : 'NAS'} answers again`);
    }
    for (const [part, message] of Object.entries(snapshot.errors)) {
      this.failed(`part ${part}`, `Cannot read the ${part}: ${message}`);
    }
    for (const part of [...this.failing].filter((key) => key.startsWith('part '))) {
      const name = part.slice('part '.length);
      const wasRead = name.startsWith('graph ') || name === 'host id' || raw[name] !== undefined;
      if (!snapshot.errors[name] && wasRead) {
        this.recovered(part);
      }
    }
    if (!this.snapshot) {
      logger.info(
        `Connected to TrueNAS ${snapshot.version ?? '?'} (${snapshot.name ?? 'NAS'}), ` +
          `${snapshot.pools?.length ?? 0} pool(s), ${snapshot.apps?.length ?? 0} app(s), ` +
          `${snapshot.vms?.length ?? 0} VM(s)`,
      );
    }
    this.snapshot = snapshot;
    this.error = null;
    this.failures = 0;
    this.down = false;
    this.readAt = this.now();
    clearTimeout(this.retryTimer);

    let changed = widgetChanged;
    if (!snapshot.platformId && !this.watcher.saved.nas) {
      // No identity yet (system.host_id refused this time): no event under
      // an id that would change, the next read tries again.
      await this.publishStates();
      return changed;
    }
    this.watcher.bind(this.nasId);
    const language = this.config.language;
    const nasName = this.nasName;
    const nasId = this.nasId;
    for (const pool of this.watcher.pools(snapshot.pools)) {
      changed = true;
      logger.warn(
        `${nasName} pool ${pool.name}: ${pool.status}${pool.healthy ? '' : ' (unhealthy)'}`,
      );
      await this.fireEvent(TRIGGERS.POOL, {
        pool: deviceIds(this.gladys, DEVICE_TYPES.POOL, nasId, pool.key).device,
        nas_name: nasName,
        pool_name: pool.name,
        state: pick(POOL_STATE_TEXT[pool.state], language),
      });
    }
    const fresh = this.watcher.alerts(snapshot.alerts);
    if (fresh.length > 0) {
      changed = true;
    }
    for (const alert of fresh.slice(0, MAX_ALERT_EVENTS_PER_READ)) {
      logger.debug(`${nasName}: new ${alert.level} alert ${alert.klass}`);
      await this.fireEvent(TRIGGERS.ALERT, {
        level: alert.level,
        nas_name: nasName,
        text: alert.text.slice(0, 1000),
        alert_class: alert.klass,
      });
    }
    if (fresh.length > MAX_ALERT_EVENTS_PER_READ) {
      logger.warn(`${nasName}: ${fresh.length} new alerts, ${MAX_ALERT_EVENTS_PER_READ} announced`);
    }
    this.store.save(this.watcher.saved);
    await this.publishStates();
    return changed;
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`NAS: ${err.message}`);
    }
    // Only silence counts as offline: a refused key is a configuration
    // problem, reported by the connection status.
    if (err.kind !== ERROR_KINDS.UNREACHABLE) {
      this.failures = 0;
      return wasError !== err.kind;
    }
    this.failures += 1;
    if (this.failures === 1) {
      this.scheduleRetry();
    }
    if (!this.down && this.failures >= this.timings.downAfterFailures) {
      this.down = true;
      await this.publishStates();
      return true;
    }
    if (this.down) {
      await this.publishStates();
    }
    return wasError !== err.kind;
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.poll()
        .then((changed) => this.afterChanges(changed))
        .then(() => this.recovered('poll'))
        .catch((err) => this.failed('poll', 'Read cycle failed', err));
    }, this.timings.retryMs);
    this.retryTimer.unref?.();
  }

  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.recovered('scene event');
    } catch (err) {
      this.failed('scene event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  /**
   * A failure that may repeat on every read: logged when it starts, then at
   * the debug level only, until recovered() logs its end.
   */
  failed(key, message, err) {
    // An exception (err given) is a bug: error, with its stack.
    const first = err ? logger.error : logger.warn;
    const log = this.failing.has(key) ? logger.debug : first;
    this.failing.add(key);
    log(...(err ? [message, err] : [message]));
  }

  recovered(key) {
    if (this.failing.delete(key)) {
      logger.info(`${key}: back to normal`);
    }
  }

  // --- Commands ----------------------------------------------------------------------

  /** A command refused by the NAS, in words for the user. */
  commandError(err, language) {
    if (!err.kind) {
      return err;
    }
    return new Error(labelled(this.nasName, pick(ERROR_TEXT[err.kind], language), language), {
      cause: err,
    });
  }

  /**
   * The Start / stop switch of an app or a VM: only when the user allowed it
   * in the configuration (checked at every call, it may change).
   */
  async setValue(device, feature, value) {
    const language = this.config?.language;
    const entry = this.createdDevices().find((e) => e.device.external_id === device.external_id);
    const isSwitch =
      entry &&
      (entry.type === DEVICE_TYPES.APP || entry.type === DEVICE_TYPES.VM) &&
      feature.external_id ===
        deviceIds(this.gladys, entry.type, this.nasId, entry.key).feature(FEATURE_KEYS.POWER);
    if (!isSwitch) {
      throw new Error(`Feature ${feature.external_id} cannot be controlled`);
    }
    if (!this.config.appControl) {
      throw new Error(pick(COMMAND_TEXT.appControlDisabled, language));
    }
    if (!this.client || !this.snapshot || this.error) {
      throw new Error(pick(COMMAND_TEXT.notConnected, language));
    }
    if (!entry.item) {
      throw new Error(pick(COMMAND_TEXT.unknownTarget, language));
    }
    const action = Number(value) === 1 ? RUN_ACTIONS.START : RUN_ACTIONS.STOP;
    const kind = entry.type === DEVICE_TYPES.APP ? 'app' : (entry.item.kind ?? VM_KINDS.VM);
    logger.info(`${this.nasName} ${entry.item.name}: ${action} asked from Gladys`);
    try {
      await this.client.run(kind, entry.item.ref, action);
    } catch (err) {
      logger.warn(`${this.nasName} ${entry.item.name}: ${action} refused: ${err.message}`);
      throw this.commandError(err, language);
    } finally {
      // The real state, whatever happened.
      await this.afterChanges(await this.poll({ manual: true }));
    }
  }

  /**
   * Restart or shut down the NAS, for a scene: only when the user allowed it
   * in the configuration. Throws (the scene logs it) otherwise.
   * @param {'restart'|'shutdown'} action
   */
  async power(action) {
    const language = this.config?.language;
    if (!this.config?.powerActions) {
      throw new Error(pick(COMMAND_TEXT.powerDisabled, language));
    }
    if (!this.client || !this.snapshot || this.error) {
      throw new Error(pick(COMMAND_TEXT.notConnected, language));
    }
    logger.info(`${this.nasName}: ${action} sent by a scene`);
    try {
      await this.client.power(action === POWER_ACTIONS.SHUTDOWN ? action : POWER_ACTIONS.RESTART);
    } catch (err) {
      logger.warn(`${this.nasName}: ${action} refused: ${err.message}`);
      throw this.commandError(err, language);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /**
   * The states of the devices the user added.
   * @param {object} [options]
   * @param {boolean} [options.force] send even unchanged values (a device just added)
   * @param {string} [options.only] the external id of the one device to send
   */
  async publishStates({ force = false, only = null } = {}) {
    const nasId = this.nasId;
    const context = {
      online: this.error === null && this.snapshot !== null,
      language: this.config.language,
      now: this.now(),
    };
    const control = this.config.appControl;
    const states = [];
    for (const { device, type, key, item } of this.createdDevices()) {
      if (only && device.external_id !== only) {
        continue;
      }
      if (this.error || !this.snapshot) {
        // Nothing read: only say the NAS is offline once it is.
        if (type === DEVICE_TYPES.NAS && this.down) {
          states.push(
            ...deviceStates(this.gladys, { type, nasId, key, item: null, context }).filter(
              (state) => state.device_feature_external_id.endsWith(`:${FEATURE_KEYS.ONLINE}`),
            ),
          );
        }
        continue;
      }
      if (item === null) {
        continue;
      }
      states.push(...deviceStates(this.gladys, { type, nasId, key, item, context, control }));
    }
    if (states.length === 0) {
      return;
    }
    try {
      if (force) {
        // Sent again even unchanged, and remembered for the next comparisons.
        this.gladys.forgetPublishedStates(only ?? undefined);
      }
      // Batches of 100 at most: done by the SDK.
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.recovered('states');
    } catch (err) {
      this.failed('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false, force = false } = {}) {
    await this.publishDevices({ force: publish });
    if (force) {
      await this.publishStates({ force: true });
    }
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: "local", or "unreachable". */
  async publishTransports() {
    if (this.readAt === 0) {
      return;
    }
    const entries = [];
    for (const { device, type, item } of this.createdDevices()) {
      // An app or VM removed from the NAS is unreachable, the NAS itself fine.
      const reachable = this.error === null && (type === DEVICE_TYPES.NAS || item !== null);
      const transport = reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    let refused = false;
    for (let index = 0; index < entries.length; index += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(index, index + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        refused = true;
        this.failed('transports', `Transports refused: ${err.message}`);
      }
    }
    if (entries.length > 0 && !refused) {
      this.recovered('transports');
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (!this.config || !this.client) {
      let message = CONNECTION_TEXT.notConfigured;
      if (this.config?.addressInsecure) {
        message = CONNECTION_TEXT.insecureAddress;
      } else if (this.config?.addressInvalid) {
        message = CONNECTION_TEXT.invalidAddress;
      }
      return { connected: false, message };
    }
    if (!this.error) {
      return { connected: this.snapshot !== null };
    }
    const message = {};
    for (const language of Object.keys(ERROR_TEXT[this.error.kind])) {
      message[language] = labelled(
        this.nasName,
        pick(ERROR_TEXT[this.error.kind], language),
        language,
      ).slice(0, 200);
    }
    return { connected: false, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.recovered('connection status');
    } catch (err) {
      this.failed('connection status', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, test action) --------------------------------------------------

  /** What the widget shows of the NAS. */
  view() {
    return {
      configured: Boolean(this.client),
      name: this.nasName,
      online: this.error === null && this.snapshot !== null,
      error: this.error,
      snapshot: this.snapshot,
    };
  }

  /** "Test the connection": read the NAS now, one line. */
  async testConnection() {
    if (this.client) {
      this.disksAt = 0;
      await this.afterChanges(await this.poll({ manual: true }), { publish: true });
    }
    const message = {};
    for (const [language, words] of Object.entries(REPORT_TEXT)) {
      if (!this.client) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      if (this.error) {
        message[language] = labelled(
          this.nasName,
          pick(ERROR_TEXT[this.error.kind], language),
          language,
        );
        continue;
      }
      const { snapshot } = this;
      const parts = [
        words.ok,
        snapshot.version ? `TrueNAS ${snapshot.version}` : null,
        words.pools(snapshot.pools?.length ?? 0),
        words.disks(snapshot.disks?.length ?? 0),
        words.apps(snapshot.apps?.length ?? 0),
        words.vms(snapshot.vms?.length ?? 0),
        words.alerts(snapshot.alerts?.length ?? 0),
        Object.keys(snapshot.errors).length > 0 ? words.partial : null,
      ];
      message[language] = labelled(this.nasName, parts.filter(Boolean).join(', '), language).slice(
        0,
        200,
      );
    }
    return message;
  }
}
