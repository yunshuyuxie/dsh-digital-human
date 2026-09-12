#!/usr/bin/env node
/**
 * Node smoke test for the built browser bundle.
 *
 * There is no browser here, so the test stands in for one: it registers the
 * bundle through a `window.__ModuleLoader__` shim, hands the factory a `react`
 * stub, drives the fake client services, and walks the rendered element tree.
 * It proves the plugin mounts, projects every face, and answers a permission
 * request end to end — not that it looks right.
 *
 * Usage: node tools/smoke.mjs
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const bundle = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8');

const failures = [];
let checks = 0;

/** Record one assertion. */
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(detail === undefined ? label : `${label} (${detail})`);
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`);
}

/* ---------------------------------------------------------------- react stub */

/**
 * Minimal React stand-in: enough to call components outside a renderer. Hook
 * cells are positional, and the walker resets the cursor per component, so a
 * component's Nth hook keeps its state across renders — which is what lets the
 * test force the monitor panel open.
 */
function createReactStub(recorder) {
  recorder.hooks = [];
  recorder.cursor = 0;
  recorder.resetHooks = () => {
    recorder.cursor = 0;
  };
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false);
      return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat } };
    },
    useState(initial) {
      const index = recorder.cursor;
      recorder.cursor += 1;
      if (recorder.hooks[index] === undefined) {
        recorder.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const cell = recorder.hooks[index];
      return [cell.value, (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next;
      }];
    },
    useEffect() {},
    useRef(value) {
      return { current: value };
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      recorder.store = { subscribe, getSnapshot };
      return getSnapshot();
    },
    Fragment: Symbol('Fragment'),
  };
}

/* ------------------------------------------------------------- loader shim */

let bundleRegistration;
const windowShim = {
  __ModuleLoader__: {
    load(registration) {
      bundleRegistration = registration;
    },
  },
};
globalThis.window = windowShim;

const requireStub = (request) => {
  if (request === 'react') return react;
  throw new Error(`smoke: unexpected external require ${JSON.stringify(request)}`);
};

const recorder = {};
const react = createReactStub(recorder);

// eslint-disable-next-line no-new-func -- the bundle is a browser script, not a module
new Function('window', 'require', bundle)(windowShim, requireStub);
const exportsObject = bundleRegistration.factory(requireStub);

check('bundle registers the package name', bundleRegistration.id === manifest.name, bundleRegistration.id);
check('bundle exports apply()', typeof exportsObject.apply === 'function');
check(
  'bundle injects sessions/slots/locale/remote',
  ['sessions', 'slots', 'locale', 'remote'].every((name) => exportsObject.inject.includes(name)),
  JSON.stringify(exportsObject.inject),
);

const dictionaries = require('../src/client/locales.js');
const zhKeys = Object.keys(dictionaries.zh).sort();
const enKeys = Object.keys(dictionaries.en).sort();
check(
  'dictionaries are key-identical',
  zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]),
  `zh=${String(zhKeys.length)} en=${String(enKeys.length)}`,
);
check('every dictionary entry is non-empty', zhKeys.every((key) => dictionaries.zh[key] !== '' && dictionaries.en[key] !== ''));

/* ------------------------------------------------------------- client fake */

/** Build one fake client context around a mutable session mirror. */
function createClient() {
  const state = {
    list: { ids: [], byId: {}, current: undefined, jobsBySession: {} },
    listListeners: new Set(),
    slotRegistrations: [],
    locales: [],
    remotes: [],
    cleanups: [],
  };
  const sessions = {
    list: {
      getSnapshot: () => state.list,
      subscribe(listener) {
        state.listListeners.add(listener);
        return () => state.listListeners.delete(listener);
      },
    },
    scopeOf: () => 'session-1',
  };
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : undefined),
    effect(fn) {
      const cleanup = fn();
      state.cleanups.push(typeof cleanup === 'function' ? cleanup : () => {});
      return () => {};
    },
    locale: {
      register(namespace, dictionaries) {
        state.locales.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      inject(name, contributions) {
        const dispose = contributions();
        state.slotRegistrations.push({ injected: name, dispose });
        return () => {};
      },
      register(options, component) {
        state.slotRegistrations.push({ options, component });
        return () => {};
      },
    },
    remote: {
      $on(event, listener) {
        state.remotes.push({ event, listener });
        return () => {};
      },
    },
  };
  /** Publish one mirror change to the plugin's subscriber. */
  const publish = (list) => {
    state.list = list;
    for (const listener of state.listListeners) listener();
  };
  /** Run every effect cleanup so the tick interval stops. */
  const dispose = () => {
    for (const cleanup of state.cleanups.splice(0)) cleanup();
  };
  return { ctx, state, publish, dispose };
}

const client = createClient();
exportsObject.apply(client.ctx);

check('registers one shell.overlay slot entry', client.state.slotRegistrations.some((entry) => entry.options?.name === 'shell.overlay'), JSON.stringify(client.state.slotRegistrations.map((entry) => entry.options?.name)));
check('registers the digital-human dictionaries', client.state.locales.some((entry) => entry.namespace === 'digital-human'));
check('subscribes to the session mirror', client.state.listListeners.size === 1, String(client.state.listListeners.size));
check('answers the approval waterfall', client.state.remotes.some((entry) => entry.event === 'approval/request'));

const overlay = client.state.slotRegistrations.find((entry) => entry.options?.name === 'shell.overlay')?.component;
check('slot entry is a component', typeof overlay === 'function');

/** Read the published snapshot through the component's own store hook. */
function snapshot() {
  overlay({});
  return recorder.store.getSnapshot();
}

/* ------------------------------------------------------- projection checks */

check('offline face with no sessions', snapshot().face === 'offline', snapshot().face);

const job = (overrides) => ({
  id: 'job-1',
  kind: 'pwsh',
  label: 'pnpm test',
  status: 'running',
  startedAt: Date.now(),
  ...overrides,
});

const summary = (overrides) => ({
  id: 'session-1',
  displayTitle: '数字人联调',
  running: false,
  blank: false,
  updatedAt: Date.now(),
  ...overrides,
});

client.publish({
  ids: ['session-1'],
  byId: { 'session-1': summary({ running: true }) },
  current: 'session-1',
  jobsBySession: {},
});
check('thinking face while the agent runs', snapshot().face === 'thinking', snapshot().face);

client.publish({
  ids: ['session-1'],
  byId: { 'session-1': summary({ running: true }) },
  current: 'session-1',
  jobsBySession: { 'session-1': [job()] },
});
const working = snapshot();
check('working face while a job runs', working.face === 'working', working.face);
check('counts the live job', working.counts.liveJobs === 1, String(working.counts.liveJobs));
check('exposes the job row', working.jobs.length === 1);

client.publish({
  ids: ['session-1', 'session-2'],
  byId: {
    'session-1': summary({ running: false }),
    'session-2': summary({ id: 'session-2', displayTitle: '别的会话', running: true }),
  },
  current: 'session-1',
  jobsBySession: {},
});
check('reports parallel sessions', snapshot().counts.sessions === 1, String(snapshot().counts.sessions));

client.publish({
  ids: ['session-1'],
  byId: { 'session-1': summary({ running: false, lastAgentError: 'boom' }) },
  current: 'session-1',
  jobsBySession: {},
});
const errored = snapshot();
check('error face on an agent failure', errored.face === 'error', errored.face);
check('carries the error text', errored.current?.error === 'boom');

/* ------------------------------------------------------ permission request */

const approvalRequest = { toolName: 'pwsh', callId: 'call-1', reason: 'sandbox escalation' };
let remoteThis;
const remoteListener = client.state.remotes.find((entry) => entry.event === 'approval/request').listener;
const answered = remoteListener.call({ sessionId: 'session-1' }, approvalRequest, () => Promise.resolve('unavailable'));

const waiting = snapshot();
check('waiting face while an approval is held', waiting.face === 'waiting', waiting.face);
check('publishes exactly one approval card', waiting.counts.approvals === 1, String(waiting.counts.approvals));
check('card carries the requesting tool', waiting.approvals[0]?.toolName === 'pwsh');
check('card carries the reason', waiting.approvals[0]?.reason === 'sandbox escalation');

waiting.approvals[0].allow();
const outcome = await answered;
check('allow() answers the host waterfall', outcome === 'allowed-once', String(outcome));
check('card clears after the decision', snapshot().counts.approvals === 0, String(snapshot().counts.approvals));

/* --------------------------------------------------------- render the tree */

/** Walk the element tree, invoking function components, and collect text. */
function render(element, text = []) {
  if (element === undefined || element === null || element === false) return text;
  if (typeof element === 'string' || typeof element === 'number') {
    text.push(String(element));
    return text;
  }
  if (Array.isArray(element)) {
    for (const child of element) render(child, text);
    return text;
  }
  if (typeof element.type === 'function') {
    recorder.resetHooks();
    render(element.type(element.props), text);
    return text;
  }
  render(element.props?.children, text);
  return text;
}

/** Render the overlay with the mirror's current state and return its text. */
function paint() {
  return render(overlay({})).join(' ');
}

const bubble = paint();
check('renders the projected status bubble', bubble.includes('出错了：boom'), bubble.slice(0, 160));

/* Force the monitor panel open through the component's own open-state cell. */
recorder.hooks[0].value = true;
const panel = paint();
check('panel shows its title', panel.includes('数字人 · 任务监控'), panel.slice(0, 160));
check('panel shows the current session section', panel.includes('当前会话'));
check('panel shows the background-job section', panel.includes('后台任务'));
check('panel shows the parallel-session section', panel.includes('并行会话'));
check('panel reports the agent failure', panel.includes('boom'));

/* The approval card is reachable through the same panel. */
const cardRequest = { toolName: 'fs', reason: 'write outside the workspace' };
const cardAnswered = remoteListener.call({ sessionId: 'session-1' }, cardRequest, () => Promise.resolve('unavailable'));
const cardText = paint();
check('panel renders the permission card', cardText.includes('权限确认'), cardText.slice(0, 200));
check('card names the requesting tool', cardText.includes('fs'));
check('card offers allow once', cardText.includes('允许一次'));
check('card offers reject', cardText.includes('拒绝'));
snapshot().approvals[0].reject();
check('reject() answers the host waterfall', (await cardAnswered) === 'rejected');

/* Delegation must fall through to the next waterfall listener. */
const delegated = remoteListener.call({ sessionId: 'session-1' }, cardRequest, () => Promise.resolve('unavailable'));
const delegatedPending = snapshot().approvals[0];
delegatedPending.delegate();
check('delegate() falls through to next()', (await delegated) === 'unavailable');

client.dispose();
delete globalThis.window;

console.log(`\n${String(checks - failures.length)}/${String(checks)} checks passed`);
if (failures.length > 0) {
  console.error('\nfailures:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
}
