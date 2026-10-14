// -----------------------------------------------------------------------------
// An in-memory TrueNAS answering the JSON-RPC 2.0 API the way the integration
// reads it (src/truenas/client.js), behind the `open` seam of the client: no
// socket is opened. It checks the API key at login, refuses calls before it
// (ENOTAUTHENTICATED), refuses what a Read-only Administrator may not do
// (EACCES), answers -32601 for the methods its version does not have, and
// serves the fixtures of test/fixtures/truenas (edited in place by the tests:
// CPU, pool state, alerts, app state...).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { ConnectionError } from '../../src/truenas/rpc.js';

// Not a secret: the key of the fake NAS only.
export const API_KEY = '7-fakeApiKeyForTestsOnly0123456789abcdefghijklmnopqrstuvwxyz';
export const URL_OF_NAS = 'wss://192.0.2.20/api/current';
export const HOST_ID = '5f2b9c1e8a7d6043';

const read = (version, name) => {
  try {
    return JSON.parse(
      readFileSync(new URL(`../fixtures/truenas/${version}/${name}.json`, import.meta.url), 'utf8'),
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
};

const BASE_FILES = [
  'system.info',
  'system.host_id',
  'reporting.cpu',
  'reporting.memory',
  'reporting.cputemp',
  'alert.list',
  'pool.query',
  'pool.dataset.query',
  'app.query',
  'vm.query',
  'virt.instance.query',
  'disk.query',
  'disk.temperatures',
  'update.status',
];

// The methods each version does not have (answered -32601).
const MISSING = {
  25.04: ['update.status', 'container.query'],
  '25.10': ['update.check_available', 'smart.test.results', 'container.query'],
};

// What a Read-only Administrator may not call.
const WRITE_METHODS = new Set([
  'app.start',
  'app.stop',
  'vm.start',
  'vm.stop',
  'virt.instance.start',
  'virt.instance.stop',
  'container.start',
  'container.stop',
]);
const ADMIN_METHODS = new Set(['system.reboot', 'system.shutdown']);

class RpcFailure extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const callError = (errname, reason, errno = 13) =>
  new RpcFailure(-32001, 'Method call error', { error: errno, errname, reason });

export class FakeTruenas {
  /**
   * @param {object} [options]
   * @param {'25.04'|'25.10'} [options.version]
   * @param {'readonly'|'control'|'admin'} [options.role] the role of the user of the key
   * @param {boolean} [options.selfSigned] its certificate is self-signed (the default of TrueNAS)
   */
  constructor({ version = '25.10', role = 'readonly', selfSigned = true } = {}) {
    this.version = version;
    this.role = role;
    this.selfSigned = selfSigned;
    this.docs = {};
    for (const name of BASE_FILES) {
      this.docs[name] = read('25.10', name);
    }
    if (version === '25.04') {
      for (const name of [
        'system.info',
        'update.check_available',
        'smart.test.results',
        'virt.instance.query',
      ]) {
        this.docs[name] = read('25.04', name);
      }
    }
    /** @type {null|'down'|'notfound'|'silent'} */
    this.failure = null;
    /** Methods answered with EACCES whatever the role. */
    this.denied = new Set();
    /** Every call received: { method, params }. */
    this.requests = [];
    this.logins = 0;
    this.failedLogins = 0;
    this.connections = 0;
    this.sockets = new Set();
    this.commands = [];
    this.jobs = new Map();
    this.nextJob = 100;
    this.open = this.open.bind(this);
  }

  // --- Editing the NAS ---------------------------------------------------------------

  setCpu(value) {
    for (const row of this.docs['reporting.cpu'][0].data) {
      row[1] = value;
    }
  }

  setPool(name, patch) {
    const pool = this.docs['pool.query'].find((p) => p.name === name);
    Object.assign(pool, patch);
  }

  addAlert({
    id,
    level = 'WARNING',
    klass = 'TestAlert',
    formatted = 'Something happened.',
    args = null,
  }) {
    this.docs['alert.list'].unshift({
      uuid: id,
      id,
      source: klass,
      klass,
      args,
      node: 'Controller A',
      key: 'null',
      datetime: { $date: 1792000000000 },
      last_occurrence: { $date: 1792000000000 },
      dismissed: false,
      mail: null,
      text: formatted,
      level,
      formatted,
      one_shot: false,
    });
  }

  setApp(name, patch) {
    Object.assign(
      this.docs['app.query'].find((a) => a.name === name),
      patch,
    );
  }

  /** Close every open connection, as a NAS restarting its middleware does. */
  dropConnections() {
    for (const socket of this.sockets) {
      this.sockets.delete(socket);
      socket.onclose?.(new ConnectionError('Connection closed by the NAS'));
    }
  }

  /** Forget every session: the next call on an open connection is not authenticated. */
  expireSessions() {
    for (const socket of this.sockets) {
      socket.loggedIn = false;
    }
  }

  // --- The network seam ---------------------------------------------------------------

  /** The `open` function of the client: a socket to this NAS. */
  async open(url, { insecure = false } = {}) {
    if (url !== URL_OF_NAS || this.failure === 'down') {
      throw new ConnectionError('connect ECONNREFUSED 192.0.2.20:443', { code: 'ECONNREFUSED' });
    }
    if (this.selfSigned && !insecure) {
      throw new ConnectionError('self-signed certificate', { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    }
    if (this.failure === 'notfound') {
      throw new ConnectionError('HTTP 404 instead of a WebSocket', {
        code: 'EUNEXPECTED',
        status: 404,
      });
    }
    this.connections += 1;
    const socket = {
      onmessage: null,
      onclose: null,
      loggedIn: false,
      send: (text) => {
        const message = JSON.parse(text);
        queueMicrotask(() => this.receive(socket, message));
      },
      close: () => {
        this.sockets.delete(socket);
      },
    };
    this.sockets.add(socket);
    return socket;
  }

  receive(socket, { id, method, params }) {
    if (!this.sockets.has(socket) || this.failure === 'silent') {
      return;
    }
    this.requests.push({ method, params });
    let answer;
    try {
      answer = { jsonrpc: '2.0', id, result: this.handle(socket, method, params) };
    } catch (err) {
      if (!(err instanceof RpcFailure)) {
        throw err;
      }
      answer = {
        jsonrpc: '2.0',
        id,
        error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) },
      };
    }
    socket.onmessage?.(JSON.stringify(answer));
  }

  handle(socket, method, params) {
    if (method === 'auth.login_with_api_key') {
      this.logins += 1;
      socket.loggedIn = params[0] === API_KEY;
      if (!socket.loggedIn) {
        this.failedLogins += 1;
      }
      return socket.loggedIn;
    }
    if (!socket.loggedIn) {
      throw callError('ENOTAUTHENTICATED', 'Not authenticated', 207);
    }
    if ((MISSING[this.version] ?? []).includes(method)) {
      throw new RpcFailure(-32601, 'Method does not exist');
    }
    if (
      this.denied.has(method) ||
      (WRITE_METHODS.has(method) && this.role === 'readonly') ||
      (ADMIN_METHODS.has(method) && this.role !== 'admin')
    ) {
      throw callError('EACCES', 'Not authorized');
    }
    switch (method) {
      case 'reporting.netdata_get_data': {
        const name = params?.[0]?.[0]?.name;
        const graph = this.docs[`reporting.${name}`];
        if (!graph) {
          throw callError('EINVAL', `${name}: unknown graph`, 22);
        }
        return graph;
      }
      case 'pool.dataset.query': {
        const names = params?.[0]?.[0]?.[2] ?? [];
        return this.docs['pool.dataset.query'].filter((d) => names.includes(d.id));
      }
      case 'app.start':
      case 'app.stop':
        this.commands.push(`${method} ${params[0]}`);
        this.setApp(params[0], { state: method === 'app.start' ? 'RUNNING' : 'STOPPED' });
        return this.job();
      case 'vm.start':
      case 'vm.stop': {
        this.commands.push(`${method} ${params[0]}`);
        const vm = this.docs['vm.query'].find((v) => v.id === params[0]);
        vm.status.state = method === 'vm.start' ? 'RUNNING' : 'STOPPED';
        return method === 'vm.start' ? null : this.job();
      }
      case 'virt.instance.start':
      case 'virt.instance.stop': {
        this.commands.push(`${method} ${params[0]}`);
        const instance = this.docs['virt.instance.query'].find((v) => v.id === params[0]);
        instance.status = method === 'virt.instance.start' ? 'RUNNING' : 'STOPPED';
        return this.job();
      }
      case 'system.reboot':
      case 'system.shutdown':
        this.commands.push(method);
        return this.job();
      case 'core.get_jobs': {
        const job = this.jobs.get(params?.[0]?.[0]?.[2]);
        return job ? [job] : [];
      }
      default: {
        const doc = this.docs[method];
        if (doc === undefined) {
          throw new RpcFailure(-32601, 'Method does not exist');
        }
        return structuredClone(doc);
      }
    }
  }

  job(state = 'SUCCESS') {
    const id = this.nextJob;
    this.nextJob += 1;
    this.jobs.set(id, { id, state, error: state === 'FAILED' ? 'failed' : null });
    return id;
  }
}
