// -----------------------------------------------------------------------------
// The TrueNAS client: one WebSocket to `wss://<host>/api/current` (JSON-RPC
// 2.0, TrueNAS 25.04 and later), logged in once with the API key
// (`auth.login_with_api_key`, the method of the Home Assistant integration,
// still there in 26.0), kept open between the reads and opened again when it
// drops. Read only, but for the start and stop of apps and virtual machines
// and the restart and shutdown the user allowed (src/hub.js checks it).
//
// Never over plain HTTP: TrueNAS revokes an API key that logs in on an
// insecure transport (src/config.js refuses http:// addresses).
//
// What one read asks the NAS (src/truenas/model.js says what is used):
//   - every read: system.info, three reporting graphs (cpu, memory,
//     cputemp), alert.list, pool.query and the root datasets of the pools,
//     app.query, vm.query (+ virt.instance.query on 25.04/25.10,
//     container.query on 26.0);
//   - with `disks`: disk.query, disk.temperatures (25.04: smartctl, told not
//     to wake a disk asleep; 25.10+: sysfs, cached by the NAS), and on 25.04
//     smart.test.results;
//   - with `update`: update.status (25.10+) or update.check_available (25.04),
//     which make the NAS ask the update server: rarely (src/hub.js).
// A part the NAS refuses or does not have is left out (`errors`), never the
// whole read: only system.info is required.
// -----------------------------------------------------------------------------

import { isLegacy, VM_KINDS } from './model.js';
import { ConnectionError, METHOD_NOT_FOUND, RpcConnection, RpcError } from './rpc.js';
import { openSocket } from './socket.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable',
  CERTIFICATE: 'certificate',
  NOT_TRUENAS: 'not_truenas',
  AUTH: 'auth',
  PERMISSION: 'permission',
  PROTOCOL: 'protocol',
});

export class TruenasError extends Error {
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'TruenasError';
    this.kind = kind;
  }
}

export const POWER_ACTIONS = Object.freeze({ RESTART: 'restart', SHUTDOWN: 'shutdown' });
export const RUN_ACTIONS = Object.freeze({ START: 'start', STOP: 'stop' });

// The errors of a TLS handshake that a self-signed certificate gives.
const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
// No TLS on that port, or no TrueNAS API at that path.
const NOT_TRUENAS_CODES = new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'EUNEXPECTED']);

const isAccessDenied = (err) => err instanceof RpcError && err.errname === 'EACCES';
const isNotAuthenticated = (err) => err instanceof RpcError && err.errname === 'ENOTAUTHENTICATED';

/** A failure to open the socket, in the words of ERROR_KINDS. */
export function classifyConnectionError(err) {
  const code = err?.code ?? err?.cause?.code;
  if (CERTIFICATE_CODES.has(code)) {
    return new TruenasError(ERROR_KINDS.CERTIFICATE, `Certificate refused (${code})`, {
      cause: err,
    });
  }
  if (NOT_TRUENAS_CODES.has(code) || /wrong version number/i.test(err?.message ?? '')) {
    return new TruenasError(ERROR_KINDS.NOT_TRUENAS, `No TrueNAS API here: ${err.message}`, {
      cause: err,
    });
  }
  return new TruenasError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err?.message ?? code}`, {
    cause: err,
  });
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class TruenasClient {
  /**
   * @param {object} options
   * @param {string} options.url the `wss://` URL of the API
   * @param {string} options.apiKey
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {Function} [options.open] socket seam (src/truenas/socket.js)
   * @param {() => number} [options.now]
   * @param {number} [options.jobPollMs] how often a started job is checked
   * @param {number} [options.jobTimeoutMs] how long a start or stop is waited for
   */
  constructor({
    url,
    apiKey,
    insecure = false,
    open = openSocket,
    now = () => Date.now(),
    jobPollMs = 2_000,
    jobTimeoutMs = 60_000,
  }) {
    this.url = url;
    this.apiKey = apiKey;
    this.insecure = insecure;
    this.open = open;
    this.now = now;
    this.jobPollMs = jobPollMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.rpc = null;
    this.connecting = null;
    /** The version read last, to pick the methods of 25.04 or 25.10+. */
    this.version = null;
    this.hostId = null;
  }

  // --- Connection ----------------------------------------------------------------

  /** A logged-in connection: the open one, or a new one. */
  connection() {
    if (this.rpc?.isOpen) {
      return Promise.resolve(this.rpc);
    }
    this.connecting ??= this.login().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async login() {
    const rpc = new RpcConnection({ url: this.url, insecure: this.insecure, open: this.open });
    try {
      await rpc.connect();
    } catch (err) {
      throw classifyConnectionError(err);
    }
    let accepted;
    try {
      accepted = await rpc.call('auth.login_with_api_key', [this.apiKey]);
    } catch (err) {
      rpc.close();
      if (err instanceof RpcError && err.code === METHOD_NOT_FOUND) {
        throw new TruenasError(
          ERROR_KINDS.NOT_TRUENAS,
          'No API key login: TrueNAS older than 25.04?',
        );
      }
      if (err instanceof RpcError) {
        throw new TruenasError(ERROR_KINDS.PROTOCOL, `Login: ${err.message}`, { cause: err });
      }
      throw classifyConnectionError(err);
    }
    if (accepted !== true) {
      rpc.close();
      // A wrong key, a revoked one (used over HTTP once), an expired one.
      throw new TruenasError(ERROR_KINDS.AUTH, 'API key refused');
    }
    this.rpc = rpc;
    return rpc;
  }

  close() {
    this.rpc?.close();
    this.rpc = null;
  }

  /**
   * Call a method on the logged-in connection. A connection that dropped
   * since the last read, or a session the NAS forgot, is opened again once.
   */
  async call(method, params = []) {
    const reused = Boolean(this.rpc?.isOpen);
    const rpc = await this.connection();
    try {
      return await rpc.call(method, params);
    } catch (err) {
      const lost = err instanceof ConnectionError || isNotAuthenticated(err);
      if (!lost) {
        throw err;
      }
      this.close();
      if (!reused) {
        throw err instanceof ConnectionError ? classifyConnectionError(err) : err;
      }
      const again = await this.connection();
      try {
        return await again.call(method, params);
      } catch (retryErr) {
        if (retryErr instanceof ConnectionError) {
          this.close();
          throw classifyConnectionError(retryErr);
        }
        throw retryErr;
      }
    }
  }

  /**
   * A part of the read: its answer, or null with the reason in `errors` (a
   * method this version does not have is just absent, no error).
   */
  async part(errors, name, method, params) {
    try {
      return await this.call(method, params);
    } catch (err) {
      if (!(err instanceof RpcError)) {
        throw err;
      }
      if (err.code !== METHOD_NOT_FOUND) {
        errors[name] = isAccessDenied(err) ? `${method}: access denied` : err.message;
      }
      return null;
    }
  }

  // --- Reading -----------------------------------------------------------------------

  /**
   * One read of the NAS.
   * @param {object} [options]
   * @param {boolean} [options.disks] read the disks too
   * @param {boolean} [options.update] check for an update too
   * @returns {Promise<object>} the answers, for parseSnapshot (src/truenas/model.js)
   */
  async read({ disks = true, update = false } = {}) {
    const errors = {};
    const raw = { errors };
    try {
      raw.info = await this.call('system.info');
    } catch (err) {
      if (isAccessDenied(err)) {
        throw new TruenasError(ERROR_KINDS.PERMISSION, 'system.info: access denied', {
          cause: err,
        });
      }
      if (err instanceof RpcError) {
        throw new TruenasError(ERROR_KINDS.PROTOCOL, err.message, { cause: err });
      }
      throw err;
    }
    if (!raw.info || typeof raw.info !== 'object') {
      throw new TruenasError(ERROR_KINDS.PROTOCOL, 'system.info: unexpected answer');
    }
    this.version = raw.info.version ?? null;
    const legacy = isLegacy(this.version);

    // The identity of the NAS, once per connection to it.
    this.hostId ??= await this.part(errors, 'host id', 'system.host_id');
    raw.hostId = this.hostId;

    // The last three minutes of the CPU, memory and CPU temperature graphs.
    const end = Math.floor(this.now() / 1000);
    raw.stats = [];
    for (const graph of ['cpu', 'memory', 'cputemp']) {
      const answer = await this.part(errors, `graph ${graph}`, 'reporting.netdata_get_data', [
        [{ name: graph }],
        { start: end - 180, end, aggregate: false },
      ]);
      raw.stats.push(...(Array.isArray(answer) ? answer : []));
    }

    raw.alerts = await this.part(errors, 'alerts', 'alert.list');
    raw.pools = await this.part(errors, 'pools', 'pool.query');
    const names = Array.isArray(raw.pools) ? raw.pools.map((p) => p?.name).filter(Boolean) : [];
    if (names.length > 0) {
      raw.datasets = await this.part(errors, 'datasets', 'pool.dataset.query', [
        [['id', 'in', names]],
        { extra: { retrieve_children: false, properties: ['used', 'available'] } },
      ]);
    }
    raw.apps = await this.part(errors, 'apps', 'app.query');
    raw.vms = await this.part(errors, 'vms', 'vm.query');
    // Incus instances (25.04, 25.10) and containers (26.0): absent elsewhere,
    // and an error while the feature is not set up is not worth a warning.
    raw.instances = await this.part({}, 'instances', 'virt.instance.query');
    raw.containers = await this.part({}, 'containers', 'container.query');

    if (disks) {
      raw.disks = await this.part(errors, 'disks', 'disk.query', [[], { extra: { pools: true } }]);
      const devices = Array.isArray(raw.disks) ? raw.disks.map((d) => d?.name).filter(Boolean) : [];
      raw.temperatures =
        devices.length === 0
          ? {}
          : await this.part(
              errors,
              'temperatures',
              'disk.temperatures',
              // 25.04 asks smartctl, told to leave a disk asleep alone.
              legacy ? [devices, { powermode: 'STANDBY' }] : [[], false],
            );
      if (legacy) {
        raw.smart = await this.part(errors, 'smart', 'smart.test.results', [[], {}]);
      }
    }
    if (update) {
      raw.update = legacy
        ? await this.part(errors, 'update', 'update.check_available')
        : await this.part(errors, 'update', 'update.status');
      if (raw.update === null) {
        delete raw.update;
      }
    }
    return raw;
  }

  // --- Commands ------------------------------------------------------------------------

  /** A refused command, in the words of ERROR_KINDS. */
  static commandError(err) {
    if (isAccessDenied(err)) {
      return new TruenasError(ERROR_KINDS.PERMISSION, err.message, { cause: err });
    }
    if (err instanceof RpcError) {
      return new TruenasError(ERROR_KINDS.PROTOCOL, err.message, { cause: err });
    }
    return err;
  }

  /**
   * Wait for a job the NAS started (start, stop): its id comes back at once
   * (the `legacy_jobs` default of the connection). A job that fails throws.
   */
  async waitJob(method, id) {
    if (!Number.isInteger(id)) {
      return;
    }
    const deadline = this.now() + this.jobTimeoutMs;
    while (this.now() < deadline) {
      const [job] = (await this.call('core.get_jobs', [[['id', '=', id]]])) ?? [];
      if (!job) {
        // Not visible to this user: nothing more to wait for.
        return;
      }
      if (job.state === 'SUCCESS') {
        return;
      }
      if (job.state === 'FAILED' || job.state === 'ABORTED') {
        throw new TruenasError(
          ERROR_KINDS.PROTOCOL,
          `${method}: ${String(job.error ?? job.state).slice(0, 300)}`,
        );
      }
      await sleep(this.jobPollMs);
    }
    throw new TruenasError(
      ERROR_KINDS.PROTOCOL,
      `${method}: still running after ${this.jobTimeoutMs} ms`,
    );
  }

  /**
   * Start or stop an app or a virtual machine, and wait until it is done.
   * Stopping is always the graceful stop (never a forced power off).
   * @param {'app'|'vm'|'instance'|'container'} kind
   * @param {string|number} ref the app name, or the id of the machine
   * @param {'start'|'stop'} action
   */
  async run(kind, ref, action) {
    const start = action === RUN_ACTIONS.START;
    const calls = {
      app: () => [start ? 'app.start' : 'app.stop', [ref]],
      [VM_KINDS.VM]: () =>
        start
          ? ['vm.start', [ref, { overcommit: false }]]
          : ['vm.stop', [ref, { force: false, force_after_timeout: false }]],
      [VM_KINDS.INSTANCE]: () =>
        start
          ? ['virt.instance.start', [ref]]
          : ['virt.instance.stop', [ref, { timeout: 60, force: false }]],
      [VM_KINDS.CONTAINER]: () =>
        start
          ? ['container.start', [ref]]
          : ['container.stop', [ref, { force: false, force_after_timeout: false }]],
    };
    const [method, params] = calls[kind]();
    try {
      await this.waitJob(method, await this.call(method, params));
    } catch (err) {
      throw TruenasClient.commandError(err);
    }
  }

  /** Restart or shut down the NAS (FULL_ADMIN). Not waited for: the NAS goes away. */
  async power(action) {
    const method = action === POWER_ACTIONS.SHUTDOWN ? 'system.shutdown' : 'system.reboot';
    try {
      await this.call(method, ['Requested by a Gladys scene', {}]);
    } catch (err) {
      throw TruenasClient.commandError(err);
    }
  }
}
