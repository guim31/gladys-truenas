// -----------------------------------------------------------------------------
// The JSON-RPC 2.0 connection (src/truenas/rpc.js) on an in-memory socket, and
// the `ws` socket (src/truenas/socket.js) against a WebSocket server on the
// loopback interface: answers matched by id, errors with their errname, a
// timeout that closes the connection, a closed socket that fails what waits,
// an HTTP answer instead of the upgrade.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { ConnectionError, RpcConnection, RpcError } from '../src/truenas/rpc.js';
import { openSocket } from '../src/truenas/socket.js';

/** A socket whose answers the test writes. */
function memorySocket() {
  const sent = [];
  const socket = {
    onmessage: null,
    onclose: null,
    closed: false,
    send: (text) => sent.push(JSON.parse(text)),
    close: () => {
      socket.closed = true;
    },
  };
  return { socket, sent, open: async () => socket };
}

test('answers are matched by id, in any order', async () => {
  const { socket, sent, open } = memorySocket();
  const rpc = new RpcConnection({ url: 'wss://x/api/current', open });
  await rpc.connect();
  const a = rpc.call('system.info');
  const b = rpc.call('pool.query', [[], {}]);
  assert.deepEqual(
    sent.map((m) => [m.jsonrpc, m.method, m.params]),
    [
      ['2.0', 'system.info', []],
      ['2.0', 'pool.query', [[], {}]],
    ],
  );
  socket.onmessage(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, result: ['pool'] }));
  socket.onmessage('not json');
  socket.onmessage(JSON.stringify({ jsonrpc: '2.0', method: 'collection_update', params: {} }));
  socket.onmessage(
    JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { version: '25.10.1' } }),
  );
  assert.deepEqual(await b, ['pool']);
  assert.deepEqual(await a, { version: '25.10.1' });
});

test('an error answer carries the method, the code and the errname', async () => {
  const { socket, sent, open } = memorySocket();
  const rpc = new RpcConnection({ url: 'wss://x/api/current', open });
  await rpc.connect();
  const call = rpc.call('app.start', ['jellyfin']);
  socket.onmessage(
    JSON.stringify({
      jsonrpc: '2.0',
      id: sent[0].id,
      error: {
        code: -32001,
        message: 'Method call error',
        data: { errname: 'EACCES', reason: 'Not authorized' },
      },
    }),
  );
  await assert.rejects(call, (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.code, -32001);
    assert.equal(err.errname, 'EACCES');
    assert.equal(err.message, 'app.start: Not authorized');
    return true;
  });
});

test('no answer: the call times out and the connection is closed', async () => {
  const { socket, open } = memorySocket();
  const rpc = new RpcConnection({ url: 'wss://x/api/current', open, timeoutMs: 20 });
  await rpc.connect();
  await assert.rejects(rpc.call('system.info'), (err) => err instanceof ConnectionError);
  assert.equal(socket.closed, true);
  assert.equal(rpc.isOpen, false);
  await assert.rejects(rpc.call('system.info'), /Not connected/);
});

test('the socket closing fails every call waiting', async () => {
  const { socket, open } = memorySocket();
  const rpc = new RpcConnection({ url: 'wss://x/api/current', open });
  await rpc.connect();
  const call = rpc.call('system.info');
  socket.onclose(new ConnectionError('gone', { code: 'ECONNRESET' }));
  await assert.rejects(call, (err) => err.code === 'ECONNRESET');
  assert.equal(rpc.isOpen, false);
});

test('the ws socket talks JSON-RPC to a real WebSocket server (loopback)', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api/current' });
  t.after(() => server.close());
  await new Promise((resolve) => server.on('listening', resolve));
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const { id, method } = JSON.parse(String(data));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: `${method} ok` }));
    });
  });
  const { port } = server.address();
  const rpc = new RpcConnection({ url: `ws://127.0.0.1:${port}/api/current`, open: openSocket });
  await rpc.connect();
  assert.equal(await rpc.call('core.ping'), 'core.ping ok');
  rpc.close();

  // Another path: an HTTP answer instead of the upgrade.
  await assert.rejects(
    openSocket(`ws://127.0.0.1:${port}/websocket`, { timeoutMs: 2000 }),
    (err) => err.code === 'EUNEXPECTED' && err.status === 400,
  );
});

test('nothing listening: the socket fails with the code of the system', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.on('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    openSocket(`ws://127.0.0.1:${port}/api/current`, { timeoutMs: 2000 }),
    (err) => err instanceof ConnectionError && err.code === 'ECONNREFUSED',
  );
});
