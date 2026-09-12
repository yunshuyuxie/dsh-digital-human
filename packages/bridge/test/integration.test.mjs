/**
 * Integration: a fake host context + the real plugin body + a real named pipe +
 * a real protocol client.
 *
 * This is the offline acceptance harness — it drives discovery, the handshake
 * (including the server's token proof), the session list, live jobs, per-session
 * activity, commands, and the full permission-decision path without the desktop
 * app and without a real harness process.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { randomNonce, verifyProof } from '../src/handshake.js';
import { apply } from '../src/index.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  hello as helloMessage,
  rpc as rpcMessage,
} from '../src/vendor/protocol/index.js';

/**
 * Whether this process may open a local IPC endpoint at all.
 *
 * Restricted harnesses deny named pipes (`connect EPERM`), which would turn
 * every transport assertion below into a false failure; the suite reports that
 * environment honestly instead.
 *
 * @returns true when a socket can be served and connected on this host.
 */
async function canUseLocalIpc() {
  const name = `dh-probe-${randomUUID().slice(0, 8)}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
  } catch {
    return false;
  }
  const reachable = await new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
  await new Promise((resolve) => {
    server.close(resolve);
  });
  if (process.platform !== 'win32') {
    try {
      rmSync(path);
    } catch {
      /* the probe socket is best-effort cleanup */
    }
  }
  return reachable;
}

const localIpcAvailable = await canUseLocalIpc();
const skipReason = localIpcAvailable ? false : 'this environment blocks local IPC pipes (connect EPERM)';

/** Roots created by the tests, removed afterwards. */
const roots = [];
/** Everything a started bridge needs torn down. */
const running = [];

afterEach(async () => {
  for (const bridge of running.splice(0)) await bridge.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** One background job as the host would report it. */
const JOB = { id: 'j1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1 };

/**
 * Build a fake host context exposing the parts the plugin uses.
 * @param options - overrides for the fake controller.
 * @returns the context plus captured listeners and calls.
 */
function createFakeHost(options = {}) {
  const listeners = [];
  const disposers = [];
  const calls = [];
  const controller = {
    list: async () => ({
      items: options.sessions ?? [
        { sessionId: 's1', updatedAt: 42, running: true, blank: false, cwd: 'C:\\work\\demo' },
        // A subagent child, listed by the host exactly like a root session.
        { sessionId: 's-child', updatedAt: 43, running: false, blank: false, parentSessionId: 's1', origin: 'subagent' },
      ],
    }),
    modelCatalog: async () => ({
      default: { provider: 'qwen', model: 'Qwen3' },
      routableProviders: ['qwen'],
      groups: [{ id: 'qwen', name: 'Qwen', models: [{ id: 'Qwen3', name: 'Qwen3' }] }],
      failures: [{ id: 'broken', name: 'Broken', message: 'no credentials' }],
    }),
    rename: async (request) => {
      calls.push({ method: 'rename', request });
      return { title: request.title, seq: 7 };
    },
    control: async function* control(signal) {
      yield {
        type: 'baseline',
        value: {
          queues: {},
          jobs: { s1: [JOB] },
          projections: {
            s1: { asOfSeq: 1, values: { modelSelection: { lastUsed: { provider: 'qwen', model: 'Qwen3' }, next: null } } },
          },
        },
      };
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    },
    follow: async function* follow(_request, signal) {
      yield { type: 'snapshot', header: { id: 's1' }, cursor: 0, records: [], hasMore: false, projections: {} };
      yield {
        type: 'event',
        event: {
          type: 'tool/call',
          seq: 7,
          time: 1,
          data: { turn: 1, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{"command":"echo hi"}' },
        },
      };
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    },
    prompt: async (request) => {
      calls.push({ method: 'prompt', request });
      return { accepted: true };
    },
    cancel: async (request) => {
      calls.push({ method: 'cancel', request });
      return { accepted: true };
    },
    create: async (request) => {
      calls.push({ method: 'create', request });
      return { sessionId: 's-new' };
    },
    selectModel: async (request) => {
      calls.push({ method: 'selectModel', request });
      return { selected: { provider: request.provider, model: request.model } };
    },
  };
  const scoped = {
    get: (name) => (name === 'sessionController' ? controller : undefined),
    on: (event, listener, listenerOptions) => {
      listeners.push({ event, listener, options: listenerOptions });
      return () => {};
    },
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return () => {};
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'loader') return { config: { baseUrl: 'file:///C:/tmp/profiles/testprofile/' } };
      return undefined;
    },
    inject: (_deps, callback) => {
      callback(scoped);
    },
  };
  return { ctx, listeners, disposers, calls, controller };
}

/** Wait until a condition holds, or fail after a timeout. */
async function waitFor(check, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/**
 * Start the bridge against a fake host.
 * @param options - `{ config, host }` overrides.
 * @returns a handle with the pipes, listeners and a stop function.
 */
async function startBridge(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dh-bridge-'));
  roots.push(root);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const host = createFakeHost(options);
  const pipeName = `dsh-digital-human-test-${randomUUID().slice(0, 8)}`;
  const config = {
    profile: 'testprofile',
    pipeName,
    approvalRouting: 'primary',
    ...(options.config ?? {}),
  };
  apply(host.ctx, config);
  const endpointPath = join(root, 'digital-human', 'endpoints', 'testprofile.json');
  await waitFor(() => existsSync(endpointPath), 4000, 'the endpoint file');
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  const bridge = {
    root,
    host,
    config,
    endpointPath,
    secretsPath: join(root, 'digital-human', 'secrets.json'),
    /** Tear the plugin down through its own disposer. */
    async stop() {
      for (const dispose of host.disposers.splice(0)) await dispose();
    },
  };
  running.push(bridge);
  return bridge;
}

/**
 * Connect a protocol client to a bridge.
 * @param bridge - a started bridge.
 * @param options - `{ token }` override for the unauthorized case.
 * @returns the client handle.
 */
async function connectClient(bridge, options = {}) {
  const token = options.token ?? (await bridge.token());
  const endpoint = JSON.parse(await readFile(bridge.endpointPath, 'utf8'));
  const frames = [];
  const pending = new Map();
  let finished = false;
  const socket = connect(endpoint.path);
  socket.setEncoding('utf8');
  const clientNonce = randomNonce();
  const decoder = createFrameDecoder({
    maxBytes: 1 << 20,
    onFrame: (frame) => {
      frames.push(frame);
      if (frame?.type === 'result' || frame?.type === 'error') {
        const entry = pending.get(frame.id);
        if (entry !== undefined) {
          pending.delete(frame.id);
          if (frame.type === 'result') entry.resolve(frame.value);
          else entry.reject(new Error(`${frame.code}: ${frame.message}`));
        }
      }
    },
    onError: () => {},
  });
  socket.on('data', (chunk) => decoder(chunk));
  socket.on('close', () => {
    finished = true;
  });
  let nextId = 0;
  const client = {
    socket,
    frames,
    clientNonce,
    get closed() {
      return finished;
    },
    get welcome() {
      return frames.find((frame) => frame?.type === 'welcome');
    },
    /** Send one RPC and await its value. */
    call(method, params = {}, timeoutMs = 5000) {
      nextId += 1;
      const id = `t${String(nextId)}`;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      socket.write(encodeFrame(rpcMessage(id, method, params)));
      return promise;
    },
    /** Resolve once a frame matching the predicate exists. */
    waitForFrame(predicate, timeoutMs = 4000, label = 'frame') {
      return waitFor(() => frames.find(predicate), timeoutMs, label);
    },
    close() {
      socket.destroy();
    },
  };
  socket.on('connect', () => {
    socket.write(encodeFrame(helloMessage({
      protocol: PROTOCOL_VERSION,
      clientId: `test-${randomUUID()}`,
      clientName: 'integration-test',
      token,
      clientNonce,
    })));
  });
  if (options.awaitWelcome !== false) {
    const welcome = await client.waitForFrame((frame) => frame?.type === 'welcome', 4000, 'welcome');
    client.welcomeProofValid = verifyProof({
      token,
      clientNonce,
      serverNonce: welcome.serverNonce,
      proof: welcome.proof,
    });
    // `sendReady: false` exists so a test can prove the bridge refuses a client
    // that skips the ready frame.
    if (options.sendReady !== false) socket.write(encodeFrame({ type: 'ready' }));
  }
  return client;
}

/** Read the profile token out of the bridge's token store. */
async function readToken(bridge) {
  const secrets = JSON.parse(await readFile(bridge.secretsPath, 'utf8'));
  return secrets.profiles.testprofile.token;
}

describe('bridge integration', { skip: skipReason }, () => {
  it('completes the handshake, the baseline and the session list', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    assert.equal(client.welcomeProofValid, true, 'the server must prove it knows the token');
    assert.equal(client.welcome.profile, 'testprofile');
    assert.equal(client.welcome.protocol, PROTOCOL_VERSION);
    assert.ok(client.welcome.capabilities.includes('approvals'));

    const baseline = await client.waitForFrame((frame) => frame?.event === 'baseline');
    assert.equal(baseline.data.sessions.length, 2, 'the host lists the root session and its child');
    assert.equal(baseline.data.sessions[0].id, 's1');
    assert.equal(baseline.data.sessions[0].displayTitle, 'demo', 'title falls back to the directory name');
    assert.deepEqual(baseline.data.control.jobs.s1[0].label, 'pnpm test');
    assert.deepEqual(baseline.data.approvals, []);

    const listed = await client.call(METHODS.SESSIONS_LIST);
    assert.equal(listed.sessions.length, 2);
    client.close();
  });

  it('folds subagent children and reports the session model', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    const baseline = await client.waitForFrame((frame) => frame?.event === 'baseline');
    const rows = baseline.data.sessions;
    const root = rows.find((row) => row.id === 's1');
    const child = rows.find((row) => row.id === 's-child');
    assert.equal(child.parentId, 's1', 'a child names its parent');
    assert.equal(child.origin, 'subagent');
    assert.equal(root.parentId, undefined, 'a root session carries no parent');
    // The model comes from the host's `modelSelection` projection.
    await waitFor(() => root.model !== undefined || rows.some((row) => row.model !== undefined), 3000, 'the model projection');
    const listed = await client.call(METHODS.SESSIONS_LIST);
    const listedRoot = listed.sessions.find((row) => row.id === 's1');
    assert.equal(listedRoot.model, 'qwen/Qwen3');
    client.close();
  });

  it('serves the model catalog and renames a session', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    await client.waitForFrame((frame) => frame?.event === 'baseline');

    const catalog = await client.call(METHODS.SESSIONS_MODELS);
    assert.equal(catalog.groups.length, 1);
    assert.equal(catalog.groups[0].models[0].id, 'Qwen3');
    assert.deepEqual(catalog.default, { provider: 'qwen', model: 'Qwen3' });
    assert.equal(catalog.failures[0].message, 'no credentials', 'provider failures stay visible');

    const renamed = await client.call(METHODS.SESSION_RENAME, { sessionId: 's1', title: '新的标题' });
    assert.equal(renamed.title, '新的标题');
    assert.equal(renamed.seq, 7);
    assert.equal(bridge.host.calls.find((entry) => entry.method === 'rename')?.request.sessionId, 's1');
    client.close();
  });

  it('closes a connection whose first post-welcome frame is not ready', async () => {
    // The client contract is: welcome, then `ready`, then requests. A client that
    // issues an RPC first must be cut off rather than served out of order — this
    // is what an app-side ordering bug looked like from the bridge's side.
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge, { awaitWelcome: false, sendReady: false });
    await client.waitForFrame((frame) => frame?.type === 'welcome', 4000, 'welcome');
    client.socket.write(encodeFrame(rpcMessage('early', METHODS.SESSIONS_LIST, {})));
    await waitFor(() => client.closed, 4000, 'the socket to close');
    assert.equal(client.frames.some((frame) => frame?.type === 'result'), false, 'no result is served before ready');
  });

  it('refuses a connection with the wrong token', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge, { token: 'not-the-token', awaitWelcome: false });
    await waitFor(() => client.closed, 4000, 'the socket to close');
    assert.equal(client.welcome, undefined);
    assert.equal(client.frames.filter((frame) => frame?.type === 'welcome').length, 0);
  });

  it('answers one permission request end to end', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    await client.waitForFrame((frame) => frame?.event === 'baseline');
    await client.call(METHODS.SESSION_SUBSCRIBE, { sessionId: 's1' });
    await client.waitForFrame((frame) => frame?.event === 'activity' && frame.data?.kind === 'tool/call');

    const listener = bridge.host.listeners.find((entry) => entry.event === 'approval/request');
    assert.equal(listener.options?.prepend, true, 'primary routing must prepend');
    let delegated = false;
    const outcome = listener.listener.call(
      { name: 'scoped' },
      { agent: { session: { id: 's1' } }, toolName: 'pwsh', callId: 'call-1', reason: 'needs escalation' },
      async () => {
        delegated = true;
        return 'unavailable';
      },
    );

    const card = await client.waitForFrame((frame) => frame?.event === 'approval.request');
    assert.equal(card.data.toolName, 'pwsh');
    assert.equal(card.data.callId, 'call-1');
    assert.equal(card.data.reason, 'needs escalation');
    assert.deepEqual(card.data.args, { command: 'echo hi' }, 'arguments come from the correlated tool call');

    const decided = await client.call(METHODS.APPROVAL_DECIDE, { approvalId: card.data.approvalId, decision: 'allow-once' });
    assert.equal(decided.outcome, 'allowed-once');
    assert.equal(await outcome, 'allowed-once', 'the host waterfall receives the granted outcome');
    assert.equal(delegated, false);

    const settled = await client.waitForFrame((frame) => frame?.event === 'approval.settled');
    assert.equal(settled.data.outcome, 'allowed-once');
    client.close();
  });

  it('delegates a request that carries no call id', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    await client.waitForFrame((frame) => frame?.event === 'baseline');
    const listener = bridge.host.listeners.find((entry) => entry.event === 'approval/request');
    let delegated = false;
    const outcome = await listener.listener.call(
      { name: 'scoped' },
      { agent: { session: { id: 's1' } }, toolName: 'pwsh' },
      async () => {
        delegated = true;
        return 'unavailable';
      },
    );
    assert.equal(delegated, true);
    assert.equal(outcome, 'unavailable');
    assert.equal(client.frames.filter((frame) => frame?.event === 'approval.request').length, 0);
    client.close();
  });

  it('delegates when no app is connected', async () => {
    const bridge = await startBridge();
    const listener = bridge.host.listeners.find((entry) => entry.event === 'approval/request');
    let delegated = false;
    const outcome = await listener.listener.call(
      { name: 'scoped' },
      { agent: { session: { id: 's1' } }, toolName: 'pwsh', callId: 'call-1' },
      async () => {
        delegated = true;
        return 'unavailable';
      },
    );
    assert.equal(delegated, true);
    assert.equal(outcome, 'unavailable');
  });

  it('times out a held request back to the host chain', async () => {
    const bridge = await startBridge({ config: { approvalTimeoutMs: 1000 } });
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    await client.waitForFrame((frame) => frame?.event === 'baseline');
    const listener = bridge.host.listeners.find((entry) => entry.event === 'approval/request');
    let delegated = false;
    const outcome = await listener.listener.call(
      { name: 'scoped' },
      { agent: { session: { id: 's1' } }, toolName: 'pwsh', callId: 'call-1' },
      async () => {
        delegated = true;
        return 'unavailable';
      },
    );
    assert.equal(delegated, true, 'a timeout must delegate, never decide');
    assert.equal(outcome, 'unavailable');
    const settled = await client.waitForFrame((frame) => frame?.event === 'approval.settled');
    assert.equal(settled.data.outcome, 'unavailable');
    client.close();
  });

  it('runs commands through the host controller', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    await client.waitForFrame((frame) => frame?.event === 'baseline');

    const prompted = await client.call(METHODS.COMMAND_PROMPT, {
      sessionId: 's1',
      requestId: randomUUID(),
      content: [{ type: 'text', text: 'run the tests' }],
    });
    assert.equal(prompted.accepted, true);
    const promptCall = bridge.host.calls.find((entry) => entry.method === 'prompt');
    assert.equal(promptCall.request.mode, 'queue');
    assert.deepEqual(promptCall.request.content, [{ type: 'text', text: 'run the tests' }]);

    const cancelled = await client.call(METHODS.COMMAND_CANCEL, { sessionId: 's1' });
    assert.equal(cancelled.cancelled, true);

    const created = await client.call(METHODS.COMMAND_CREATE, { cwd: 'C:\\work\\demo' });
    assert.equal(created.sessionId, 's-new');

    const selected = await client.call(METHODS.COMMAND_SELECT_MODEL, { sessionId: 's1', provider: 'qwen', model: 'Qwen3' });
    assert.deepEqual(selected, { provider: 'qwen', model: 'Qwen3' });

    const rejected = await client.call(METHODS.COMMAND_PROMPT, { sessionId: 's1', content: [] }).catch((error) => error);
    assert.match(rejected.message, /content must be a non-empty array|invalid-params/u);
    client.close();
  });

  it('delegates held approvals and removes the endpoint on disposal', async () => {
    const bridge = await startBridge();
    bridge.token = () => readToken(bridge);
    const client = await connectClient(bridge);
    await client.waitForFrame((frame) => frame?.event === 'baseline');
    const listener = bridge.host.listeners.find((entry) => entry.event === 'approval/request');
    let delegated = false;
    const outcome = listener.listener.call(
      { name: 'scoped' },
      { agent: { session: { id: 's1' } }, toolName: 'pwsh', callId: 'call-1' },
      async () => {
        delegated = true;
        return 'unavailable';
      },
    );
    await client.waitForFrame((frame) => frame?.event === 'approval.request');
    await bridge.stop();
    assert.equal(await outcome, 'unavailable', 'disposal must hand the request back');
    assert.equal(delegated, true);
    assert.equal(existsSync(bridge.endpointPath), false, 'the endpoint file is removed with the plugin');
    client.close();
  });
});
