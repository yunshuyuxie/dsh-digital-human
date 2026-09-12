/**
 * Renderer entry point: subscribe to the projected snapshot, render it, and
 * translate click handlers into `window.digitalHuman` commands.
 *
 * The preload bridge is the renderer's entire capability surface; nothing here
 * touches the filesystem, the network, or any other Electron API.
 *
 * One bundle drives two windows. The `?role=` query selects which subset a
 * window draws:
 *   - `role=avatar`: the avatar chip plus the pending-approval strip. Clicking
 *     either hands over to the panel window (`showPanel`).
 *   - `role=panel` (default): the first-run wizard while onboarding is pending,
 *     otherwise the panel body plus the full approval card. No avatar lives
 *     here — that is the other window's job.
 */
import { createAvatar } from './avatar.js';
import { createApprovalCard } from './approval.js';
import { createCompact } from './compact.js';
import { createPanel } from './panel.js';
import { createWizard } from './wizard.js';
import { getLanguage, t } from './locales.js';

/** `window.digitalHuman`, or `null` when the page runs outside Electron. */
export function bridgeOf() {
  const api = globalThis.digitalHuman;
  return api !== undefined && api !== null && typeof api === 'object' ? api : null;
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

/** Preload the seven faces so the first state switch is instant. */
function preloadFaces() {
  for (const face of ['offline', 'idle', 'thinking', 'working', 'waiting', 'error', 'done']) {
    const image = new Image();
    // Only the shipping size is preloaded: the lossless PNGs exist for review and
    // are several times larger.
    image.src = `../assets/avatar/states-app/${face}.webp`;
  }
}

/** Human-readable text for any thrown value. */
function messageOf(error) {
  if (error === null || error === undefined) return t('error.unknown');
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * Wrap a bridge method that may be missing from an older preload.
 * @returns the bound call, or `undefined` so the panel disables that control.
 */
function callable(api, name, call) {
  return typeof api[name] === 'function' ? call : undefined;
}

/** The window's role from `?role=`; anything but `avatar` is the panel. */
function role() {
  const value = new URLSearchParams(location.search).get('role');
  return value === 'avatar' ? 'avatar' : 'panel';
}

/** The "opened outside Electron" screen: informative, never a stack trace. */
function renderMissingBridge(root) {
  preloadFaces();
  const box = h(
    'div',
    { class: 'dh-root' },
    h(
      'div',
      { class: 'dh-panel dh-fatal', attrs: { role: 'alert' } },
      h('h1', { class: 'dh-fatal-title', text: t('error.bridgeMissing.title') }),
      h('p', { class: 'dh-fatal-body', text: t('error.bridgeMissing.body') }),
    ),
  );
  root.replaceChildren(box);
}

/** Wire the avatar-chip window: the avatar plus the pending-approval strip. */
function startAvatar(root, api, drag, errorBar, showError, wireListeners) {
  const avatar = createAvatar();
  const compact = createCompact({
    avatar: avatar.el,
    // The avatar no longer resizes anything: it just summons the panel window.
    onExpand: () => {
      if (typeof api.togglePanel === 'function') api.togglePanel();
      else if (typeof api.showPanel === 'function') api.showPanel();
    },
    onError: showError,
  });

  // No permanent handle on the chip: the drag grip only appears while the chip
  // is actually being moved, so the window stays visually just the avatar.
  const app = h('div', { class: 'dh-root' }, errorBar, compact.el);
  root.replaceChildren(app);

  /** Reflect the drag state, which the stylesheet turns into the grip cue. */
  const setDragging = (value) => {
    if (value) compact.el.dataset.dragging = 'true';
    else delete compact.el.dataset.dragging;
  };

  // Right-click anywhere in the chip opens the same menu the tray icon shows:
  // both are built from one template in the main process, so they cannot drift.
  app.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    // End any drag FIRST. The menu takes focus, and the pointerup that would
    // otherwise end the drag then never reaches this window, leaving the chip
    // glued to the cursor.
    if (dragging) finishPress();
    if (typeof api.showAvatarMenu === 'function') {
      Promise.resolve(api.showAvatarMenu()).catch(() => {
        /* a menu that will not open does not deserve an error banner */
      });
    }
  });

  // Click toggles the panel; holding and then moving drags the chip. A real
  // `-webkit-app-region: drag` cannot coexist with a clickable element — drag
  // regions stop delivering mouse events — so the drag asks the main process,
  // which owns the geometry, to move the window.
  //
  // The hold only *arms* the drag; the drag starts on the first move past the
  // tolerance. That keeps a slow click (press, pause, release, never moving) a
  // click, which is what lets the hold threshold be short enough to feel
  // responsive without stealing clicks.
  const LONG_PRESS_MS = 110;
  const MOVE_TOLERANCE = 8;
  let pressTimer = null;
  let pressStart = null;
  let dragArmed = false;
  let dragging = false;
  let suppressClick = false;
  let captureId = null;

  const finishPress = () => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (dragging) {
      dragging = false;
      setDragging(false);
      if (typeof api.endDrag === 'function') {
        Promise.resolve(api.endDrag()).catch(() => {
          /* a failed end leaves the window where it already is */
        });
      }
    }
    if (captureId !== null) {
      try {
        compact.button.releasePointerCapture(captureId);
      } catch {
        /* already released */
      }
      captureId = null;
    }
    dragArmed = false;
    pressStart = null;
  };

  /** Whether the pointer has left the tolerance box around the press point. */
  const hasMoved = (event) => pressStart !== null
    && (Math.abs(event.clientX - pressStart.x) > MOVE_TOLERANCE
      || Math.abs(event.clientY - pressStart.y) > MOVE_TOLERANCE);

  const onMove = (event) => {
    // While dragging, the main process follows the cursor itself.
    if (dragging) return;
    if (!hasMoved(event)) return;
    if (dragArmed) {
      dragging = true;
      suppressClick = true;
      // The grip cue appears for exactly as long as the chip is being moved.
      setDragging(true);
      if (typeof api.beginDrag === 'function') {
        Promise.resolve(api.beginDrag()).catch(() => {
          /* without the main process the chip simply does not move */
          dragging = false;
          setDragging(false);
        });
      }
      return;
    }
    // Moving before the hold completes is neither a click nor a drag: drop both.
    suppressClick = true;
    finishPress();
  };

  compact.button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Stops the browser from starting a native image drag or a text selection.
    event.preventDefault();
    pressStart = { x: event.clientX, y: event.clientY };
    dragArmed = false;
    dragging = false;
    suppressClick = false;
    captureId = event.pointerId;
    try {
      compact.button.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a robustness win, not a requirement */
    }
    pressTimer = setTimeout(() => {
      pressTimer = null;
      // Arming only: a press that never moves stays a click.
      dragArmed = true;
    }, LONG_PRESS_MS);
  });

  compact.button.addEventListener('pointermove', onMove);
  compact.button.addEventListener('pointerup', finishPress);
  // Deliberately NOT cancelled by `pointercancel`/`pointerleave`: a real press
  // makes Chromium fire those when it starts its own native drag, which killed
  // the hold before the long press could complete. The window-level pointerup,
  // the blur guard, and the movement check above still end the gesture.
  compact.button.addEventListener('pointercancel', () => {
    if (dragging) finishPress();
  });

  // Window-level fallbacks: once a drag is running the pointer may leave the
  // chip, and those moves still have to reach the main process.
  window.addEventListener('pointermove', (event) => {
    if (dragging) onMove(event);
  });
  window.addEventListener('pointerup', () => {
    if (dragging) finishPress();
  });
  window.addEventListener('blur', () => {
    if (dragging) finishPress();
  });

  // Capture phase: swallow the click that follows a completed drag, before the
  // chip's own handler can read it as "open the panel".
  compact.button.addEventListener('click', (event) => {
    if (suppressClick !== true) return;
    suppressClick = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }, true);


  /** Render one snapshot: the face and the approval strip are all this window shows. */
  function draw(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') return;
    avatar.update(snapshot.face);
    compact.update(snapshot);
  }

  wireListeners(draw);
}

/** Wire the panel window: the wizard while onboarding, otherwise the full panel. */
function startPanel(root, api, drag, errorBar, showError, wireListeners) {
  const approval = createApprovalCard({
    onDecide: (approvalId, decision) => api.decide(approvalId, decision),
    onError: showError,
  });
  const panel = createPanel({
    onSelect: (sessionId) => api.subscribeSession(sessionId),
    onDeselect: (sessionId) => api.unsubscribeSession(sessionId),
    onSend: (sessionId, text) => api.prompt(sessionId, text),
    onCancel: (sessionId) => api.cancel(sessionId),
    // A preload that predates a method leaves its control disabled rather than
    // failing at click time.
    onSelectModel: callable(api, 'selectModel', (sessionId, provider, model) => api.selectModel(sessionId, provider, model)),
    onRefreshModels: callable(api, 'refreshModels', () => api.refreshModels()),
    onCreateSession: callable(api, 'createSession', () => api.createSession()),
    onRename: callable(api, 'rename', (sessionId, title) => api.rename(sessionId, title)),
    onReconnect: () => api.reconnect(),
    onTogglePin: (value) => api.setAlwaysOnTop(value),
    // A preload without `setPanelOpacity` leaves the footer control disabled.
    onSetPanelOpacity: callable(api, 'setPanelOpacity', (value) => api.setPanelOpacity(value)),
    // Hiding the panel window, not the avatar chip.
    onHide: callable(api, 'hidePanel', () => api.hidePanel()),
    onError: showError,
  });
  const wizard = createWizard({
    api,
    // The finish command has already written the config and marked onboarding
    // done; swap to the panel view now instead of waiting for the next snapshot.
    onFinish: () => {
      showWizard = false;
      mountPanelView();
    },
    onError: showError,
  });

  /** Whether the latest snapshot asked for the first-run wizard. */
  let showWizard = false;
  /** The view currently mounted: `'wizard'`, `'panel'`, or `null`. */
  let mountedView = null;

  /**
   * Whether to render the wizard instead of the panel.
   *
   * A snapshot without `runtime` is an older main process: it has no wizard
   * state to read, so the panel stays, untouched.
   */
  function wantsWizard(snapshot) {
    const runtime = snapshot?.runtime;
    if (runtime === null || typeof runtime !== 'object') return false;
    return runtime.onboarded !== true;
  }

  /**
   * Mount the wizard or the panel.
   *
   * The drag strip and the error line stay mounted in both; the approval card
   * lives only in the panel view, alongside the panel body.
   */
  function mountPanelView() {
    const view = showWizard ? 'wizard' : 'panel';
    if (view === mountedView) return;
    if (view === 'wizard') {
      app.replaceChildren(drag, errorBar, wizard.el);
      wizard.show();
    } else {
      wizard.hide();
      app.replaceChildren(drag, errorBar, approval.el, panel.el);
    }
    mountedView = view;
  }

  // The panel has no collapse button anymore; the window's own close button (or
  // the footer 隐藏 button) hides it. The top strip is the drag handle.
  const app = h('div', { class: 'dh-root' }, drag, errorBar, approval.el, panel.el);
  root.replaceChildren(app);
  // One automatic selection per launch; after that the user owns the choice.
  let autoSelected = false;

  /** Render one snapshot. */
  function draw(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') return;
    // `showWizard` means "the wizard is the mounted view", which is what
    // mountPanelView() branches on.
    showWizard = wantsWizard(snapshot);
    mountPanelView();
    if (showWizard) {
      wizard.update(snapshot);
      return;
    }
    // Select a session on the first snapshot that has one: an empty activity feed
    // and a hidden composer make the app look broken on first launch.
    if (!autoSelected && Array.isArray(snapshot.sessions) && snapshot.sessions.length > 0) {
      autoSelected = true;
      // Subagent children are folded by default, so never auto-select one: a
      // selected row the user cannot see looks like a bug.
      const roots = snapshot.sessions.filter((session) => typeof session?.parentId !== 'string' || session.parentId === '');
      const pool = roots.length > 0 ? roots : snapshot.sessions;
      const preferred = pool.find((session) => session.running === true) ?? pool[0];
      try {
        panel.select(preferred.id);
      } catch (error) {
        showError(error);
      }
    }
    approval.update(snapshot);
    panel.update(snapshot);
  }

  /** Whether the wizard currently owns the keyboard. */
  function wizardOwnsKeys(node) {
    const view = wizard.el;
    if (view === null || view === undefined) return false;
    if (node === view) return true;
    return typeof view.contains === 'function' && view.contains(node) === true;
  }

  // A native dialog — a `<select>` popup, the `prompt()` from rename — owns the
  // keyboard while it is open: the app must not act on the key that dismisses it.
  function nativeDialogOpen() {
    return document.activeElement?.tagName === 'SELECT';
  }

  // `Ctrl+1..9` selects the Nth root session. The panel owns the session list, so
  // the binding lives there; this only covers focus outside the panel.
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (showWizard) return;
    if (event.altKey || !(event.ctrlKey || event.metaKey)) return;
    if (typeof event.key !== 'string' || !/^[1-9]$/u.test(event.key)) return;
    if (wizardOwnsKeys(event.target) || nativeDialogOpen()) return;
    panel.selectByShortcut(event, Number.parseInt(event.key, 10));
  });

  // Escape dismisses the panel (the avatar chip stays). The panel gets the first
  // say: a focused composer or `<select>` swallows the keypress (blur only)
  // instead of hiding the window under the user's cursor.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (showWizard) return;
    if (wizardOwnsKeys(event.target)) return;
    if (event.dhPanelHandled === true) return;
    if (panel.escapeHeldByFocus() === true) return;
    if (typeof api.hidePanel === 'function') api.hidePanel();
  });

  wireListeners(draw);
}

/** Wire the whole UI and start listening for snapshots. */
function start(root) {
  const api = bridgeOf();
  if (api === null) {
    renderMissingBridge(root);
    return;
  }

  preloadFaces();
  document.documentElement.lang = getLanguage();

  /** The dismissible error line under the top strip. */
  const errorText = h('span', { class: 'dh-error-text' });
  const errorClose = h('button', {
    class: 'dh-error-close',
    text: '×',
    attrs: { type: 'button', 'aria-label': t('error.dismiss') },
  });
  const errorBar = h(
    'div',
    { class: 'dh-error', attrs: { role: 'status', 'aria-live': 'polite', hidden: '' } },
    errorText,
    errorClose,
  );

  /** Surface any failure in the error line instead of an unhandled rejection. */
  function showError(error) {
    errorText.textContent = t('error.call', { message: messageOf(error) });
    errorBar.hidden = false;
  }

  errorClose.addEventListener('click', () => {
    errorBar.hidden = true;
  });

  /** The drag strip: every window keeps one movable grip at its top. */
  const drag = h('header', {
    class: 'dh-drag',
    attrs: { title: t('app.drag'), 'aria-hidden': 'true' },
  });

  const listen = (call) => {
    try {
      call();
    } catch (error) {
      showError(error);
    }
  };

  /** Subscribe and ask for the first snapshot, plus global error handling. */
  function wireListeners(draw) {
    listen(() => api.onSnapshot(draw));
    // The first snapshot may have been emitted before this module mounted.
    listen(() => api.requestSnapshot());

    window.addEventListener('error', (event) => {
      showError(event.error ?? event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      showError(event.reason);
      event.preventDefault();
    });

    // A window that becomes visible again may have missed snapshots while hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      Promise.resolve()
        .then(() => api.requestSnapshot())
        .catch(showError);
    });
  }

  if (role() === 'avatar') startAvatar(root, api, drag, errorBar, showError, wireListeners);
  else startPanel(root, api, drag, errorBar, showError, wireListeners);
}

/** Boot the renderer. */
export function boot() {
  const root = document.getElementById('app');
  if (root === null) return;
  start(root);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
