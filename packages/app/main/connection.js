/**
 * Long-lived client for the local bridge.
 *
 * Owns discovery, the token-proving handshake, NDJSON framing, RPC correlation
 * and reconnection. It never opens a socket to another machine: the endpoint is
 * a named pipe published by the bridge inside this harness home.
 */
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  METHODS,
  PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  hello as helloMessage,
  rpc as rpcMessage,
} from '../src/vendor/protocol/index.js';
import { discoverEndpoints, readToken, resolveDshHome } from './endpoint.js';
import { verifyProof } from './handshake.js';

/** Reconnect delays in milliseconds; the last value repeats, with jitter. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

/** How long a handshake may take before the attempt is abandoned. */
const HANDSHAKE_TIMEOUT_MS = 6000;

/** Default RPC timeout. */
const CALL_TIMEOUT_MS = 15000;

/**
 * Describe why the client is not connected.
 *
 * The message travels as a code plus parameters so the renderer can translate
 * it; `text` stays as the untranslated fallback and as what the log shows.
 */
function detailOf(code, params, text) {
  return { code, params: params ?? {}, text };
}

/**
 * Create the bridge client.
 *
 * @param options - client wiring.
 * @param options.dshHome - harness home override from app config, or null.
 * @param options.profile - preferred profile, or null to take the newest endpoint.
 * @param options.onEvent - receives every server event frame `{ event, data }`.
 * @param options.onStatus - receives status transitions `{ phase, detail, endpoint, peer }`.
 * @param options.log - `(message) => void` diagnostics sink.
 * @returns the client handle.
 */
export function createBridgeClient(options) {
  const { onEvent, onStatus, log } = options;
  const dshHome = resolveDshHome(options.dshHome);
  let socket;
  let decoder;
  let attempt = 0;
  let stopped = false;
  let retryTimer;
  let handshakeTimer;
  let current;
  let peer;
  let nextId = 0;
  const pending = new Map();
  let phase = 'searching';

  /** Publish a status transition once. */
  function setStatus(next, detail) {
    if (phase === next && detail === undefined) return;
    phase = next;
    onStatus?.({ phase, detail, endpoint: current ?? null, peer: peer ?? null });
  }

  /** Reject every in-flight call; they belong to a dead connection. */
  function failPending(reason) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  /** Schedule the next attempt with backoff. */
  function scheduleRetry() {
    if (stopped) return;
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    const jitter = base * (0.5 + Math.random() * 0.5);
    attempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      void tryConnect();
    }, jitter);
  }

  /** Discover the endpoint this client should talk to. */
  async function pickEndpoint() {
    const endpoints = await discoverEndpoints(dshHome);
    if (endpoints.length === 0) {
      return {
        endpoint: null,
        detail: detailOf('no-endpoint', {}, 'no endpoint file — is dsh running with the bridge installed?'),
      };
    }
    const preferred = options.profile === null || options.profile === undefined
      ? endpoints[0]
      : endpoints.find((entry) => entry.profile === options.profile) ?? endpoints[0];
    const token = await readToken(dshHome, preferred.profile);
    if (token === null) {
      return {
        endpoint: null,
        detail: detailOf('no-token', { profile: preferred.profile }, `no token recorded for profile '${preferred.profile}'`),
      };
    }
    return { endpoint: preferred, token };
  }

  /** Open one connection attempt. */
  async function tryConnect() {
    if (stopped) return;
    const picked = await pickEndpoint();
    if (picked.endpoint === null) {
      current = undefined;
      peer = undefined;
      setStatus('searching', picked.detail);
      scheduleRetry();
      return;
    }
    const { endpoint, token } = picked;
    current = endpoint;
    setStatus('connecting', detailOf('connecting', { path: endpoint.path }, `connecting to ${endpoint.path}`));

    const clientNonce = randomUUID();
    const sock = connect(endpoint.path);
    socket = sock;
    sock.setEncoding('utf8');
    let ready = false;

    decoder = createFrameDecoder({
      maxBytes: 8 * 1024 * 1024,
      onFrame: (frame) => {
        void handleFrame(frame);
      },
      onError: (error) => {
        log(`framing error: ${error.message}`);
        sock.destroy();
      },
    });

    /** Handle one server frame. */
    async function handleFrame(frame) {
      if (frame?.type === 'welcome') {
        if (frame.protocol !== PROTOCOL_VERSION) {
          setStatus('error', detailOf(
            'protocol-mismatch',
            { bridge: frame.protocol, app: PROTOCOL_VERSION },
            `protocol mismatch: bridge speaks ${String(frame.protocol)}, app speaks ${String(PROTOCOL_VERSION)}`,
          ));
          sock.destroy();
          return;
        }
        let proofValid = false;
        try {
          proofValid = verifyProof({ token, clientNonce, serverNonce: frame.serverNonce, proof: frame.proof });
        } catch (error) {
          log(`could not verify the server proof: ${error.message}`);
        }
        if (proofValid !== true) {
          setStatus('error', detailOf('bad-proof', {}, 'the bridge failed to prove it knows the local token'));
          sock.destroy();
          return;
        }
        peer = {
          host: frame.host,
          profile: frame.profile,
          bridgeVersion: frame.bridgeVersion,
          dshVersion: frame.dshVersion,
          capabilities: Array.isArray(frame.capabilities) ? frame.capabilities : [],
        };
        ready = true;
        attempt = 0;
        clearTimeout(handshakeTimer);
        // `ready` must reach the bridge BEFORE anything announces the connected
        // state: status listeners issue RPCs, and an RPC that overtakes `ready`
        // is refused ("expected a ready frame after welcome") and closes the pipe.
        sock.write(encodeFrame({ type: 'ready' }));
        setStatus('connected');
        return;
      }
      if (frame?.type === 'result' || frame?.type === 'error') {
        const entry = pending.get(frame.id);
        if (entry === undefined) return;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.type === 'result') entry.resolve(frame.value);
        else entry.reject(Object.assign(new Error(frame.message ?? 'bridge error'), { code: frame.code }));
        return;
      }
      if (frame?.type === 'event') {
        onEvent?.(frame);
        return;
      }
      log(`ignoring unexpected frame type ${JSON.stringify(frame?.type ?? null)}`);
    }

    sock.on('data', (chunk) => {
      decoder(chunk);
    });
    sock.on('error', (error) => {
      log(`socket error: ${error.message}`);
    });
    sock.on('close', () => {
      clearTimeout(handshakeTimer);
      if (socket !== sock) return;
      socket = undefined;
      failPending('the bridge connection closed');
      if (ready) peer = undefined;
      setStatus('disconnected', detailOf('closed', {}, 'bridge connection closed'));
      scheduleRetry();
    });
    sock.on('connect', () => {
      sock.write(encodeFrame(helloMessage({
        protocol: PROTOCOL_VERSION,
        clientId: `app-${randomUUID()}`,
        clientName: process.env.COMPUTERNAME ?? 'desktop',
        token,
        clientNonce,
      })));
    });
    handshakeTimer = setTimeout(() => {
      if (ready) return;
      log('handshake timed out');
      sock.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
  }

  /** Start discovery and the connection loop. */
  function start() {
    stopped = false;
    attempt = 0;
    setStatus('searching');
    void tryConnect();
  }

  /** Stop for good and drop the connection. */
  function stop() {
    stopped = true;
    clearTimeout(retryTimer);
    clearTimeout(handshakeTimer);
    failPending('the client stopped');
    socket?.destroy();
    socket = undefined;
  }

  /** Force an immediate reconnect attempt. */
  function reconnect() {
    clearTimeout(retryTimer);
    attempt = 0;
    socket?.destroy();
    void tryConnect();
  }

  /**
   * Invoke one RPC method.
   * @param method - protocol method name.
   * @param params - method parameters.
   * @returns the server's value.
   */
  function call(method, params = {}) {
    if (socket === undefined || phase !== 'connected') {
      return Promise.reject(new Error('not connected to the bridge'));
    }
    nextId += 1;
    const id = `r${String(nextId)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, method });
      socket.write(encodeFrame(rpcMessage(id, method, params)));
    });
  }

  return {
    start,
    stop,
    reconnect,
    call,
    get phase() {
      return phase;
    },
    get endpoint() {
      return current ?? null;
    },
    get peer() {
      return peer ?? null;
    },
    get dshHome() {
      return dshHome;
    },
    methods: METHODS,
  };
}
