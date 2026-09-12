#!/usr/bin/env node
/**
 * Headless check of the app's main-process data path.
 *
 * Runs the real bridge client and state projection against the running bridge,
 * with no Electron and no window: discovery, handshake, the baseline, a session
 * subscription, live activity, and the derived avatar face.
 *
 * Usage:
 *   node tools/headless-check.mjs [--profile web] [--seconds 8]
 *
 * Exit codes: 0 success, 1 failure, 2 no endpoint (dsh not running / bridge not installed).
 */
import { createBridgeClient } from '../main/connection.js';
import { createStateStore } from '../main/state.js';

/** Parse the two flags this check owns. */
function parseArgs(argv) {
  const args = { profile: 'web', seconds: 8 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') args.profile = argv[++index];
    else if (argv[index] === '--seconds') args.seconds = Number(argv[++index]);
    else if (argv[index] === '--dsh-home') args.dshHome = argv[++index];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const store = createStateStore({ onChange: () => {} });
let connected = false;
let sawBaseline = false;
const facesSeen = new Set();

const client = createBridgeClient({
  dshHome: args.dshHome ?? null,
  profile: args.profile,
  onEvent: (frame) => {
    if (frame.event === 'baseline') {
      sawBaseline = true;
      const data = frame.data ?? {};
      console.log(`check: baseline sessions=${String((data.sessions ?? []).length)} approvals=${String((data.approvals ?? []).length)}`);
      for (const row of (data.sessions ?? []).slice(0, 6)) {
        console.log(`  session ${row.id} running=${String(row.running)} title=${row.displayTitle}`);
      }
      // Subscribe to the first running session so live activity arrives.
      const target = (data.sessions ?? []).find((row) => row.running === true) ?? (data.sessions ?? [])[0];
      if (target !== undefined) {
        client.call(client.methods.SESSION_SUBSCRIBE, { sessionId: target.id })
          .then(() => {
            console.log(`check: subscribed to ${target.id}`);
          })
          .catch((error) => {
            console.error(`check: subscribe failed: ${error.message}`);
          });
      }
      const children = (data.sessions ?? []).filter((row) => row.parentId !== undefined && row.parentId !== null);
      console.log(`check: subagent children in the list: ${String(children.length)}`);
      const withModel = (data.sessions ?? []).filter((row) => typeof row.model === 'string');
      console.log(`check: sessions reporting a model: ${String(withModel.length)}${withModel.length > 0 ? ` (e.g. ${withModel[0].model})` : ''}`);
      // A bridge older than the app answers method-not-found; the app treats that
      // as "model selection unavailable" rather than an error.
      client.call(client.methods.SESSIONS_MODELS)
        .then((catalog) => {
          const models = (catalog?.groups ?? []).flatMap((group) => group.models ?? []);
          console.log(`check: model catalog supported — ${String(models.length)} model(s) in ${String((catalog?.groups ?? []).length)} provider group(s)`);
        })
        .catch((error) => {
          console.log(`check: model catalog unsupported (${error.code ?? 'error'}) — restart dsh to activate the installed bridge`);
        });
    }
    store.applyEvent(frame);
  },
  onStatus: (status) => {
    store.applyStatus(status);
    if (status.phase === 'connected') {
      connected = true;
      const peer = status.peer ?? {};
      console.log(`check: connected host=${peer.host ?? '?'} profile=${peer.profile ?? '?'} bridge=${peer.bridgeVersion ?? '?'} dsh=${peer.dshVersion ?? '?'} pipe=${status.endpoint?.path ?? '?'}`);
    } else if (status.phase === 'searching' || status.phase === 'error') {
      console.log(`check: ${status.phase}${status.detail === undefined ? '' : ` — ${status.detail}`}`);
    }
  },
  log: (message) => {
    console.error(`check: ${message}`);
  },
});

client.start();

const deadline = Date.now() + args.seconds * 1000;
const ticker = setInterval(() => {
  const snapshot = store.snapshot();
  facesSeen.add(snapshot.face);
  const probe = snapshot.sessions.find((session) => session.running) ?? snapshot.sessions[0];
  console.log(
    `check: t+${String(Math.round((Date.now() - (deadline - args.seconds * 1000)) / 1000))}s face=${snapshot.face} sessions=${String(snapshot.counts.sessions)} running=${String(snapshot.counts.running)} liveJobs=${String(snapshot.counts.liveJobs)} activeTools=${String(snapshot.counts.activeTools)} approvals=${String(snapshot.counts.approvals)}${probe === undefined ? '' : ` tools=[${probe.activeTools.join(',')}]`}`,
  );
  if (Date.now() > deadline) {
    clearInterval(ticker);
    const snapshot = store.snapshot();
    client.stop();
    const ok = connected && sawBaseline;
    console.log(`check: faces seen [${[...facesSeen].join(', ')}]`);
    console.log(ok ? 'check: OK' : 'check: FAILED (no baseline)');
    process.exit(ok ? 0 : 1);
  }
}, 1000);

setTimeout(() => {
  if (!connected) {
    clearInterval(ticker);
    client.stop();
    console.error('check: FAILED — no endpoint/handshake; is dsh running with the bridge installed?');
    process.exit(2);
  }
}, 8000).unref?.();
