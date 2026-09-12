/**
 * dsh-digital-human-bridge — host half of the digital human.
 *
 * Mounts a local IPC endpoint (Windows named pipe / POSIX unix socket), serves
 * the client protocol over it, and answers host permission requests on behalf
 * of the connected desktop app.
 *
 * Nothing here opens a network port, writes to stdout, or changes what the
 * model sees. With no app connected every feed stays idle and every permission
 * request delegates straight back to the host chain, so a deployment that
 * installs the bridge but never runs the app behaves exactly as before.
 *
 * @module dsh-digital-human-bridge
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES,
  METHODS,
  PROTOCOL_VERSION,
  baseline as baselineMessage,
  bridgeNotice,
  sessionsChanged,
} from './vendor/protocol/index.js';
import { createApprovalBroker } from './approvals.js';
import { createAuditLog } from './audit.js';
import { createCommands } from './commands.js';
import { parseConfig } from './config.js';
import { createTokenStore, removeEndpoint, writeEndpoint } from './endpoint.js';
import { createIpcServer } from './ipc.js';
import { createProjector } from './projector.js';

/** Cordis plugin name. */
export const name = 'digital-human-bridge';

const require = createRequire(import.meta.url);

/** This package's own version, reported in the handshake and the endpoint file. */
const BRIDGE_VERSION = (() => {
  try {
    return String(require('../package.json').version);
  } catch {
    return '0.0.0';
  }
})();

/** The installed harness version when resolvable; the wire field is never undefined. */
const DSH_VERSION = (() => {
  try {
    const version = require('@deepseek-ai/dsh/package.json').version;
    if (typeof version === 'string' && version !== '') return version;
  } catch {
    /* the plugin cannot resolve the harness package from its own location */
  }
  // Fall back to the running launcher's own entry point, which lives inside the
  // harness package (`<install>/node_modules/@deepseek-ai/dsh/lib/bin.js`).
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry !== '') {
    const parts = entry.split(/[\\/]/u).filter((part) => part !== '');
    const index = parts.lastIndexOf('dsh');
    if (index > 0 && parts[index - 1] === '@deepseek-ai') {
      try {
        const manifest = join(parts.slice(0, index + 1).join('/'), 'package.json');
        const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
        if (typeof version === 'string' && version !== '') return version;
      } catch {
        /* not launched through the expected layout */
      }
    }
  }
  return 'unknown';
})();

/**
 * Resolve the harness home the same way the launcher does.
 * @returns the absolute harness home directory.
 */
function resolveHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

/**
 * Best-effort profile name discovery.
 *
 * The loader's `baseUrl` anchors at the profile directory, so the segment after
 * `profiles` names the profile. A deployment that needs a stable name
 * regardless of discovery sets `profile` in the row config.
 *
 * @param ctx - the plugin context.
 * @returns the profile name, or `default` when it cannot be derived.
 */
export function resolveProfile(ctx) {
  const baseUrl = ctx.get?.('loader')?.config?.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl === '') return 'default';
  let text = baseUrl;
  if (baseUrl.startsWith('file:')) {
    try {
      text = decodeURIComponent(new URL(baseUrl).pathname);
    } catch {
      text = baseUrl;
    }
  }
  const parts = text.split(/[\\/]/u).filter((part) => part !== '');
  const index = parts.lastIndexOf('profiles');
  if (index >= 0 && index + 1 < parts.length) return parts[index + 1];
  return 'default';
}

/**
 * Mount the bridge.
 *
 * @param ctx - the host plugin context.
 * @param rawConfig - row config, validated by {@link parseConfig}.
 */
export function apply(ctx, rawConfig) {
  const home = resolveHome();
  const profile = typeof rawConfig?.profile === 'string' && rawConfig.profile !== ''
    ? rawConfig.profile
    : resolveProfile(ctx);
  const config = parseConfig(rawConfig, { profile, home });
  if (!config.enabled) return;

  /** Diagnostics stay off unless the row asks for them; stdout is never written. */
  const debug = rawConfig?.debug === true;
  const log = (level, message) => {
    if (level === 'debug' && !debug) return;
    if (level === 'info' && !debug) return;
    // console.warn is the one sink no profile reserves for protocol traffic.
    console.warn(`[digital-human-bridge] ${message}`);
  };

  ctx.inject(['sessionController'], (scoped) => {
    const tokenStore = createTokenStore({ stateDir: config.stateDir });
    const audit = createAuditLog({ file: config.auditFile });

    /** Lets the broker and the projector see the server before it exists. */
    const serverHolder = { ipc: undefined };
    const ipcProxy = {
      broadcast: (message, exceptClientId) => serverHolder.ipc?.broadcast(message, exceptClientId) ?? 0,
      readyClientCount: () => serverHolder.ipc?.readyClientCount() ?? 0,
    };

    // Per-client activity subscriptions: a session's stream runs while at least
    // one client wants it, and frames go only to those clients.
    const clientSubscriptions = new Map();
    const subscriptionCounts = new Map();
    const subscriptionSink = (sessionId, message) => {
      const ipc = serverHolder.ipc;
      if (ipc === undefined) return 0;
      let delivered = 0;
      for (const [clientId, sessions] of clientSubscriptions) {
        if (!sessions.has(sessionId)) continue;
        const client = ipc.clients.get(clientId);
        if (client !== undefined && ipc.send(client, message)) delivered += 1;
      }
      return delivered;
    };

    const projector = createProjector({
      ctx: scoped,
      config,
      emit: (message) => {
        ipcProxy.broadcast(message);
      },
      emitActivity: subscriptionSink,
      getApprovals: () => broker.pendingMirrors(),
      log,
    });

    const broker = createApprovalBroker({
      config,
      ipc: ipcProxy,
      audit,
      lookupToolCall: (sessionId, callId) => projector.findToolCall(sessionId, callId),
      log,
    });

    const commands = createCommands({ ctx: scoped });

    /** Start following one session for one client. */
    function subscribe(client, sessionId) {
      let sessions = clientSubscriptions.get(client.id);
      if (sessions === undefined) {
        sessions = new Set();
        clientSubscriptions.set(client.id, sessions);
      }
      if (sessions.has(sessionId)) return;
      sessions.add(sessionId);
      const next = (subscriptionCounts.get(sessionId) ?? 0) + 1;
      subscriptionCounts.set(sessionId, next);
      if (next === 1) projector.subscribeSession(sessionId);
    }

    /** Stop following one session for one client. */
    function unsubscribe(client, sessionId) {
      const sessions = clientSubscriptions.get(client.id);
      if (sessions === undefined || !sessions.delete(sessionId)) return;
      const next = (subscriptionCounts.get(sessionId) ?? 1) - 1;
      if (next <= 0) {
        subscriptionCounts.delete(sessionId);
        projector.unsubscribeSession(sessionId);
        return;
      }
      subscriptionCounts.set(sessionId, next);
    }

    /** Release every subscription a departed client held. */
    function dropClient(client) {
      const sessions = clientSubscriptions.get(client.id);
      if (sessions === undefined) return;
      clientSubscriptions.delete(client.id);
      for (const sessionId of sessions) {
        const next = (subscriptionCounts.get(sessionId) ?? 1) - 1;
        if (next <= 0) {
          subscriptionCounts.delete(sessionId);
          projector.unsubscribeSession(sessionId);
        } else {
          subscriptionCounts.set(sessionId, next);
        }
      }
    }

    const ipc = createIpcServer({
      config,
      getToken: async () => (await tokenStore.ensure(profile)).token,
      identify: async () => ({
        host: hostname(),
        profile,
        pid: process.pid,
        bridgeVersion: BRIDGE_VERSION,
        dshVersion: DSH_VERSION,
        capabilities: [...CAPABILITIES],
      }),
      onAuthenticated: async (client) => {
        ipc.send(client, baselineMessage(await projector.baseline()));
      },
      onRpc: async (client, method, params) => {
        switch (method) {
          case METHODS.SESSIONS_LIST:
            return { sessions: await projector.listSessions() };
          case METHODS.SESSIONS_MODELS:
            return await commands.models();
          case METHODS.SESSION_RENAME:
            return await commands.rename(params);
          case METHODS.SESSION_SUBSCRIBE: {
            const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
            if (sessionId === '') {
              const error = new Error('sessionId is required');
              error.code = 'invalid-params';
              throw error;
            }
            subscribe(client, sessionId);
            return { subscribed: true };
          }
          case METHODS.SESSION_UNSUBSCRIBE: {
            const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
            unsubscribe(client, sessionId);
            return { unsubscribed: true };
          }
          case METHODS.COMMAND_CREATE:
            return await commands.create(params);
          case METHODS.COMMAND_PROMPT:
            return await commands.prompt(params);
          case METHODS.COMMAND_CANCEL:
            return await commands.cancel(params);
          case METHODS.COMMAND_SELECT_MODEL:
            return await commands.selectModel(params);
          case METHODS.APPROVAL_DECIDE: {
            const approvalId = typeof params?.approvalId === 'string' ? params.approvalId : '';
            return { outcome: broker.decide(client, approvalId, params?.decision) };
          }
          case METHODS.PING:
            return { pong: true, serverTime: Date.now() };
          default: {
            const error = new Error(`unknown method ${JSON.stringify(method)}`);
            error.code = 'method-not-found';
            throw error;
          }
        }
      },
      onClientGone: (client) => {
        dropClient(client);
      },
      log,
    });
    serverHolder.ipc = ipc;

    /** Refresh the session list for every connected client. */
    const refreshSessions = async () => {
      try {
        const upsert = await projector.listSessions();
        if (upsert.length > 0) ipc.broadcast(sessionsChanged({ upsert }));
      } catch (error) {
        log('warn', `could not refresh the session list: ${error.message}`);
      }
    };

    scoped.on('session/created', () => {
      void refreshSessions();
    });
    scoped.on('session/disposed', (session) => {
      const sessionId = session?.header?.id ?? session?.id;
      if (typeof sessionId === 'string') {
        ipc.broadcast(sessionsChanged({ removed: [sessionId] }));
        projector.unsubscribeSession(sessionId);
      }
      void refreshSessions();
    });
    scoped.on('session/event', (_session, event) => {
      if (event?.type === 'session/title') void refreshSessions();
    });
    scoped.on('agent/inbox/claimed', () => {
      void refreshSessions();
    });
    scoped.on('agent/error', ({ agent, error }) => {
      projector.noteAgentError(agent, error);
    });

    /** Establish the endpoint and start the host-wide feed. */
    const start = async () => {
      try {
        await ipc.listen();
      } catch (error) {
        // A busy pipe must not fail the profile: another profile may already own
        // the name, and the rest of the harness is unaffected.
        log('warn', `local endpoint unavailable on ${config.pipePath}: ${error.message}`);
        return false;
      }
      // The token is created eagerly: a client can only prove knowledge of a
      // token it can already read, so creating it lazily at first handshake
      // would make the first handshake impossible.
      try {
        await tokenStore.ensure(profile);
      } catch (error) {
        log('warn', `could not prepare the local token: ${error.message}`);
      }
      projector.startControl();
      try {
        await writeEndpoint({
          stateDir: config.stateDir,
          profile,
          info: {
            pipeName: config.pipeName,
            pid: process.pid,
            host: hostname(),
            dshVersion: DSH_VERSION,
            bridgeVersion: BRIDGE_VERSION,
            startedAt: new Date().toISOString(),
            capabilities: [...CAPABILITIES],
          },
        });
      } catch (error) {
        log('warn', `could not publish the endpoint file: ${error.message}`);
      }
      log('info', `listening on ${config.pipePath} (profile ${profile}, protocol ${String(PROTOCOL_VERSION)})`);
      return true;
    };

    const ready = start();

    if (config.approvalRouting !== 'off') {
      scoped.on(
        'approval/request',
        broker.handler,
        config.approvalRouting === 'primary' ? { prepend: true } : undefined,
      );
    }

    scoped.effect(() => () => {
      // Delegating held approvals happens before anything is torn down, so no
      // host tool is ever left waiting on a card that no longer exists.
      broker.dispose();
      projector.stopAll();
      return (async () => {
        await ready;
        await ipc.close();
        await removeEndpoint({ stateDir: config.stateDir, profile });
        await audit.close();
      })();
    }, 'digital-human-bridge: endpoint + feeds');
  });
}

/** Exported for tests that need the discovery helpers. */
export const internals = { BRIDGE_VERSION, DSH_VERSION, resolveHome, resolveProfile };
