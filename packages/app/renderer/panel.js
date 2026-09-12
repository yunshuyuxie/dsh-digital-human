/**
 * The panel body: sessions, the selected session's activity, and its composer.
 *
 * Every snapshot rebuilds the lists (they are tiny and this keeps the code
 * honest), but the composer is a persistent form so typing is never lost.
 */
import { t , has } from './locales.js';

/** Characters of `activity[].text` shown per row. */
const ACTIVITY_LIMIT = 90;

/** Characters of a session's `displayTitle` shown as the all-sessions row prefix. */
const SESSION_LABEL_LIMIT = 14;

/** Rows kept in the all-sessions aggregate (P2-7). */
const ACTIVITY_MERGE_LIMIT = 40;

/** How recent an entry must be for its session to be pinned (P2-7). */
const ACTIVITY_PIN_MS = 2 * 60 * 1000;

/** `Ctrl+1` … `Ctrl+9` select the Nth rendered root session. */
const SESSION_SHORTCUTS = 9;

/** The three panel backgrounds main may ask for; anything else is a 0.92 default. */
const OPACITY_VALUES = [0.85, 0.92, 1];

/** Locale key of each opacity step, for the footer control. */
const OPACITY_LABEL = {
  0.85: 'footer.opacity.dim',
  0.92: 'footer.opacity.default',
  1: 'footer.opacity.solid',
};

/** Coerce a wire value onto one of the three known steps. */
function normalizeOpacity(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(number)) return 0.92;
  let best = 0.92;
  for (const step of OPACITY_VALUES) if (Math.abs(step - number) < Math.abs(best - number)) best = step;
  return best;
}

/** The next of the three steps, so the control cycles 半透明 → 标准 → 不透明. */
function nextOpacity(value) {
  const index = OPACITY_VALUES.indexOf(value);
  return OPACITY_VALUES[(index < 0 ? 1 : index + 1) % OPACITY_VALUES.length];
}

/**
 * Build an element.
 * @param tag - tag name.
 * @param props - `class`, `text`, `attrs`, `children` are understood.
 * @param children - child nodes appended after `props.children`.
 * @returns the new element.
 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props.class !== undefined) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value !== null && value !== undefined) el.setAttribute(name, String(value));
  }
  const all = [...(props.children ?? []), ...children];
  for (const child of all) if (child !== null && child !== undefined) el.append(child);
  return el;
}

/** Cut a workflow string down to one readable line. */
function clip(text, limit) {
  const value = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}${t('util.truncated')}`;
}

/** Like {@link clip}, but the marker is a bare ellipsis (session labels). */
function clipPlain(text, limit) {
  const value = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

/** `activity.kind` (`tool/call`) as a locale key (`activity.toolCall`). */
function kindKey(kind) {
  const raw = String(kind ?? '');
  const name = raw
    .replace(/[^a-z0-9]+([a-z0-9])/gu, (_match, letter) => letter.toUpperCase())
    .replace(/^[^a-z]+/u, '');
  const key = `activity.${name === '' ? 'unknown' : name}`;
  // A kind the dictionary does not know yet shows its wire name, which stays
  // readable, instead of printing a dotted key at the user.
  if (has(key)) return key;
  return raw === '' ? 'activity.unknown' : raw;
}

/** The `status.dot` state of one session row. */
function rowState(session) {
  if (session.lastAgentError !== null && session.lastAgentError !== undefined) return 'error';
  if (session.running === true) return 'running';
  return 'idle';
}

/** A tiny label with a count, e.g. `后台 2`. */
function countBadge(key, value, className) {
  return h('span', { class: className, text: t(key, { count: value }) });
}

/**
 * Whether one session row is an agent-spawned child.
 *
 * An older snapshot carries no `parentId` at all, which means "root": folding is
 * simply unavailable there instead of everything disappearing into the fold.
 */
function isChildSession(session) {
  const parentId = session?.parentId;
  return typeof parentId === 'string' && parentId !== '';
}

/** A `刚刚` / `N 秒前` / `N 分前` / `N 小时前` label; `''` without a usable time. */
function relativeTime(time, now) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 1) return t('time.justNow');
  if (seconds < 60) return t('time.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutes', { count: minutes });
  return t('time.hours', { count: Math.floor(minutes / 60) });
}

/** `provider|model` as one `<option>` value; both ids are percent-encoded. */
function modelValue(provider, model) {
  return `${encodeURIComponent(provider)}|${encodeURIComponent(model)}`;
}

/**
 * Flatten a catalog into provider groups of entries.
 *
 * Only groups that actually carry models survive: `snapshot.models` may be null
 * or malformed, and a guess about a provider the catalog does not list would be a
 * lie in the picker.
 *
 * @param catalog - `{ groups: [{ id, name, models: [{ id, name }] }] }`, or null.
 * @returns `[{ providerName, entries: [{ provider, model, providerName, modelName, value }] }]`.
 */
function catalogGroups(catalog) {
  const groups = [];
  const source = Array.isArray(catalog?.groups) ? catalog.groups : [];
  for (const group of source) {
    if (group === null || typeof group !== 'object') continue;
    const provider = typeof group.id === 'string' && group.id !== ''
      ? group.id
      : (typeof group.name === 'string' ? group.name : '');
    if (provider === '') continue;
    const providerName = typeof group.name === 'string' && group.name !== '' ? group.name : provider;
    const entries = [];
    for (const model of Array.isArray(group.models) ? group.models : []) {
      const row = typeof model === 'string' ? { id: model, name: model } : model;
      if (row === null || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' && row.id !== '' ? row.id : (typeof row.name === 'string' ? row.name : '');
      if (id === '') continue;
      const name = typeof row.name === 'string' && row.name !== '' ? row.name : id;
      entries.push({ provider, model: id, providerName, modelName: name, value: modelValue(provider, id) });
    }
    if (entries.length > 0) groups.push({ providerName, entries });
  }
  return groups;
}

/** Match a `provider/model` wire ref against the catalog: by id first, then by name. */
function matchRef(groups, ref) {
  if (typeof ref !== 'string' || ref === '') return null;
  for (const group of groups) {
    for (const entry of group.entries) if (`${entry.provider}/${entry.model}` === ref) return entry;
  }
  for (const group of groups) {
    for (const entry of group.entries) if (`${entry.providerName}/${entry.modelName}` === ref) return entry;
  }
  return null;
}

/** Match `snapshot.models.default` (`{ provider, model }`) against the catalog. */
function matchDefault(groups, fallback) {
  if (fallback === null || typeof fallback !== 'object') return null;
  return matchRef(groups, `${String(fallback.provider ?? '')}/${String(fallback.model ?? '')}`);
}

/**
 * `window.digitalHuman` commands resolve to `{ ok, value }`; a caller may also
 * hand the bare value. Both shapes are accepted so the panel does not depend on
 * the envelope.
 */
function unwrapResult(result) {
  if (result !== null && typeof result === 'object' && !Array.isArray(result) && 'ok' in result && 'value' in result) {
    return result.value;
  }
  return result;
}

/**
 * Create the panel body.
 * @param options - `{ onSelect, onDeselect, onSend, onCancel, onTogglePin, onHide,
 *   onSelectModel, onRefreshModels, onCreateSession, onRename, onSetPanelOpacity,
 *   onError }`.
 *   A callback the host does not provide disables its control instead of
 *   pretending the action succeeded.
 * @returns `{ el, update, select, selectedId, notice, selectByShortcut,
 *   escapeHeldByFocus }`.
 */
export function createPanel(options = {}) {
  let selectedId = null;
  let busy = false;
  let pinned = true;
  let lastSnapshot = null;
  let notice = '';
  // Local renderer state: whether subagent children are unfolded. `update()`
  // rebuilds the list but never resets this.
  let showChildren = false;
  // Local renderer state, same contract: whether the activity feed is the
  // all-sessions aggregate (P2-7). Default is the selected session's own feed.
  let activityAll = false;
  /** Encoded option value → catalog entry, rebuilt with every model render. */
  let modelIndex = new Map();
  /** The catalog signature the picker row was built for, or `null`. */
  let pickerSignature = null;
  /** The built picker row (`<li>`), reused so an unchanged catalog is not redrawn. */
  let pickerEl = null;
  /** A session that was just created and is not in a snapshot yet. */
  let pendingSelect = null;
  /** The panel background alpha main last reported (0.85 / 0.92 / 1). */
  let panelOpacity = 0.92;
  /** The alpha already written to `--dh-panel-alpha`, so it is written once. */
  let appliedOpacity = null;

  const statusLine = h('p', { class: 'dh-status-line', attrs: { 'aria-live': 'polite' } });
  // The localized disconnection reason gets its own dim line: at 360px a single
  // line could only ever ellipsise it (see docs/ui-plan.md P2-6).
  const statusReason = h('p', { class: 'dh-status-reason', attrs: { hidden: '' } });
  const statusText = h('div', { class: 'dh-status-text' }, statusLine, statusReason);
  const retryButton = h('button', {
    class: 'dh-btn dh-btn-ghost dh-retry',
    text: t('status.retry'),
    attrs: { type: 'button', 'aria-label': t('status.retry'), hidden: '' },
  });
  const status = h('div', { class: 'dh-status' }, statusText, retryButton);

  const sessionList = h('ul', {
    class: 'dh-sessions',
    attrs: { 'aria-label': t('panel.sessions'), 'aria-live': 'polite' },
  });
  const childrenToggle = h('button', {
    class: 'dh-btn dh-btn-ghost dh-btn-tiny',
    text: t('session.children', { count: 0 }),
    attrs: { type: 'button', hidden: '' },
  });
  const renameButton = h('button', {
    class: 'dh-btn dh-btn-ghost dh-btn-tiny',
    text: t('session.rename'),
    attrs: { type: 'button', 'aria-label': t('session.rename'), hidden: '' },
  });
  // The header copy of `新建会话` is hidden while the list is empty: the
  // empty-state row already carries one, and two identical buttons read as a bug.
  const headerCreateButton = createSessionButton();
  const sessionsHead = h(
    'div',
    { class: 'dh-section-head' },
    h('h3', { class: 'dh-section-title', text: t('panel.sessions') }),
    h('div', { class: 'dh-section-tools' }, headerCreateButton, renameButton, childrenToggle),
  );
  const sessionsSection = h('section', { class: 'dh-section dh-section-sessions' }, sessionsHead, sessionList);

  const activityList = h('ul', { class: 'dh-activity', attrs: { 'aria-label': t('panel.activity') } });
  const activityTitle = h('h3', { class: 'dh-section-title', text: t('panel.activity') });
  // P2-7: the two-state scope switch. `aria-pressed` carries the state; the
  // label pair is short enough to fit the header at 300px.
  const modeCurrentButton = h('button', {
    class: 'dh-btn dh-btn-ghost dh-btn-tiny dh-mode',
    text: t('activity.scope.current'),
    attrs: { type: 'button', 'aria-pressed': 'true', 'aria-label': t('activity.scope.current') },
  });
  const modeAllButton = h('button', {
    class: 'dh-btn dh-btn-ghost dh-btn-tiny dh-mode',
    text: t('activity.scope.all'),
    attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': t('activity.scope.all') },
  });
  const activityHead = h(
    'div',
    { class: 'dh-section-head' },
    activityTitle,
    h('div', { class: 'dh-section-tools dh-mode-switch' }, modeCurrentButton, modeAllButton),
  );
  const activitySection = h('section', { class: 'dh-section dh-section-activity' }, activityHead, activityList);

  const input = h('textarea', {
    class: 'dh-composer-input',
    attrs: { rows: '2', placeholder: t('composer.placeholder'), 'aria-label': t('composer.placeholder') },
  });
  const sendButton = h('button', {
    class: 'dh-btn dh-btn-send',
    text: t('composer.send'),
    attrs: { type: 'button', 'aria-label': t('composer.send') },
  });
  const cancelButton = h('button', {
    class: 'dh-btn dh-btn-ghost',
    text: t('composer.cancel'),
    attrs: { type: 'button', 'aria-label': t('composer.cancel') },
  });
  const composerNote = h('p', { class: 'dh-composer-note', attrs: { 'aria-live': 'polite' } });
  // P0-1: the composer holds the textarea and the two actions — nothing else.
  // The model picker lives on the selected session's row (`buildPickerRow`).
  const composer = h(
    'form',
    { class: 'dh-composer', attrs: { 'aria-label': t('composer.placeholder') } },
    input,
    h('div', { class: 'dh-actions' }, sendButton, cancelButton),
    composerNote,
  );

  const footerCounts = h('span', { class: 'dh-foot-counts', attrs: { role: 'status' } });
  const pinButton = h('button', {
    class: 'dh-btn dh-btn-ghost',
    text: t('footer.pin'),
    attrs: { type: 'button', 'aria-label': t('footer.pin') },
  });
  const opacityButton = h('button', {
    class: 'dh-btn dh-btn-ghost dh-opacity',
    text: t('footer.opacity.default'),
    attrs: { type: 'button', 'aria-label': t('footer.opacity.label'), title: t('footer.opacity.label') },
  });
  const hideButton = h('button', {
    class: 'dh-btn dh-btn-ghost',
    text: t('footer.hide'),
    attrs: { type: 'button', 'aria-label': t('footer.hide') },
  });
  const footer = h(
    'footer',
    { class: 'dh-footer' },
    footerCounts,
    h('div', { class: 'dh-actions dh-actions-compact' }, pinButton, opacityButton, hideButton),
  );

  const body = h(
    'div',
    { class: 'dh-body' },
    sessionsSection,
    activitySection,
    composer,
  );
  const el = h('div', { class: 'dh-panel' }, status, body, footer);

  /** Show a short-lived note under the composer. */
  function setNotice(text) {
    notice = text;
    composerNote.textContent = text;
  }

  /** Select or deselect one session, mirroring it to the bridge. */
  function select(id, pending = false) {
    if (id === selectedId) return;
    const previous = selectedId;
    selectedId = id;
    // A session created a moment ago is not in any snapshot yet: hold its
    // selection instead of letting the next `update()` call treat it as gone.
    pendingSelect = pending ? id : null;
    setNotice('');
    if (previous !== null) {
      // Fire the callback synchronously so a test (and the bridge) sees the
      // selection in the same turn; only a rejection is deferred.
      try {
        options.onDeselect?.(previous);
      } catch (error) {
        options.onError?.(error);
      }
    }
    if (id !== null) {
      try {
        options.onSelect?.(id);
      } catch (error) {
        options.onError?.(error);
      }
    }
    if (lastSnapshot !== null) update(lastSnapshot);
  }

  /** The snapshot row of the selected session, once the snapshot knows it. */
  function currentSession() {
    if (selectedId === null || lastSnapshot === null) return null;
    const sessions = Array.isArray(lastSnapshot.sessions) ? lastSnapshot.sessions : [];
    return sessions.find((session) => session?.id === selectedId) ?? null;
  }

  /** A fresh `新建会话` button: one node can only live in one place. */
  function createSessionButton() {
    const button = h('button', {
      class: 'dh-btn dh-btn-ghost dh-btn-tiny',
      text: t('session.create'),
      attrs: { type: 'button', 'aria-label': t('session.create') },
    });
    if (typeof options.onCreateSession !== 'function') button.hidden = true;
    button.addEventListener('click', () => {
      createSession();
    });
    return button;
  }

  /** Create a session (the bridge opens the directory picker), then select it. */
  function createSession() {
    if (typeof options.onCreateSession !== 'function') return;
    run(async () => {
      const created = unwrapResult(await options.onCreateSession());
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
      if (sessionId === '') {
        // The directory dialog was dismissed, or the bridge created nothing.
        setNotice(t('session.createCancelled'));
        return;
      }
      select(sessionId, true);
      setNotice(t('session.created'));
    });
  }

  /** Rename the selected session through the native prompt. */
  function renameSession() {
    if (selectedId === null || typeof options.onRename !== 'function') return;
    const sessionId = selectedId;
    const seed = String(currentSession()?.displayTitle ?? sessionId);
    if (typeof globalThis.prompt !== 'function') {
      options.onError?.(new Error(t('session.renameUnavailable')));
      return;
    }
    let answer = null;
    try {
      answer = globalThis.prompt(t('session.renamePrompt'), seed);
    } catch (error) {
      options.onError?.(error);
      return;
    }
    if (answer === null || answer === undefined) return;
    const title = String(answer).trim();
    if (title === '') return;
    run(async () => {
      await options.onRename(sessionId, title);
      setNotice(t('session.renamed'));
    });
  }

  /** Send one model choice for the selected session. */
  function pickModel(value) {
    const entry = modelIndex.get(value);
    if (entry === undefined) return;
    if (selectedId === null || typeof options.onSelectModel !== 'function') {
      setNotice(t('model.unsupported'));
      if (lastSnapshot !== null) update(lastSnapshot);
      return;
    }
    const sessionId = selectedId;
    run(async () => {
      await options.onSelectModel(sessionId, entry.provider, entry.model);
      setNotice(t('model.selected', { model: `${entry.providerName} · ${entry.modelName}` }));
    });
  }

  /** Re-read the model catalog from the bridge. */
  function refreshModels() {
    if (typeof options.onRefreshModels !== 'function') return;
    run(async () => {
      await options.onRefreshModels();
      setNotice(t('model.refreshed'));
    });
  }

  /** One session row. */
  function buildRow(session, child = false) {
    const state = rowState(session);
    const selected = session.id === selectedId;
    const title = String(session.displayTitle ?? session.id);
    const row = h('li', { class: 'dh-session-row' });
    if (child) row.classList.add('dh-session-row-child');
    // The root/child marker is what `Ctrl+1..9` counts: the picker row and the
    // empty-state row are neither, so they can never become a shortcut target.
    row.classList.add(child ? 'dh-session-child' : 'dh-session-root');
    const button = h('button', {
      class: 'dh-session',
      attrs: {
        type: 'button',
        'data-state': state,
        'data-session-id': String(session.id),
        'aria-pressed': String(selected),
        'aria-label': `${title} · ${t(`session.${state}`)}`,
      },
    });
    if (selected) button.classList.add('dh-session-selected');
    button.append(
      h('span', { class: 'dh-dot', attrs: { 'data-state': state } }),
      // One line only: the full title stays reachable through `title` (P2-5).
      h('span', { class: 'dh-session-title', text: title, attrs: { title } }),
    );
    if (child) button.append(h('span', { class: 'dh-chip-sub', text: t('session.childChip') }));
    if (session.liveJobs > 0) button.append(countBadge('session.jobs', session.liveJobs, 'dh-count'));
    if (Array.isArray(session.activeTools) && session.activeTools.length > 0) {
      button.append(countBadge('session.tools', session.activeTools.length, 'dh-count'));
    }
    button.addEventListener('click', () => {
      select(selected ? null : session.id);
    });
    row.append(button);
    return row;
  }

  /** One activity line: relative time, kind, tool, status, text. */
  function buildActivityRow(entry, now, meta = null, pinned = false) {
    const statusText = typeof entry.status === 'string' ? entry.status : '';
    const kind = t(kindKey(entry.kind));
    const row = h('li', { class: 'dh-activity-row' });
    if (pinned) row.classList.add('dh-activity-row-pinned');
    if (meta !== null) {
      row.classList.add('dh-activity-row-all');
      const label = meta.label;
      row.append(
        h('span', {
          class: 'dh-activity-session',
          text: label,
          attrs: { title: `${t('activity.rowTitle', { session: meta.full, kind })}` },
        }),
      );
      if (meta.child) row.append(h('span', { class: 'dh-chip-sub', text: t('session.childChip') }));
    }
    const age = relativeTime(entry.time, now);
    if (age !== '') row.append(h('span', { class: 'dh-activity-time', text: age }));
    row.append(
      h('span', { class: 'dh-kind', text: kind }),
      h('span', { class: 'dh-activity-tool', text: typeof entry.tool === 'string' ? entry.tool : '' }),
      h('span', { class: 'dh-activity-status', text: statusText }),
      h('span', { class: 'dh-activity-text', text: clip(entry.text, ACTIVITY_LIMIT) }),
    );
    return row;
  }

  /**
   * The short per-row session prefix of the all-sessions feed (P2-7).
   *
   * `id` is the session key of one `snapshot.activity` ring, which may name a
   * session the current snapshot no longer lists: the id's first eight
   * characters are the fallback and the label is still shown.
   */
  function sessionMeta(id, byId) {
    const session = byId.get(id) ?? null;
    const title = typeof session?.displayTitle === 'string' ? session.displayTitle : '';
    const fallback = String(id ?? '').slice(0, 8);
    const full = title === '' ? fallback : title;
    return {
      label: clipPlain(full, SESSION_LABEL_LIMIT),
      full: full === '' ? String(id ?? '') : full,
      child: isChildSession(session),
    };
  }

  /** The sessions that must not be missed: an open approval, or an agent error. */
  function prioritySessionIds(snapshot) {
    const ids = new Set();
    const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    for (const approval of approvals) {
      const sessionId = approval?.sessionId;
      if (typeof sessionId === 'string' && sessionId !== '') ids.add(sessionId);
    }
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    for (const session of sessions) {
      if (session?.lastAgentError !== null && session?.lastAgentError !== undefined) ids.add(session.id);
    }
    return ids;
  }

  /**
   * Merge every session ring into one newest-first list (P2-7).
   *
   * Missing, empty, or malformed rings are simply skipped, so a snapshot
   * without `activity` still renders the empty state instead of throwing.
   */
  function mergeActivity(snapshot, priority, now) {
    const source = snapshot.activity;
    const rows = [];
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return rows;
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const byId = new Map();
    for (const session of sessions) if (typeof session?.id === 'string') byId.set(session.id, session);
    for (const [sessionId, ring] of Object.entries(source)) {
      if (!Array.isArray(ring)) continue;
      const meta = sessionMeta(sessionId, byId);
      for (const raw of ring) {
        const entry = raw !== null && typeof raw === 'object' ? raw : {};
        const time = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : 0;
        rows.push({
          entry,
          meta,
          time,
          // "The last ~2 minutes" is a window, not a property of the session:
          // an idle session with an old approval is not pinned.
          pinned: priority.has(sessionId) && now - time <= ACTIVITY_PIN_MS,
        });
      }
    }
    rows.sort((left, right) => right.time - left.time);
    return rows.slice(0, ACTIVITY_MERGE_LIMIT);
  }

  /** One `需要处理` heading line for the pinned group. */
  function buildActivityHeading(key) {
    return h('li', { class: 'dh-activity-head', text: t(key) });
  }

  /** P2-7: the aggregate feed — pinned group first, then newest first. */
  function renderAllActivity(snapshot, now) {
    const priority = prioritySessionIds(snapshot);
    const rows = mergeActivity(snapshot, priority, now);
    if (rows.length === 0) {
      activityList.append(h('li', { class: 'dh-empty', text: t('activity.noActivity') }));
      return;
    }
    const pinned = rows.filter((row) => row.pinned);
    const rest = rows.filter((row) => !row.pinned);
    if (pinned.length > 0) {
      activityList.append(buildActivityHeading('activity.pinned'));
      for (const row of pinned) activityList.append(buildActivityRow(row.entry, now, row.meta, true));
    }
    if (rest.length > 0) {
      // Only label the chronological list when a pinned group sits above it.
      if (pinned.length > 0) activityList.append(buildActivityHeading('activity.recent'));
      for (const row of rest) activityList.append(buildActivityRow(row.entry, now, row.meta, false));
    }
  }

  /** Rebuild the activity feed: the selected session, or every session (P2-7). */
  function renderActivity(snapshot) {
    activityList.replaceChildren();
    for (const [key, button] of [['activity.scope.current', modeCurrentButton], ['activity.scope.all', modeAllButton]]) {
      const pressed = (key === 'activity.scope.all') === activityAll;
      button.setAttribute('aria-pressed', String(pressed));
      if (pressed) button.classList.add('dh-mode-on');
      else button.classList.remove('dh-mode-on');
    }
    if (activityAll) {
      activityTitle.textContent = t('activity.modeAll');
      renderAllActivity(snapshot, Date.now());
      return;
    }
    if (selectedId === null) {
      activityTitle.textContent = t('panel.activity');
      activityList.append(h('li', { class: 'dh-empty', text: t('panel.selectHint') }));
      return;
    }
    const title = selectedId.slice(0, 8);
    activityTitle.textContent = `${t('panel.activity')} · ${title}`;
    const ring = snapshot.activity?.[selectedId];
    const entries = Array.isArray(ring) ? ring : [];
    if (entries.length === 0) {
      activityList.append(h('li', { class: 'dh-empty', text: t('panel.noActivity') }));
      return;
    }
    const now = Date.now();
    for (const entry of entries) activityList.append(buildActivityRow(entry ?? {}, now));
  }

  /** Rebuild the session list: roots always, subagent children behind the toggle. */
  function renderSessions(snapshot) {
    sessionList.replaceChildren();
    renameButton.hidden = selectedId === null || typeof options.onRename !== 'function';
    // A malformed list (a null entry) is dropped rather than rendered: the rest
    // of the snapshot still has to reach the screen.
    const sessions = (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
      .filter((session) => session !== null && typeof session === 'object' && typeof session.id === 'string');
    const roots = sessions.filter((session) => !isChildSession(session));
    const children = sessions.filter((session) => isChildSession(session));
    // Cleanup: with no sessions the empty row owns the only `新建会话` button.
    headerCreateButton.hidden = roots.length === 0 || typeof options.onCreateSession !== 'function';
    // An older snapshot has no `counts.children`; the rows themselves still say
    // which sessions are children, so fold on that.
    const reported = snapshot.counts?.children;
    const childCount = typeof reported === 'number' ? reported : children.length;
    childrenToggle.hidden = childCount === 0;
    childrenToggle.textContent = showChildren
      ? t('session.childrenHide')
      : t('session.children', { count: childCount });
    childrenToggle.setAttribute('aria-label', childrenToggle.textContent);
    childrenToggle.setAttribute('aria-expanded', String(showChildren));
    if (roots.length === 0) {
      const row = h('li', { class: 'dh-empty-row' });
      row.append(h('span', { class: 'dh-empty', text: t('panel.noSessions') }));
      if (typeof options.onCreateSession === 'function') row.append(createSessionButton());
      sessionList.append(row);
      return;
    }
    let selectedRow = null;
    for (const session of roots) {
      const row = buildRow(session, false);
      sessionList.append(row);
      if (session.id === selectedId) selectedRow = row;
    }
    if (showChildren && childCount > 0) {
      sessionList.append(h('li', { class: 'dh-subhead', text: t('session.childrenHead') }));
      for (const session of children) {
        const row = buildRow(session, true);
        sessionList.append(row);
        if (session.id === selectedId) selectedRow = row;
      }
    }
    // P0-1: the model picker is a compact control under the selected row, so the
    // composer below stays a plain textarea + send/cancel.
    if (pickerEl !== null && selectedId !== null) {
      if (selectedRow === null) {
        // The selected session sits inside the folded children group: keep the
        // picker reachable rather than letting it vanish with the row.
        sessionList.prepend(pickerEl);
      } else {
        selectedRow.after(pickerEl);
      }
    }
  }

  /** Open a refresh round for the picker's 刷新 button. */
  function onPickerRefresh() {
    refreshModels();
  }

  /**
   * The compact model control for the selected session (docs/ui-plan.md P0-1).
   *
   * The snapshot is the only authority: the value is always re-derived from it,
   * so a rejected selection snaps back on the next render instead of lingering.
   */
  function buildPickerRow(snapshot) {
    const supported = snapshot.modelsSupported === true;
    const groups = supported ? catalogGroups(snapshot.models) : [];
    const model = currentSession()?.model;
    const current = typeof model === 'string' && model !== '' ? model : null;
    const fallback = matchDefault(groups, snapshot.models?.default);
    const chosen = matchRef(groups, current) ?? fallback;
    // A snapshot arrives on every activity event, and rebuilding the select would
    // close an open dropdown: redraw only when the catalog actually changed.
    const signature = [
      supported,
      selectedId,
      busy,
      groups.map((group) => `${group.providerName}:${group.entries.map((entry) => entry.value).join(',')}`).join(';'),
    ].join('|');
    if (signature === pickerSignature && pickerEl !== null) return pickerEl;
    pickerSignature = signature;
    modelIndex = new Map();
    const row = h('li', { class: 'dh-session-picker-row' });
    const select = h('select', {
      class: 'dh-model-select',
      attrs: { 'aria-label': t('model.select') },
    });
    if (supported && groups.length > 0) {
      if (chosen === null) {
        select.append(h('option', { text: t('model.unset'), attrs: { value: '', disabled: '' } }));
      }
      for (const group of groups) {
        const optgroup = h('optgroup', { attrs: { label: group.providerName } });
        for (const entry of group.entries) {
          optgroup.append(h('option', {
            text: `${entry.providerName} · ${entry.modelName}`,
            attrs: { value: entry.value },
          }));
          modelIndex.set(entry.value, entry);
        }
        select.append(optgroup);
      }
      select.value = chosen === null ? '' : chosen.value;
    } else {
      select.append(h('option', { text: t('model.unset'), attrs: { value: '', disabled: '' } }));
      select.value = '';
    }
    select.disabled = selectedId === null || busy || !supported || groups.length === 0;
    row.append(select);
    if (typeof options.onRefreshModels === 'function') {
      const refresh = h('button', {
        class: 'dh-btn dh-btn-ghost dh-btn-tiny',
        text: t('model.refresh'),
        attrs: { type: 'button', 'aria-label': t('model.refresh') },
      });
      refresh.addEventListener('click', onPickerRefresh);
      row.append(refresh);
    }
    // A truthful hint instead of an empty dropdown: the two cases are different
    // facts and both are already localised.
    let hintKey = null;
    if (!supported) hintKey = 'model.unsupported';
    else if (groups.length === 0) hintKey = 'model.empty';
    else if (matchRef(groups, current) === null) hintKey = 'model.unset';
    if (hintKey !== null) {
      row.append(h('span', {
        class: 'dh-model-hint',
        text: t(hintKey),
        attrs: { title: t(hintKey) },
      }));
    }
    pickerEl = row;
    return row;
  }

  /** The connection status: one line when connected, state + reason when not. */
  function renderStatus(snapshot) {
    const phase = snapshot.status?.phase ?? 'offline';
    const connected = phase === 'connected';
    const bridge = snapshot.status?.bridgeVersion;
    if (connected) {
      statusLine.textContent = t('status.connected', {
        host: snapshot.status?.host ?? '—',
        profile: snapshot.status?.profile ?? '—',
        bridge: bridge === null || bridge === undefined || bridge === '' ? '—' : bridge,
      });
      statusLine.dataset.state = 'connected';
      statusLine.title = statusLine.textContent;
      statusReason.hidden = true;
      statusReason.textContent = '';
      statusReason.removeAttribute('title');
    } else {
      // First line: the phase. Second line: the localized reason, dimmer and
      // allowed to wrap so 360px can show it whole (P2-6). The main process
      // reports a code plus parameters so the reason can be translated; its
      // untranslated text is the last-resort fallback.
      statusLine.textContent = t(`status.phase.${phase}`);
      statusLine.dataset.state = 'offline';
      statusLine.title = statusLine.textContent;
      const detail = snapshot.status?.detail ?? null;
      const code = typeof detail?.code === 'string' ? detail.code : '';
      const key = `status.code.${code}`;
      const reason = code !== '' && has(key) ? t(key, detail.params ?? {}) : (detail?.text ?? '');
      statusReason.hidden = false;
      statusReason.textContent = reason === '' ? t('status.noDetail') : reason;
      // The two-line block can still overflow: hover stays the final fallback.
      statusReason.title = statusReason.textContent;
    }
    retryButton.hidden = connected;
  }

  /** The footer counters, the pin state, and the panel opacity (main-owned). */
  function renderFooter(snapshot) {
    footerCounts.textContent = t('footer.counts', {
      sessions: snapshot.counts?.sessions ?? 0,
      running: snapshot.counts?.running ?? 0,
      jobs: snapshot.counts?.liveJobs ?? 0,
    });
    const actual = snapshot.runtime?.alwaysOnTop;
    pinned = actual === undefined ? pinned : actual === true;
    pinButton.textContent = pinned ? t('footer.unpin') : t('footer.pin');
    pinButton.setAttribute('aria-label', pinButton.textContent);
    pinButton.setAttribute('aria-pressed', String(pinned));
    renderOpacity(snapshot);
  }

  /**
   * Mirror `runtime.panelOpacity` onto the footer control and the panel alpha.
   *
   * A snapshot without `runtime`, or without a usable `panelOpacity`, is an older
   * main process: the default stays. `runtime` may legitimately be `undefined`.
   */
  function renderOpacity(snapshot) {
    const raw = snapshot.runtime?.panelOpacity;
    if (raw !== undefined && raw !== null) panelOpacity = normalizeOpacity(raw);
    paintOpacity(panelOpacity);
  }

  /** The control label for one step, e.g. `标准`. */
  function opacityLabel(value) {
    return t(OPACITY_LABEL[value]);
  }

  /** Show one step in the footer button and write it to the CSS variable. */
  function paintOpacity(value) {
    const label = opacityLabel(value);
    opacityButton.textContent = label;
    opacityButton.setAttribute('aria-label', `${t('footer.opacity.label')} · ${label}`);
    opacityButton.setAttribute('title', t('footer.opacity.label'));
    if (typeof options.onSetPanelOpacity !== 'function') {
      // An older preload cannot change it: tell the truth instead of pretending.
      opacityButton.disabled = true;
      opacityButton.setAttribute('title', t('footer.opacity.unavailable'));
    }
    if (appliedOpacity === value) return;
    appliedOpacity = value;
    // The background that reads this variable is on `.dh-root`, an ancestor of
    // this panel: custom properties inherit downward only, so writing it here had
    // no effect. Set it on the document root instead.
    document.documentElement.style.setProperty('--dh-panel-alpha', String(value));
  }

  /**
   * Render one snapshot.
   * @param snapshot - the projected snapshot from `window.digitalHuman`.
   */
  function update(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') return;
    lastSnapshot = snapshot;
    // A malformed list (a null entry) must not break the selection bookkeeping.
    const sessions = (Array.isArray(snapshot?.sessions) ? snapshot.sessions : [])
      .filter((session) => session !== null && typeof session === 'object');
    if (pendingSelect !== null && sessions.some((session) => session.id === pendingSelect)) {
      // The snapshot caught up with the session created a moment ago.
      pendingSelect = null;
    }
    if (selectedId !== null && selectedId !== pendingSelect && !sessions.some((session) => session.id === selectedId)) {
      // The selected session disappeared; drop the follow subscription.
      const gone = selectedId;
      selectedId = null;
      Promise.resolve()
        .then(() => options.onDeselect?.(gone))
        .catch((error) => {
          options.onError?.(error);
        });
    }
    // P0-1: the picker is a child of the session list, so build (or reuse) it
    // before the list is assembled — but only when a session is selected.
    if (selectedId === null) {
      pickerSignature = null;
      pickerEl = null;
    } else {
      buildPickerRow(snapshot);
    }
    renderStatus(snapshot);
    renderSessions(snapshot);
    renderActivity(snapshot);
    renderFooter(snapshot);
    const hasSelection = selectedId !== null;
    input.disabled = !hasSelection || busy;
    sendButton.disabled = !hasSelection || busy;
    cancelButton.disabled = !hasSelection || busy;
  }

  /** Run one composer action with the busy flag held for its lifetime. */
  function run(action) {
    if (busy) return;
    busy = true;
    if (lastSnapshot !== null) update(lastSnapshot);
    Promise.resolve()
      .then(action)
      .then(() => {
        busy = false;
        if (lastSnapshot !== null) update(lastSnapshot);
      })
      .catch((error) => {
        busy = false;
        options.onError?.(error);
        if (lastSnapshot !== null) update(lastSnapshot);
      });
  }

  sendButton.addEventListener('click', () => {
    const text = input.value.trim();
    if (selectedId === null) {
      setNotice(t('composer.noSession'));
      return;
    }
    if (text === '') {
      input.focus();
      return;
    }
    const sessionId = selectedId;
    run(async () => {
      await options.onSend?.(sessionId, text);
      input.value = '';
      setNotice(t('composer.sent'));
    });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    sendButton.click();
  });

  /** The element a key event landed on, or the focused one. */
  function eventTarget(event) {
    const target = event.target;
    if (target !== null && target !== undefined && typeof target.nodeType === 'number') return target;
    return document.activeElement;
  }

  /** Whether `node` is `el` or sits inside it. */
  function inPanel(node) {
    for (let current = node; current !== null && current !== undefined; current = current.parentElement) {
      if (current === el) return true;
    }
    return false;
  }

  /**
   * P2-8: whether the composer or a native control holds focus, so the first
   * Escape must leave the field instead of collapsing the panel. The typed text
   * is never cleared.
   */
  function escapeHeldByFocus() {
    const focused = document.activeElement;
    if (focused === null || focused === undefined) return false;
    if (focused !== input && focused.tagName !== 'SELECT') return false;
    if (typeof focused.blur === 'function') focused.blur();
    return true;
  }

  /** The rendered root-session rows, in render order (P2-8: children never count). */
  function rootSessionRows() {
    const rows = [];
    for (const child of sessionList.children) {
      if (child.classList?.contains?.('dh-session-root') !== true) continue;
      const button = child.querySelector?.('.dh-session');
      if (button === null || button === undefined) continue;
      const id = button.getAttribute('data-session-id');
      if (typeof id === 'string' && id !== '') rows.push({ row: child, id });
    }
    return rows;
  }

  /** `Ctrl+1..9` selects the Nth root session in render order. */
  function selectByShortcut(event, digit) {
    if (digit < 1 || digit > SESSION_SHORTCUTS) return;
    // A `<select>` popup owns the number keys while it is open.
    if (document.activeElement?.tagName === 'SELECT') return;
    const rows = rootSessionRows();
    const target = rows[digit - 1];
    if (target === undefined) return;
    event.preventDefault();
    // P2-8: select the session and nothing else — no focus is moved.
    select(target.id);
    target.row.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * P2-8 keyboard handling for the panel.
   *
   * `Enter` in the composer and `Ctrl+1..9` are panel concerns; `Escape` is
   * shared with the host, which owns the compact form. A focused composer or
   * `<select>` swallows the first Escape (blur only, never clearing typed
   * text) and marks the event so the host does not collapse on that keypress.
   */
  function onPanelKeydown(event) {
    if (typeof event.key !== 'string') return;
    // The combo that opens a native `<select>` popup belongs to the popup.
    if (event.ctrlKey && event.key === ' ') return;
    const target = eventTarget(event);
    if (inPanel(target) === false) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[1-9]$/u.test(event.key)) {
      if (event.defaultPrevented === false) selectByShortcut(event, Number.parseInt(event.key, 10));
      return;
    }
    if (event.key !== 'Escape') return;
    if (escapeHeldByFocus() === true) {
      // Tell the host not to collapse on this same keypress. A control that
      // already handled the key (a native popup closing) still wins.
      event.dhPanelHandled = true;
    }
  }

  el.addEventListener('keydown', onPanelKeydown);

  cancelButton.addEventListener('click', () => {
    if (selectedId === null) return;
    const sessionId = selectedId;
    run(async () => {
      await options.onCancel?.(sessionId);
      setNotice(t('composer.cancelled'));
    });
  });

  retryButton.addEventListener('click', () => {
    run(async () => {
      await options.onReconnect?.();
      setNotice(t('status.retrying'));
    });
  });

  childrenToggle.addEventListener('click', () => {
    showChildren = !showChildren;
    if (lastSnapshot !== null) update(lastSnapshot);
  });

  renameButton.addEventListener('click', () => {
    renameSession();
  });

  // P2-7: switching the scope never touches the selection or the subscription.
  for (const [button, all] of [[modeCurrentButton, false], [modeAllButton, true]]) {
    button.addEventListener('click', () => {
      if (activityAll === all) return;
      activityAll = all;
      if (lastSnapshot !== null) update(lastSnapshot);
    });
  }

  pinButton.addEventListener('click', () => {
    pinned = !pinned;
    run(async () => {
      await options.onTogglePin?.(pinned);
    });
  });

  // One delegated listener survives every picker rebuild.
  sessionList.addEventListener('change', (event) => {
    const target = event.target;
    if (target === null || target === undefined) return;
    if (!String(target.className ?? '').split(/\s+/u).includes('dh-model-select')) return;
    pickModel(String(target.value ?? ''));
  });

  // Cycle the three steps locally so the click feels instant; the snapshot's
  // `runtime.panelOpacity` still wins on the next render. A missing preload
  // method leaves the control disabled instead of throwing (the contract allows
  // `runtime` or `setPanelOpacity` to be absent).
  opacityButton.addEventListener('click', () => {
    const action = options.onSetPanelOpacity;
    if (typeof action !== 'function') {
      setNotice(t('footer.opacity.unavailable'));
      paintOpacity(panelOpacity);
      return;
    }
    const value = nextOpacity(panelOpacity);
    panelOpacity = value;
    paintOpacity(value);
    run(async () => {
      await action(value);
    });
  });

  hideButton.addEventListener('click', () => {
    run(async () => {
      await options.onHide?.();
    });
  });

  return {
    el,
    update,
    select,
    selectedId: () => selectedId,
    notice: () => notice,
    // P2-8: the host routes its global `Ctrl+1..9` and `Escape` through these.
    selectByShortcut,
    escapeHeldByFocus,
  };
}
