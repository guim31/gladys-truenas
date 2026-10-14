// -----------------------------------------------------------------------------
// The one function that opens a WebSocket to the NAS, on the `ws` library (a
// dependency of the SDK already): unlike the WebSocket built into Node, it
// accepts the self-signed certificate TrueNAS serves by default, per
// connection, and only when the user ticked the option.
//
// RpcConnection (src/truenas/rpc.js) takes this function as a parameter: the
// tests replace it with an in-memory TrueNAS.
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { ConnectionError } from './rpc.js';

// The answers of a NAS with many disks, apps and alerts weigh a few hundred kB.
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// A ping keeps the connection (and the session) alive between two reads, and
// tells a NAS gone without closing the socket.
export const PING_INTERVAL_MS = 30_000;

/**
 * @param {string} url `wss://host[:port]/api/current`
 * @param {object} [options]
 * @param {boolean} [options.insecure] accept a certificate that does not verify
 * @param {number} [options.timeoutMs] connection and handshake timeout
 * @returns {Promise<{ send: Function, close: Function, onmessage: Function|null, onclose: Function|null }>}
 */
export function openSocket(url, { insecure = false, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      maxPayload: MAX_PAYLOAD_BYTES,
      rejectUnauthorized: !insecure,
      // The NAS does not need the cookies or the origin of a browser.
      followRedirects: false,
    });
    const socket = {
      onmessage: null,
      onclose: null,
      send: (text) => ws.send(text),
      close: () => ws.terminate(),
    };
    let opened = false;
    let alive = true;
    let pinger = null;
    let lastError = null;

    ws.on('unexpected-response', (_request, response) => {
      // An HTTP answer instead of the upgrade: no JSON-RPC API at this URL.
      lastError = new ConnectionError(`HTTP ${response.statusCode} instead of a WebSocket`, {
        code: 'EUNEXPECTED',
        status: response.statusCode,
      });
      response.resume();
      ws.terminate();
    });
    ws.on('open', () => {
      opened = true;
      pinger = setInterval(() => {
        if (!alive) {
          lastError = new ConnectionError('No answer to the ping', { code: 'ETIMEDOUT' });
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      pinger.unref?.();
      resolve(socket);
    });
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data) => socket.onmessage?.(data.toString('utf8')));
    ws.on('error', (err) => {
      lastError ??= new ConnectionError(err.message, { code: err.code, cause: err });
    });
    ws.on('close', () => {
      clearInterval(pinger);
      const error = lastError ?? new ConnectionError('Connection closed by the NAS');
      if (opened) {
        socket.onclose?.(error);
      } else {
        reject(error);
      }
    });
  });
}
