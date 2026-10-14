// -----------------------------------------------------------------------------
// JSON-RPC 2.0 over one WebSocket: the transport of the TrueNAS API
// (`wss://<host>/api/current`, TrueNAS 25.04 and later). One connection is
// kept open between the reads: a TrueNAS session is opened by a login on the
// connection (src/truenas/client.js) and lives as long as it, and every
// login is a line in the audit log of the NAS.
//
// The socket itself comes from `open` (src/truenas/socket.js on the `ws`
// library, which the SDK already ships): the tests replace it with an
// in-memory TrueNAS (test/helpers/fakeTruenas.js).
// -----------------------------------------------------------------------------

/** A JSON-RPC error answered by the NAS: `code`, and the `errname` of the middleware. */
export class RpcError extends Error {
  constructor(method, error) {
    const data = error && typeof error.data === 'object' && error.data ? error.data : {};
    const reason = typeof data.reason === 'string' && data.reason ? data.reason : error?.message;
    super(`${method}: ${String(reason ?? 'error').slice(0, 300)}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = typeof error?.code === 'number' ? error.code : null;
    this.errname = typeof data.errname === 'string' ? data.errname : null;
  }
}

/** The connection closed, or never opened: `code` is the socket error code when known. */
export class ConnectionError extends Error {
  constructor(message, { code = null, status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConnectionError';
    this.code = code;
    this.status = status;
  }
}

// JSON-RPC 2.0: the method does not exist (an older or newer TrueNAS).
export const METHOD_NOT_FOUND = -32601;

export class RpcConnection {
  /**
   * @param {object} options
   * @param {string} options.url the `wss://` URL of the API
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {Function} options.open (url, { insecure, timeoutMs }) => Promise<socket>, the socket
   *   having `send(text)`, `close()`, and the `onmessage(text)` / `onclose(error)` callbacks
   * @param {number} [options.timeoutMs] per call
   */
  constructor({ url, insecure = false, open, timeoutMs = 20_000 }) {
    this.url = url;
    this.insecure = insecure;
    this.open = open;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    const socket = await this.open(this.url, {
      insecure: this.insecure,
      timeoutMs: this.timeoutMs,
    });
    this.socket = socket;
    socket.onmessage = (text) => this.receive(text);
    socket.onclose = (error) => this.fail(error);
    if (this.closed) {
      // close() was called while the socket was opening.
      socket.close();
      throw new ConnectionError('Connection closed');
    }
  }

  get isOpen() {
    return this.socket !== null && !this.closed;
  }

  /**
   * Call a method of the API.
   * @param {string} method e.g. `system.info`
   * @param {Array} [params]
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<unknown>} the `result`
   */
  call(method, params = [], { timeoutMs = this.timeoutMs } = {}) {
    if (!this.isOpen) {
      return Promise.reject(new ConnectionError('Not connected'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ConnectionError(`${method}: no answer after ${timeoutMs} ms`, { code: 'ETIMEDOUT' }),
        );
        // A NAS that stops answering on an open socket: start again on a new one.
        this.close();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ConnectionError(`${method}: ${err.message}`, { code: err.code, cause: err }));
      }
    });
  }

  receive(text) {
    let message;
    try {
      message = JSON.parse(String(text));
    } catch {
      return;
    }
    // Notifications (no id) are events the integration never subscribes to.
    if (!message || typeof message !== 'object' || message.id === undefined) {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new RpcError(entry.method, message.error));
    } else {
      entry.resolve(message.result);
    }
  }

  fail(error) {
    this.closed = true;
    const reason =
      error instanceof ConnectionError
        ? error
        : new ConnectionError(error?.message ?? 'Connection closed', { code: error?.code });
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fail(new ConnectionError('Connection closed'));
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }
}
