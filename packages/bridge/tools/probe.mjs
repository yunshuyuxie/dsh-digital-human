#!/usr/bin/env node
/**
 * Headless probe for the digital-human bridge.
 *
 * Speaks the client protocol directly, so the bridge can be verified end to end
 * without the desktop app: discovery, handshake (including verifying the
 * server's token proof), the session list, activity subscriptions, commands and
 * permission decisions.
 *
 * Usage:
 *   node tools/probe.mjs --check
 *   node tools/probe.mjs --watch 20 --approve allow
 *   node tools/probe.mjs --prompt <sessionId> "run the tests"
 *   node tools/probe.mjs --subscribe <sessionId> --watch 30
 *
 * Exit codes: 0 success, 1 protocol/connection failure, 2 missing precondition
 * (no endpoint file, no token).
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  METHODS,
  PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  hello as helloMessage,
  rpc as rpcMessage,
} from '../src/vendor/protocol/index.js';
import { verifyProof, randomNonce } from '../src/handshake.js';

/** Parse the probe's own flags. */
function parseArgs(argv) {
  const args = { profile: 'web', watch: 0, approve: 'off', json: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--profile') args.profile = argv[++index];
    else if (flag === '--dsh-home') args.dshHome = argv[++index];
    else if (flag === '--watch') args.watch = Number(argv[++index]);
    else if (flag === '--approve') args.approve = argv[++index];
    else if (flag === '--prompt') {
      args.promptSession = argv[++index];
      args.promptText = argv[++index];
    } else if (flag === '--cancel') args.cancelSession = argv[++index];
    else if (flag === '--subscribe') args.subscribe = argv[++index];
    else if (flag === '--check') args.check = true;
    else if (flag === '--json') args.json = true;
    else rest.push(flag);
  }
  if (rest.length > 0) args.extra = rest;
  return args;
}

/** Print one informational line. */
function say(message) {
  process.stdout.write(`${message}\n`);
}

/** Fail with a precondition message. */
function bail(code, message) {
  process.stderr.write(`probe: ${message}\n`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const stateDir = join(dshHome, 'digital-human');

let endpoint;
let endpointProfile = args.profile;
try {
  endpoint = JSON.parse(readFileSync(join(stateDir, 'endpoints', `${args.profile}.json`), 'utf8'));
} catch (error) {
  // A profile whose endpoint file is named differently (or a deployment that
  // serves exactly one) is still reachable: fall back to the sole endpoint.
  try {
    const { readdirSync } = await import('node:fs');
    const names = readdirSync(join(stateDir, 'endpoints')).filter((name) => name.endsWith('.json'));
    if (names.length === 1) {
      endpointProfile = names[0].replace(/\.json$/u, '');
      endpoint = JSON.parse(readFileSync(join(stateDir, 'endpoints', names[0]), 'utf8'));
      say(`probe: profile '${args.profile}' not found; using the only endpoint ('${endpointProfile}')`);
    } else {
      bail(2, `no endpoint file for profile '${args.profile}' (${error.message}) — is dsh running with the bridge installed?`);
    }
  } catch (fallbackError) {
    bail(2, `no endpoint file for profile '${args.profile}' (${fallbackError.message}) — is dsh running with the bridge installed?`);
  }
}

let token;
try {
  const secrets = JSON.parse(readFileSync(join(stateDir, 'secrets.json'), 'utf8'));
  token = secrets?.profiles?.[endpointProfile]?.token ?? secrets?.profiles?.[args.profile]?.token;
} catch (error) {
  bail(2, `could not read the token store (${error.message})`);
}
if (typeof token !== 'string' || token === '') bail(2, `no token recorded for profile '${endpointProfile}'`);

// Minted before connecting: the connect handler must be registered in the same
// synchronous turn as connect(), or a fast pipe could answer first.
const clientNonce = randomNonce();

const socket = connect(endpoint.path);
socket.setEncoding('utf8');

let handshakeDone = false;
let baselineSeen = false;
let nextId = 0;
const outstanding = new Map();
let exitCode = 0;
let finished = false;

/** Send one request and resolve with its value. */
function call(method, params = {}, timeoutMs = 10_000) {
  nextId += 1;
  const id = `p${String(nextId)}`;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      outstanding.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    outstanding.set(id, { resolve, reject, timer, method });
  });
  socket.write(encodeFrame(rpcMessage(id, method, params)));
  return promise;
}

/** Finish once, with a code. */
function finish(code, message) {
  if (finished) return;
  finished = true;
  exitCode = code;
  if (message !== undefined) (code === 0 ? say : (text) => process.stderr.write(`${text}\n`))(message);
  socket.end();
  setTimeout(() => {
    process.exit(exitCode);
  }, 50).unref?.();
}

const decoder = createFrameDecoder({
  maxBytes: 8 * 1024 * 1024,
  onError: (error) => finish(1, `probe: framing error: ${error.message}`),
  onFrame: (frame) => {
    void handleFrame(frame);
  },
});
socket.on('data', (chunk) => decoder(chunk));
socket.on('error', (error) => finish(1, `probe: socket error: ${error.message}`));
socket.on('close', () => finish(exitCode, undefined));

/** Handle one server frame. */
async function handleFrame(frame) {
  if (args.json) say(JSON.stringify(frame));
  if (frame?.type === 'welcome') {
    const expected = endpoint.protocol ?? PROTOCOL_VERSION;
    if (frame.protocol !== expected) {
      finish(1, `probe: protocol mismatch: server ${String(frame.protocol)}, expected ${String(expected)}`);
      return;
    }
    const ok = verifyProof({
      token,
      clientNonce: clientNonce,
      serverNonce: frame.serverNonce,
      proof: frame.proof,
    });
    if (!ok) {
      finish(1, 'probe: the server failed to prove knowledge of the token');
      return;
    }
    handshakeDone = true;
    say(`probe: connected to ${frame.host} profile=${frame.profile} bridge=${frame.bridgeVersion} dsh=${frame.dshVersion}`);
    say(`probe: capabilities ${frame.capabilities.join(', ')}`);
    socket.write(encodeFrame({ type: 'ready' }));
    return;
  }
  if (frame?.type === 'result') {
    const entry = outstanding.get(frame.id);
    if (entry !== undefined) {
      outstanding.delete(frame.id);
      clearTimeout(entry.timer);
      entry.resolve(frame.value);
    }
    return;
  }
  if (frame?.type === 'error') {
    const entry = outstanding.get(frame.id);
    if (entry !== undefined) {
      outstanding.delete(frame.id);
      clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method} failed: ${frame.code}: ${frame.message}`));
      return;
    }
    finish(1, `probe: server error ${frame.code}: ${frame.message}`);
    return;
  }
  if (frame?.type !== 'event') return;

  if (frame.event === 'baseline') {
    baselineSeen = true;
    const data = frame.data ?? {};
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    say(`probe: baseline sessions=${String(sessions.length)} approvals=${String((data.approvals ?? []).length)} jobs=${String(Object.keys(data.control?.jobs ?? {}).length)}`);
    for (const row of sessions.slice(0, 10)) {
      say(`  session ${row.id} running=${String(row.running)} title=${row.displayTitle}`);
    }
    await afterBaseline();
    return;
  }
  if (frame.event === 'approval.request') {
    const card = frame.data ?? {};
    say(`probe: APPROVAL ${card.approvalId} tool=${card.toolName} session=${card.sessionId} reason=${card.reason ?? '-'}`);
    if (card.args !== undefined) say(`probe:   args ${typeof card.args === 'string' ? card.args : JSON.stringify(card.args)}`);
    if (args.approve === 'allow' || args.approve === 'reject') {
      const decision = args.approve === 'allow' ? 'allow-once' : 'reject';
      try {
        const value = await call(METHODS.APPROVAL_DECIDE, { approvalId: card.approvalId, decision });
        say(`probe: decided ${card.approvalId} -> ${String(value?.outcome)}`);
      } catch (error) {
        finish(1, `probe: could not answer ${card.approvalId}: ${error.message}`);
      }
    } else {
      say('probe:   (no --approve mode; leaving the card pending)');
    }
    return;
  }
  if (frame.event === 'activity') {
    const entry = frame.data ?? {};
    say(`probe: activity ${entry.kind} session=${entry.sessionId} tool=${entry.tool ?? '-'} status=${entry.status ?? '-'}`);
    return;
  }
  if (frame.event === 'control.frame') {
    const control = frame.data ?? {};
    if (control.type === 'jobs') {
      say(`probe: jobs session=${control.sessionId} count=${String((control.jobs ?? []).length)}`);
    }
    return;
  }
  if (frame.event === 'sessions.changed') {
    const data = frame.data ?? {};
    say(`probe: sessions.changed upsert=${String((data.upsert ?? []).length)} removed=${String((data.removed ?? []).length)}`);
    return;
  }
  if (frame.event === 'bridge.notice') {
    say(`probe: notice ${frame.data?.level ?? 'info'} ${frame.data?.code ?? ''} ${frame.data?.message ?? ''}`);
  }
}

/** Run whatever this invocation asked for, now that the baseline has arrived. */
async function afterBaseline() {
  try {
    if (args.subscribe !== undefined) {
      await call(METHODS.SESSION_SUBSCRIBE, { sessionId: args.subscribe });
      say(`probe: subscribed to ${args.subscribe}`);
    }
    if (args.promptSession !== undefined) {
      const value = await call(METHODS.COMMAND_PROMPT, {
        sessionId: args.promptSession,
        requestId: randomUUID(),
        content: [{ type: 'text', text: args.promptText ?? '' }],
      });
      say(`probe: prompt accepted=${String(value?.accepted)}`);
    }
    if (args.cancelSession !== undefined) {
      const value = await call(METHODS.COMMAND_CANCEL, { sessionId: args.cancelSession });
      say(`probe: cancel accepted=${String(value?.cancelled)}`);
    }
    if (args.check === true) {
      const value = await call(METHODS.SESSIONS_LIST, {});
      say(`probe: sessions.list returned ${String((value?.sessions ?? []).length)} row(s)`);
      finish(0, 'probe: CHECK OK');
      return;
    }
    if (args.watch > 0) {
      say(`probe: watching for ${String(args.watch)}s`);
      setTimeout(() => {
        finish(0, 'probe: WATCH OK');
      }, args.watch * 1000).unref?.();
      return;
    }
    finish(0, 'probe: OK');
  } catch (error) {
    finish(1, `probe: ${error.message}`);
  }
}

socket.on('connect', () => {
  socket.write(encodeFrame(helloMessage({
    protocol: PROTOCOL_VERSION,
    clientId: `probe-${randomUUID()}`,
    clientName: 'dsh-digital-human-probe',
    token,
    clientNonce,
  })));
});

setTimeout(() => {
  if (!handshakeDone) finish(1, 'probe: no welcome within 8s');
  else if (!baselineSeen) finish(1, 'probe: no baseline within 8s');
}, 8000).unref?.();
