/**
 * Local IPC server: NDJSON-framed JSON messages over a Windows named pipe or a
 * POSIX unix socket.
 *
 * The server owns the mechanical half of the protocol — framing, the
 * token-proving handshake, per-client backpressure, and the RPC reply shape —
 * and delegates everything semantic to its caller through `onRpc` and
 * `onAuthenticated`.
 *
 * No TCP port is ever opened: the endpoint is a named pipe (or a POSIX socket
 * file) plus the token store, never a socket that the network can reach.
 */
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  error as errorFrame,
  result as resultFrame,
  validateHello,
  validateRpc,
  welcome,
} from './vendor/protocol/index.js';
import { constantTimeEqual, randomNonce, serverProof } from './handshake.js';

/** Frame id used for failures that happen before an RPC id exists. */
const HANDSHAKE_FRAME_ID = 'handshake';

/**
 * The `listen()` target for one pipe path.
 *
 * A Windows named pipe is created with a NULL security descriptor, so it
 * inherits the default DACL of the listening process's token — and the default
 * DACL of an elevated (administrator) token grants Administrators and SYSTEM
 * only. A harness started with administrator rights would then publish a pipe
 * that the desktop app, double-clicked by the same user without elevation,
 * cannot connect to at all (`connect EPERM`), while the endpoint file and the
 * token stay readable and every offline check still passes — a failure that
 * looks like "installed but never connects".
 *
 * `readableAll` / `writableAll` widen the pipe to every local user through
 * `uv_pipe_chmod`. Authentication stays with the token handshake, and another
 * local user cannot pass it: the token store is not readable outside this
 * account.
 *
 * On POSIX the socket file is tightened to 0600 instead, so the options are
 * deliberately not used there.
 *
 * @param path - the configured pipe/socket path.
 * @returns the value to hand to `server.listen()`; exported for the tests.
 */
export function pipeListenTarget(path) {
  if (process.platform !== 'win32') return path;
  return { path, readableAll: true, writableAll: true };
}

/**
 * Create the IPC server. Nothing listens until {@link IpcServer.listen} runs.
 *
 * @param options - server wiring.
 * @param options.config - parsed bridge config.
 * @param options.getToken - resolves the current token; the token may rotate.
 * @param options.identify - resolves the `welcome` identity payload.
 * @param options.onAuthenticated - called once per client after `ready`; the
 *   caller sends that client's baseline here.
 * @param options.onRpc - resolves one RPC method, or throws an Error with an
 *   optional `code` property.
 * @param options.onClientGone - called when an authenticated client disappears.
 * @param options.log - `(level, message)` sink.
 * @returns the server handle.
 */
export function createIpcServer(options) {
  const { config, getToken, identify, onAuthenticated, onRpc, onClientGone, log } = options;
  const clients = new Map();
  let server;
  let closed = false;
  let nextClientId = 0;

  /** Encode and write one message, dropping a client that cannot keep up. */
  function send(client, message) {
    if (client.socket.destroyed || client.socket.writableEnded) return false;
    let line;
    try {
      line = encodeFrame(message, config.maxFrameBytes);
    } catch (error) {
      log('warn', `dropping a frame that exceeds maxFrameBytes: ${error.message}`);
      return false;
    }
    if (client.socket.writableLength > config.writeBufferLimitBytes) {
      log('warn', `disconnecting client ${client.id}: write buffer exceeded ${String(config.writeBufferLimitBytes)} bytes`);
      client.socket.destroy();
      return false;
    }
    return client.socket.write(line);
  }

  /** Write one message to every authenticated client. */
  function broadcast(message, exceptClientId) {
    let delivered = 0;
    for (const client of clients.values()) {
      if (!client.authenticated) continue;
      if (exceptClientId !== undefined && client.id === exceptClientId) continue;
      if (send(client, message)) delivered += 1;
    }
    return delivered;
  }

  /** Count clients that completed the handshake and asked to be served. */
  function readyClientCount() {
    let count = 0;
    for (const client of clients.values()) if (client.ready) count += 1;
    return count;
  }

  /** Answer a frame that cannot be served, then close that connection. */
  function fail(client, code, message) {
    send(client, errorFrame(HANDSHAKE_FRAME_ID, code, message));
    client.socket.destroy();
  }

  /** Serve the handshake frames until the client is ready. */
  async function handleHandshake(client, frame) {
    const invalid = validateHello(frame);
    if (invalid !== undefined) {
      fail(client, 'protocol-invalid-frame', invalid);
      return;
    }
    const token = await getToken();
    if (!constantTimeEqual(String(frame.token ?? ''), String(token ?? ''))) {
      // Deliberately detail-free: an unauthenticated peer learns only "no".
      log('warn', `rejected a connection with a bad token (${client.remote})`);
      fail(client, 'protocol-unauthorized', 'unauthorized');
      return;
    }
    const serverNonce = randomNonce();
    client.authenticated = true;
    client.clientName = frame.clientName ?? '';
    client.clientId = frame.clientId ?? '';
    const info = await identify();
    send(client, welcome({
      protocol: PROTOCOL_VERSION,
      host: info.host,
      profile: info.profile,
      pid: info.pid,
      bridgeVersion: info.bridgeVersion,
      dshVersion: info.dshVersion,
      capabilities: info.capabilities,
      serverNonce,
      proof: serverProof({ token: String(token), clientNonce: frame.clientNonce, serverNonce }),
    }));
    log('info', `client ${client.id} (${client.clientName || 'unnamed'}) authenticated`);
  }

  /** Dispatch one post-handshake frame. */
  async function handleFrame(client, frame) {
    if (!client.authenticated) {
      await handleHandshake(client, frame);
      return;
    }
    if (!client.ready) {
      if (frame?.type !== 'ready') {
        fail(client, 'protocol-unexpected-frame', 'expected a ready frame after welcome');
        return;
      }
      client.ready = true;
      if (client.handshakeTimer !== undefined) clearTimeout(client.handshakeTimer);
      try {
        await onAuthenticated(client);
      } catch (error) {
        log('warn', `could not send the baseline to client ${client.id}: ${error.message}`);
        client.socket.destroy();
      }
      return;
    }
    if (frame?.type === 'rpc') {
      const invalid = validateRpc(frame);
      if (invalid !== undefined) {
        send(client, errorFrame(frame.id ?? HANDSHAKE_FRAME_ID, 'protocol-invalid-frame', invalid));
        return;
      }
      try {
        const value = await onRpc(client, frame.method, frame.params ?? {});
        send(client, resultFrame(frame.id, value === undefined ? null : value));
      } catch (error) {
        send(client, errorFrame(frame.id, error?.code ?? 'bridge-error', error?.message ?? String(error)));
      }
      return;
    }
    if (frame?.type === 'ping') {
      send(client, resultFrame(frame.id ?? HANDSHAKE_FRAME_ID, { pong: true, serverTime: Date.now() }));
      return;
    }
    fail(client, 'protocol-unexpected-frame', `unexpected frame type ${JSON.stringify(frame?.type ?? null)}`);
  }

  /** Wire one accepted socket into a managed client record. */
  function attach(socket) {
    nextClientId += 1;
    const id = `c${String(nextClientId)}`;
    const client = {
      id,
      socket,
      remote: socket.remoteAddress ?? 'local',
      clientId: '',
      clientName: '',
      authenticated: false,
      ready: false,
      handshakeTimer: undefined,
    };
    clients.set(id, client);
    client.handshakeTimer = setTimeout(() => {
      if (client.authenticated) return;
      log('warn', `closing client ${id}: no handshake within ${String(HANDSHAKE_TIMEOUT_MS)}ms`);
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    client.handshakeTimer.unref?.();

    const decoder = createFrameDecoder({
      maxBytes: config.maxFrameBytes,
      onFrame: (frame) => {
        void handleFrame(client, frame);
      },
      onError: (error) => {
        log('warn', `closing client ${id}: ${error.message}`);
        socket.destroy();
      },
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      decoder(chunk);
    });
    socket.on('error', (error) => {
      log('debug', `client ${id} socket error: ${error.message}`);
    });
    socket.on('close', () => {
      if (client.handshakeTimer !== undefined) clearTimeout(client.handshakeTimer);
      clients.delete(id);
      if (client.ready) onClientGone?.(client);
    });
  }

  /** Start listening on the configured endpoint. */
  async function listen() {
    if (closed) throw new Error('ipc: server is closed');
    const path = config.pipePath;
    if (process.platform !== 'win32') {
      // A crashed process can leave the socket file behind; it is ours to replace.
      try {
        if (existsSync(path)) rmSync(path);
      } catch (error) {
        log('debug', `could not remove a stale socket file: ${error.message}`);
      }
    }
    server = createServer(attach);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        reject(error);
      };
      server.once('error', onError);
      server.listen(pipeListenTarget(path), () => {
        server.off('error', onError);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        log('debug', `could not tighten socket permissions: ${error.message}`);
      }
    }
    return path;
  }

  /** Stop listening, drop every client, and remove a POSIX socket file. */
  async function close() {
    if (closed) return;
    closed = true;
    for (const client of clients.values()) {
      if (client.handshakeTimer !== undefined) clearTimeout(client.handshakeTimer);
      client.socket.destroy();
    }
    clients.clear();
    if (server !== undefined) {
      const closing = new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server = undefined;
      await closing;
    }
    if (process.platform !== 'win32') {
      try {
        if (existsSync(config.pipePath)) rmSync(config.pipePath);
      } catch {
        /* removing a socket file is best-effort */
      }
    }
  }

  return { listen, close, send, broadcast, readyClientCount, clients, get clientCount() { return clients.size; } };
}
