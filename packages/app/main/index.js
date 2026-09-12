/**
 * Electron entry point for the digital-human desktop pet.
 *
 * Owns two windows — a small always-on-top avatar chip and a resizable function
 * panel — plus the tray, the config file, and the wire between the bridge client
 * and the renderers. Both windows share one connection, one state store, and one
 * snapshot stream; each renders only its own subset. Closing a window hides it;
 * only the tray (or the app menu's quit) exits, which is what a desktop pet
 * should do.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, Notification, app, dialog, globalShortcut, ipcMain, screen } from 'electron';
import { createBridgeClient } from './connection.js';
import { createConfigStore } from './config.js';
import { diagnose, installBridge } from './onboarding.js';
import { createStateStore } from './state.js';
import { buildMenuTemplate, createTray } from './tray.js';
import { METHODS } from '../src/vendor/protocol/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

/** Window geometry. */
const AVATAR = { width: 200, height: 220 };
const PANEL = { width: 400, height: 640 };
const PANEL_MIN = { width: 300, height: 320 };
/** Distance from the screen edge, and between the stacked windows. */
const MARGIN = 24;

/**
 * System-wide toggle for the function panel.
 *
 * Registered globally rather than as a window accelerator so the panel can be
 * summoned while another application has focus — which is the whole point of a
 * companion pet.
 */
const PANEL_SHORTCUT = 'CommandOrControl+Alt+D';
const GAP = 12;

/** Windows needs an explicit app id before notifications display at all. */
const APP_USER_MODEL_ID = 'com.deepseek.dsh.digital-human';

/** Whether this launch came from the login item rather than the user. */
const startHidden = process.argv.includes('--hidden');

// A pet that dies silently is undiagnosable: everything that can end this
// process leaves a line on stderr, which is also what the launcher captures.
process.on('uncaughtException', (error) => {
  console.error('[digital-human] uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[digital-human] unhandled rejection:', reason);
});

/** Snapshot push cadence, so approval countdowns tick without a renderer timer. */
const SNAPSHOT_INTERVAL_MS = 1000;

let avatarWindow;
let panelWindow;
/** Where the current chip drag started, in cursor and window coordinates. */
let dragOrigin = null;

/** Polling handle for the chip drag; the window follows the cursor. */
let chipDragTimer = null;

/**
 * Clamp a window's top-left so the whole window stays on a display.
 *
 * The display under the cursor wins, which is what lets the chip be carried to a
 * second monitor while still never crossing that monitor's edges. A window larger
 * than the work area is pinned to its top-left rather than pushed off it.
 *
 * @param desired - the wanted top-left plus the window size.
 * @param point - the point that selects the display (the cursor).
 * @returns the clamped top-left.
 */
function clampToDisplay(desired, point) {
  const area = screen.getDisplayNearestPoint(point).workArea;
  const width = Math.min(desired.width, area.width);
  const height = Math.min(desired.height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(desired.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(desired.y, area.y + area.height - height))),
  };
}

/** Whether a stored position still lands on some connected display. */
function isOnSomeDisplay(position, size) {
  if (position === null || position === undefined) return false;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    // Require a grabbable slice to be visible, not just a one-pixel sliver.
    const visibleX = Math.min(position.x + size.width, area.x + area.width) - Math.max(position.x, area.x);
    const visibleY = Math.min(position.y + size.height, area.y + area.height) - Math.max(position.y, area.y);
    return visibleX >= 60 && visibleY >= 60;
  });
}

/**
 * Follow the cursor until the drag ends.
 *
 * The renderer only signals start and end: tracking the cursor here means the
 * window keeps following even when the pointer leaves the chip or the renderer
 * stops receiving move events, which is what made the event-driven version stall.
 */
function startChipDrag() {
  stopChipDrag();
  if (avatarWindow === undefined || avatarWindow.isDestroyed()) return;
  dragOrigin = { cursor: screen.getCursorScreenPoint(), bounds: avatarWindow.getBounds() };
  chipDragTimer = setInterval(() => {
    if (dragOrigin === null || avatarWindow === undefined || avatarWindow.isDestroyed()) {
      stopChipDrag();
      return;
    }
    const now = screen.getCursorScreenPoint();
    const dx = now.x - dragOrigin.cursor.x;
    const dy = now.y - dragOrigin.cursor.y;
    if (dx === 0 && dy === 0) return;
    // Clamp every move, so the chip can never be parked off the desktop.
    const next = clampToDisplay({
      x: dragOrigin.bounds.x + dx,
      y: dragOrigin.bounds.y + dy,
      width: dragOrigin.bounds.width,
      height: dragOrigin.bounds.height,
    }, now);
    avatarWindow.setPosition(next.x, next.y);
  }, 16);
  chipDragTimer.unref?.();
}

/** Stop following the cursor. */
function stopChipDrag() {
  if (chipDragTimer !== null) {
    clearInterval(chipDragTimer);
    chipDragTimer = null;
  }
  dragOrigin = null;
}
let tray;
/** The shared menu options, so the avatar's right-click can reuse them. */
let menuOptionsRef = null;
/** The open avatar menu, held until it closes so it is never collected early. */
let openMenu = null;
let client;
let store;
let configStore;
let subscriptions = new Set();
let pushTimer;
let pendingPush;
/** Approval ids already announced, so one request notifies once. */
const announcedApprovals = new Set();

/** The two live windows, for snapshot fan-out. */
function windows() {
  return [avatarWindow, panelWindow];
}

/**
 * Announce newly arrived permission requests.
 *
 * A pending approval is the only state that blocks the agent until a human acts,
 * so it is the one thing worth interrupting the desktop for. Notifications are
 * click-to-reveal and never steal focus; the click opens the panel, which is
 * where the approval card lives.
 */
function announceApprovals(snapshot) {
  if (configStore.read().notifyOnApproval !== true) return;
  const current = new Set();
  for (const card of snapshot.approvals) {
    current.add(card.approvalId);
    if (announcedApprovals.has(card.approvalId)) continue;
    announcedApprovals.add(card.approvalId);
    if (Notification.isSupported() !== true) return;
    const body = [card.toolName, card.reason].filter((part) => typeof part === 'string' && part !== '').join(' · ');
    const notification = new Notification({
      title: snapshot.approvals.length > 1 ? `数字人 · ${String(snapshot.approvals.length)} 项权限请求` : '数字人 · 权限请求',
      body: body === '' ? '有一项操作需要你确认' : body,
      silent: configStore.read().notifySound !== true,
      urgency: 'critical',
    });
    notification.on('click', () => {
      showPanel();
    });
    notification.show();
  }
  // Forget settled ids so a re-issued request under the same id notifies again.
  for (const id of [...announcedApprovals]) if (!current.has(id)) announcedApprovals.delete(id);
}

/**
 * Keep Windows' login item in step with the stored preference.
 *
 * Runs at every launch, not only when the toggle changes, so moving the install
 * directory repairs the registration instead of leaving a dead entry.
 */
function syncLoginItem() {
  const wanted = configStore.read().startWithWindows === true;
  const current = app.getLoginItemSettings();
  if (current.openAtLogin === wanted) return;
  app.setLoginItemSettings({
    openAtLogin: wanted,
    path: process.execPath,
    args: ['--hidden'],
  });
}

/** Send the current snapshot to every listening renderer. */
function push() {
  const snapshot = store.snapshot();
  announceApprovals(snapshot);
  for (const win of windows()) {
    if (win !== undefined && !win.isDestroyed()) win.webContents.send('dh:snapshot', snapshot);
  }
}

/** Coalesce pushes inside one tick so a burst of frames renders once. */
function schedulePush() {
  if (pendingPush !== undefined) return;
  pendingPush = setTimeout(() => {
    pendingPush = undefined;
    push();
  }, 16);
}

/** Whether a position field is usable. */
function hasPoint(saved) {
  return saved !== null && saved !== undefined && Number.isFinite(saved?.x) && Number.isFinite(saved?.y);
}

/** The avatar chip opens bottom-right, or wherever the user parked it. */
function avatarPosition() {
  const saved = configStore.read().avatarWindow;
  // A position saved on a monitor that is no longer attached would park the chip
  // somewhere unreachable, so it is only honoured while it still lands on screen.
  if (hasPoint(saved) && isOnSomeDisplay(saved, AVATAR)) return { x: saved.x, y: saved.y };
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - AVATAR.width - MARGIN,
    y: area.y + area.height - AVATAR.height - MARGIN,
  };
}

/** The panel opens bottom-right, stacked above the avatar, or restored. */
function panelBounds() {
  const saved = configStore.read().panelWindow;
  const width = Number.isFinite(saved?.width) ? Math.max(PANEL_MIN.width, saved.width) : PANEL.width;
  const height = Number.isFinite(saved?.height) ? Math.max(PANEL_MIN.height, saved.height) : PANEL.height;
  // Same guard as the chip: a panel restored onto a detached monitor would be
  // invisible and unreachable.
  if (hasPoint(saved) && isOnSomeDisplay(saved, { width, height })) return { x: saved.x, y: saved.y, width, height };
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - width - MARGIN,
    y: area.y + area.height - height - AVATAR.height - MARGIN - GAP,
    width,
    height,
  };
}

/** Shared `webPreferences` for both sandboxed, isolated renderers. */
function webPreferences() {
  return {
    preload: join(appRoot, 'preload', 'index.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
}

/** Surface renderer failures on stderr, for a window with no chrome. */
function wireDiagnostics(win) {
  // Electron >=31 delivers a details object; older releases used positional
  // arguments. Handle both so renderer logs never go missing.
  win.webContents.on('console-message', (_event, ...args) => {
    const details = args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? args[0] : null;
    const level = details !== null ? details.level : args[0];
    const message = details !== null ? details.message : args[1];
    const line = details !== null ? details.lineNumber : args[2];
    const source = details !== null ? details.sourceId : args[3];
    console.error(`[digital-human] renderer: ${message} (${source}:${String(line)})`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error(`[digital-human] renderer failed to load ${url}: ${errorDescription} (${String(errorCode)})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[digital-human] renderer process gone: ${details.reason}`);
  });
}

/** Create the fixed, always-on-top avatar chip. */
function createAvatarWindow() {
  const position = avatarPosition();
  avatarWindow = new BrowserWindow({
    width: AVATAR.width,
    height: AVATAR.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: configStore.read().alwaysOnTop === true,
    show: false,
    icon: join(appRoot, 'assets', 'icon.png'),
    webPreferences: webPreferences(),
  });

  wireDiagnostics(avatarWindow);
  avatarWindow.loadFile(join(appRoot, 'renderer', 'index.html'), { query: { role: 'avatar' } }).catch((error) => {
    console.error('[digital-human] could not load the renderer:', error);
  });
  avatarWindow.once('ready-to-show', () => {
    if (startHidden !== true) showAvatar();
    push();
  });
  // The chip keeps its fixed size, so only x/y are stored.
  avatarWindow.on('moved', () => {
    if (avatarWindow === undefined || avatarWindow.isDestroyed()) return;
    const bounds = avatarWindow.getBounds();
    configStore.write({ avatarWindow: { x: bounds.x, y: bounds.y } });
  });
  // A pet window never really closes: hiding keeps the connection alive.
  avatarWindow.on('close', (event) => {
    if (app.isQuitting === true) return;
    event.preventDefault();
    avatarWindow.hide();
  });
}

/** Create the resizable function panel. */
function createPanelWindow() {
  const bounds = panelBounds();
  panelWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: PANEL_MIN.width,
    minHeight: PANEL_MIN.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    show: false,
    icon: join(appRoot, 'assets', 'icon.png'),
    webPreferences: webPreferences(),
  });

  wireDiagnostics(panelWindow);
  panelWindow.loadFile(join(appRoot, 'renderer', 'index.html'), { query: { role: 'panel' } }).catch((error) => {
    console.error('[digital-human] could not load the renderer:', error);
  });
  panelWindow.once('ready-to-show', () => {
    // The first-run wizard must be visible; an onboarded panel waits for a click.
    if (startHidden !== true && configStore.read().onboarded !== true) showPanel();
    push();
  });
  // The panel remembers its own position and the size the user dragged it to.
  const saveBounds = () => {
    if (panelWindow === undefined || panelWindow.isDestroyed()) return;
    const b = panelWindow.getBounds();
    configStore.write({ panelWindow: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };
  panelWindow.on('moved', saveBounds);
  panelWindow.on('resized', saveBounds);
  // Closing the panel hides it; the app and the connection stay alive.
  panelWindow.on('close', (event) => {
    if (app.isQuitting === true) return;
    event.preventDefault();
    panelWindow.hide();
  });
}

/** Show and focus the panel window (the function window). */
function showPanel() {
  if (panelWindow === undefined || panelWindow.isDestroyed()) return;
  if (panelWindow.isMinimized()) panelWindow.restore();
  panelWindow.show();
  panelWindow.focus();
}

/** Hide the panel window without quitting. */
function hidePanel() {
  if (panelWindow === undefined || panelWindow.isDestroyed()) return;
  panelWindow.hide();
}

/** Show the avatar chip. */
function showAvatar() {
  if (avatarWindow === undefined || avatarWindow.isDestroyed()) return;
  avatarWindow.show();
}

/** Hide the avatar chip (the pending-approval strip stays for when it returns). */
function hideAvatar() {
  if (avatarWindow === undefined || avatarWindow.isDestroyed()) return;
  avatarWindow.hide();
}

/** Toggle the panel's visibility. */
/** Claim the global panel shortcut, reporting a conflict instead of failing quietly. */
function registerPanelShortcut() {
  globalShortcut.unregisterAll();
  let registered = false;
  try {
    registered = globalShortcut.register(PANEL_SHORTCUT, () => {
      togglePanel();
    });
  } catch (error) {
    console.error(`[digital-human] shortcut ${PANEL_SHORTCUT} threw: ${String(error)}`);
  }
  if (registered) console.error(`[digital-human] shortcut ${PANEL_SHORTCUT} registered (toggle panel)`);
  else console.error(`[digital-human] shortcut ${PANEL_SHORTCUT} is taken by another application; use the tray menu instead`);
}

function togglePanel() {
  if (panelWindow === undefined || panelWindow.isDestroyed()) return;
  if (panelWindow.isVisible()) hidePanel();
  else showPanel();
}

/** Toggle the avatar chip's visibility. */
function toggleAvatar() {
  if (avatarWindow === undefined || avatarWindow.isDestroyed()) return;
  if (avatarWindow.isVisible()) hideAvatar();
  else showAvatar();
}

/** The panel window as a dialog parent, or none when it is gone. */
function dialogParent() {
  return panelWindow !== undefined && !panelWindow.isDestroyed() ? panelWindow : undefined;
}

/**
 * Open a native dialog, parented on the panel window when it is alive.
 *
 * Electron's dialog overloads distinguish "with a window" from "without", so a
 * missing parent must omit the argument rather than pass `undefined`.
 */
function showOpenDialog(options) {
  const parent = dialogParent();
  return parent === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options);
}

/** Re-send subscriptions the bridge lost with the old connection. */
async function resubscribe() {
  for (const sessionId of subscriptions) {
    try {
      await client.call(METHODS.SESSION_SUBSCRIBE, { sessionId });
    } catch (error) {
      console.error(`[digital-human] could not resubscribe to ${sessionId}:`, error.message);
    }
  }
}

/**
 * Load the model catalog, tolerating a bridge that predates the method.
 *
 * A running bridge is only replaced on a harness restart, so an app and a bridge
 * of different vintages coexist by design: an older one answers
 * `method-not-found`, which the UI reports as "this bridge is too old for model
 * selection" instead of an error.
 */
async function loadModels() {
  try {
    const catalog = await client.call(METHODS.SESSIONS_MODELS);
    store.setModels(catalog);
    return catalog;
  } catch (error) {
    if (error?.code === 'method-not-found') {
      store.setModels(null);
      console.error('[digital-human] the bridge does not serve sessions.models; restart dsh to activate the installed bridge');
      return null;
    }
    console.error(`[digital-human] could not read the model catalog: ${error.message}`);
    return null;
  }
}

/** Handle one renderer command. */
async function handleCommand(command) {
  switch (command?.type) {
    case 'request-snapshot':
      push();
      return { ok: true };
    case 'decide':
      return { ok: true, value: await client.call(METHODS.APPROVAL_DECIDE, { approvalId: command.approvalId, decision: command.decision }) };
    case 'prompt': {
      const text = typeof command.text === 'string' ? command.text.trim() : '';
      if (text === '') throw new Error('提示词不能为空');
      return { ok: true, value: await client.call(METHODS.COMMAND_PROMPT, {
        sessionId: command.sessionId,
        requestId: randomUUID(),
        content: [{ type: 'text', text }],
      }) };
    }
    case 'cancel':
      return { ok: true, value: await client.call(METHODS.COMMAND_CANCEL, { sessionId: command.sessionId }) };
    case 'select-model':
      return {
        ok: true,
        value: await client.call(METHODS.COMMAND_SELECT_MODEL, {
          sessionId: command.sessionId,
          provider: command.provider,
          model: command.model,
        }),
      };
    case 'models': {
      const catalog = await loadModels();
      return { ok: true, value: catalog, unsupported: catalog === null };
    }
    case 'rename': {
      const title = typeof command.title === 'string' ? command.title.trim() : '';
      if (title === '') throw new Error('标题不能为空');
      return { ok: true, value: await client.call(METHODS.SESSION_RENAME, { sessionId: command.sessionId, title }) };
    }
    case 'wizard-state':
      return { ok: true, value: await diagnose({ dshHome: configStore.read().dshHome, profile: configStore.read().activeProfile }) };
    case 'wizard-pick-package': {
      const pickedFile = await showOpenDialog({
        title: '选择桥接离线安装包（.zip 或已解压的目录）',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: '桥接离线包', extensions: ['zip'] }],
      });
      return { ok: true, value: pickedFile.canceled || pickedFile.filePaths.length === 0 ? null : { path: pickedFile.filePaths[0] } };
    }
    case 'wizard-install-bridge': {
      const result = await installBridge({
        packagePath: command.packagePath,
        profile: command.profile,
        dshHome: configStore.read().dshHome,
        // Keep extracted packages under the app's own data directory: the
        // installed profile links at this path, so a temp dir would leave a
        // dangling junction behind.
        extractRoot: join(app.getPath('userData'), 'bridge-packages'),
        onOutput: (text, level) => {
          console.error(`[digital-human] install: ${text}`);
          if (panelWindow !== undefined && !panelWindow.isDestroyed()) {
            panelWindow.webContents.send('dh:snapshot', { ...store.snapshot(), installOutput: { level, text } });
          }
        },
      });
      return { ok: true, value: result };
    }
    case 'wizard-finish': {
      const prefs = command.prefs ?? {};
      configStore.write({
        alwaysOnTop: prefs.alwaysOnTop === true,
        startWithWindows: prefs.startWithWindows === true,
        notifyOnApproval: prefs.notifyOnApproval === true,
        onboarded: true,
      });
      if (avatarWindow !== undefined && !avatarWindow.isDestroyed()) {
        avatarWindow.setAlwaysOnTop(prefs.alwaysOnTop === true);
      }
      syncLoginItem();
      tray?.refresh();
      client.reconnect();
      push();
      return { ok: true, value: store.snapshot() };
    }
    case 'wizard-reopen': {
      configStore.write({ onboarded: false });
      showPanel();
      push();
      return { ok: true };
    }
    case 'create-session': {
      const picked = await showOpenDialog({
        title: '选择新会话的工作目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: null };
      const cwd = picked.filePaths[0];
      const created = await client.call(METHODS.COMMAND_CREATE, { cwd });
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
      // Follow the session the user just created, so its activity is live.
      if (sessionId !== '') {
        subscriptions.add(sessionId);
        try {
          await client.call(METHODS.SESSION_SUBSCRIBE, { sessionId });
        } catch (error) {
          console.error(`[digital-human] could not subscribe to the new session: ${error.message}`);
        }
      }
      return { ok: true, value: { sessionId, cwd } };
    }
    case 'subscribe': {
      subscriptions.add(command.sessionId);
      return { ok: true, value: await client.call(METHODS.SESSION_SUBSCRIBE, { sessionId: command.sessionId }) };
    }
    case 'unsubscribe': {
      subscriptions.delete(command.sessionId);
      return { ok: true, value: await client.call(METHODS.SESSION_UNSUBSCRIBE, { sessionId: command.sessionId }) };
    }
    case 'reconnect': {
      subscriptions = new Set();
      client.reconnect();
      return { ok: true };
    }
    case 'always-on-top': {
      configStore.write({ alwaysOnTop: command.value === true });
      if (avatarWindow !== undefined && !avatarWindow.isDestroyed()) {
        avatarWindow.setAlwaysOnTop(command.value === true);
      }
      tray?.refresh();
      schedulePush();
      return { ok: true };
    }
    case 'set-panel-opacity': {
      // Only the three offered values, so a bad caller cannot make the panel vanish.
      const allowed = [0.85, 0.92, 1];
      const value = allowed.includes(Number(command.value)) ? Number(command.value) : 0.92;
      configStore.write({ panelOpacity: value });
      push();
      return { ok: true };
    }
    case 'show-panel':
      showPanel();
      return { ok: true };
    case 'hide-panel':
      hidePanel();
      return { ok: true };
    case 'show-avatar-menu': {
      // The avatar's right-click shows exactly the tray menu.
      if (menuOptionsRef === null) return { ok: false };
      // A drag must never keep running behind the menu: the menu takes focus and
      // the release that would end the drag never reaches the renderer.
      stopChipDrag();
      const template = buildMenuTemplate(menuOptionsRef, store.snapshot().counts.approvals);
      // Held until the menu closes: a collected menu misbehaves.
      openMenu = Menu.buildFromTemplate(template);
      openMenu.popup({
        window: avatarWindow !== undefined && !avatarWindow.isDestroyed() ? avatarWindow : undefined,
        callback: () => {
          openMenu = null;
          stopChipDrag();
        },
      });
      return { ok: true };
    }
    case 'toggle-panel':
      togglePanel();
      return { ok: true };
    case 'begin-drag':
      startChipDrag();
      return { ok: true };
    case 'drag-to':
      // Superseded by cursor polling in the main process; kept so an older
      // renderer cannot break.
      return { ok: true };
    case 'end-drag':
      stopChipDrag();
      return { ok: true };
    case 'start-with-windows': {
      configStore.write({ startWithWindows: command.value === true });
      syncLoginItem();
      tray?.refresh();
      schedulePush();
      return { ok: true };
    }
    case 'notify': {
      configStore.write({ notifyOnApproval: command.value === true });
      tray?.refresh();
      schedulePush();
      return { ok: true };
    }
    case 'hide':
      hideAvatar();
      return { ok: true };
    case 'quit':
      app.isQuitting = true;
      app.quit();
      return { ok: true };
    default: {
      const error = new Error(`unknown command ${JSON.stringify(command?.type ?? null)}`);
      error.code = 'unknown-command';
      throw error;
    }
  }
}

/** Start everything. */
function start() {
  configStore = createConfigStore({ dir: app.getPath('userData') });
  app.setAppUserModelId(APP_USER_MODEL_ID);
  syncLoginItem();
  store = createStateStore({
    onChange: schedulePush,
    extras: () => ({
      alwaysOnTop: configStore.read().alwaysOnTop === true,
      startWithWindows: configStore.read().startWithWindows === true,
      notifyOnApproval: configStore.read().notifyOnApproval === true,
      onboarded: configStore.read().onboarded === true,
      panelOpacity: configStore.read().panelOpacity ?? 0.92,
    }),
  });
  client = createBridgeClient({
    dshHome: configStore.read().dshHome,
    profile: configStore.read().activeProfile,
    onEvent: (frame) => {
      store.applyEvent(frame);
    },
    onStatus: (status) => {
      const wasConnected = store.snapshot().status.phase === 'connected';
      store.applyStatus(status);
      // A flapping connection is otherwise invisible: the window just looks
      // stale, so every transition is written down.
      console.error(`[digital-human] status ${status.phase}${typeof status.detail?.code === 'string' ? ` (${status.detail.code})` : ''}`);
      tray?.setTooltip(status.phase === 'connected'
        ? `数字人 · 已连接 ${status.peer?.host ?? ''} (${status.peer?.profile ?? ''})`
        : `数字人 · ${status.phase}${status.detail === undefined ? '' : ` — ${status.detail}`}`);
      if (status.phase === 'connected' && !wasConnected) {
        void resubscribe();
        void loadModels();
      }
      schedulePush();
    },
    log: (message) => {
      console.error(`[digital-human] ${message}`);
    },
  });

  createAvatarWindow();
  createPanelWindow();
  // One options object, two entry points: the tray icon and the avatar's
  // right-click show the very same menu, so they cannot drift apart.
  const menuOptions = {
    iconPath: join(appRoot, 'assets', 'tray.png'),
    panelShortcut: PANEL_SHORTCUT,
    onTogglePanel: togglePanel,
    onToggleAvatar: toggleAvatar,
    onReconnect: () => {
      subscriptions = new Set();
      client.reconnect();
    },
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
    onAlwaysOnTop: (value) => {
      configStore.write({ alwaysOnTop: value });
      if (avatarWindow !== undefined && !avatarWindow.isDestroyed()) {
        avatarWindow.setAlwaysOnTop(value);
      }
      schedulePush();
    },
    isAlwaysOnTop: () => configStore.read().alwaysOnTop === true,
    onNotify: (value) => {
      configStore.write({ notifyOnApproval: value });
      schedulePush();
    },
    isNotify: () => configStore.read().notifyOnApproval === true,
    onStartWithWindows: (value) => {
      configStore.write({ startWithWindows: value });
      syncLoginItem();
      schedulePush();
    },
    isStartWithWindows: () => configStore.read().startWithWindows === true,
  };
  menuOptionsRef = menuOptions;
  tray = createTray(menuOptions);
  registerPanelShortcut();

  ipcMain.handle('dh:command', async (_event, command) => handleCommand(command));
  ipcMain.on('dh:command', (_event, command) => {
    if (command?.type === 'request-snapshot') push();
  });

  pushTimer = setInterval(() => {
    push();
    const pending = store.snapshot().counts.approvals;
    tray?.setPending(pending);
  }, SNAPSHOT_INTERVAL_MS);
  pushTimer.unref?.();

  client.start();
}

// A second launch focuses the existing pet instead of starting another one.
if (app.requestSingleInstanceLock() !== true) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPanel();
  });
  app.on('window-all-closed', () => {
    /* the tray keeps the app alive */
  });
  app.on('before-quit', () => {
    app.isQuitting = true;
    console.error('[digital-human] shutting down');
    if (pushTimer !== undefined) clearInterval(pushTimer);
    globalShortcut.unregisterAll();
    client?.stop();
    tray?.destroy();
  });
  app.on('quit', (_event, exitCode) => {
    console.error(`[digital-human] quit (exit ${String(exitCode)})`);
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    start();
    console.error('[digital-human] started');
  });
}
