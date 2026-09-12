/**
 * Digital-human client plugin body.
 *
 * Three seams, all owned by this one plugin:
 *   1. a session mirror — `ctx.sessions.list` projected into the avatar state;
 *   2. a permission answerer — the forwarded `approval/request` waterfall, held
 *      open until the user answers on the avatar's card;
 *   3. one `shell.overlay` slot entry — the floating widget itself.
 *
 * The node half is empty; nothing here is model-visible.
 */

const { DONE_HOLD_MS, createStore, isLive, projectInto } = require('./store.js');
const { NS, en, format, zh } = require('./locales.js');
const { ensureStyles } = require('./styles.js');
const { DigitalHumanOverlay } = require('./overlay.js');
const { PendingApproval } = require('./approval.js');
const { setRuntime } = require('./runtime.js');

/** Services the plugin body needs before it can mount. */
const inject = ['sessions', 'slots', 'locale', 'remote'];

/** `localStorage` key holding the voice-announcement preference. */
const VOICE_STORAGE_KEY = 'dsh-digital-human:voice';

/** Read the persisted voice preference; announcements stay off on any doubt. */
function readVoice() {
  try {
    return localStorage.getItem(VOICE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the voice preference, tolerating a blocked `localStorage`. */
function writeVoice(enabled) {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* a blocked storage only costs persistence */
  }
}

/** Read the session list mirror, or an empty stand-in before it is ready. */
function readList(ctx) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  if (sessions === undefined || sessions.list === undefined) return {};
  try {
    return sessions.list.getSnapshot() ?? {};
  } catch {
    return {};
  }
}

/** Whether any session is running work right now. */
function isBusy(list) {
  const currentId = list.current;
  const summary = currentId === undefined ? undefined : (list.byId ?? {})[currentId];
  if (summary !== undefined && summary.running === true) return true;
  const jobs = currentId === undefined ? undefined : (list.jobsBySession ?? {})[currentId];
  return Array.isArray(jobs) && jobs.some((job) => isLive(job));
}

/** Speak one announcement when the user left voice on. */
function speak(enabled, text) {
  if (!enabled || typeof window === 'undefined' || typeof window.speechSynthesis !== 'function') return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.warn('[digital-human] speech synthesis failed', error);
  }
}

/**
 * Mount the digital human.
 * @param ctx - the client root context.
 */
function apply(ctx) {
  ensureStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'digital-human: dictionaries');

  const session = {
    voice: readVoice(),
    approvals: [],
    doneAt: undefined,
    wasBusy: false,
    lastFace: undefined,
  };
  const store = createStore(projectInto(undefined, {
    list: readList(ctx),
    approvals: session.approvals,
    voice: session.voice,
    now: Date.now(),
    doneAt: session.doneAt,
  }));

  /** Re-project the mirror into the published snapshot. */
  const refresh = () => {
    const now = Date.now();
    const list = readList(ctx);
    const busy = isBusy(list);
    if (session.wasBusy && !busy) session.doneAt = now;
    if (!busy && session.doneAt !== undefined && now - session.doneAt > DONE_HOLD_MS) session.doneAt = undefined;
    session.wasBusy = busy;
    const snapshot = projectInto(store.getSnapshot(), {
      list,
      approvals: session.approvals,
      voice: session.voice,
      now,
      doneAt: session.doneAt,
    });
    store.set(snapshot);
    announce(snapshot);
  };

  /** Announce a face change once per change. */
  const announce = (snapshot) => {
    if (snapshot.face === session.lastFace) return;
    session.lastFace = snapshot.face;
    const text = format(zh[snapshot.message.key] ?? snapshot.message.key, snapshot.message.params);
    if (snapshot.face === 'waiting') speak(session.voice, format(zh['approval.voice']));
    else if (snapshot.face === 'error' || snapshot.face === 'done') speak(session.voice, text);
  };

  /** Toggle voice announcements. */
  const setVoice = (enabled) => {
    session.voice = enabled === true;
    writeVoice(session.voice);
    if (!session.voice && typeof window !== 'undefined' && typeof window.speechSynthesis === 'function') {
      window.speechSynthesis.cancel();
    }
    refresh();
  };

  setRuntime({
    store,
    refresh,
    toggleVoice: () => {
      setVoice(!session.voice);
    },
  });

  /* 1. Session mirror: the list store plus a one-second tick for live rows. */
  ctx.effect(() => {
    const list = ctx.get('sessions')?.list;
    const off = list !== undefined && typeof list.subscribe === 'function' ? list.subscribe(refresh) : () => {};
    const timer = setInterval(refresh, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, 'digital-human: session mirror');

  /* 2. Permission answerer: hold the request until the card answers it. */
  ctx.remote.$on('approval/request', function onApproval(request, next) {
    const sessionId = ctx.get('sessions')?.scopeOf?.(this);
    if (sessionId === undefined) return next();
    const pending = new PendingApproval(sessionId, request);
    session.approvals = [...session.approvals, pending];
    refresh();
    const release = () => {
      session.approvals = session.approvals.filter((entry) => entry !== pending);
      refresh();
    };
    return pending.result.then(
      (outcome) => {
        release();
        return outcome;
      },
      (error) => {
        release();
        if (pending.isDelegation(error)) return next();
        throw error;
      },
    );
  });

  /* 3. The floating widget, in the shell's own overlay layer. */
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'digital-human',
    order: 40,
    locale: NS,
  }, DigitalHumanOverlay));
}

module.exports = { apply, inject };
