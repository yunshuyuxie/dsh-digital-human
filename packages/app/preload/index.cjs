/**
 * Preload bridge: the renderer's entire capability surface.
 *
 * Sandboxed renderers cannot use ESM, so this file is CommonJS by extension. It
 * exposes a fixed, named API — never `ipcRenderer` itself — so the renderer can
 * only do what the app intends.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Channel names owned by this app. */
const CHANNELS = {
  snapshot: 'dh:snapshot',
  command: 'dh:command',
};

/** Wrap a listener so callers get an unsubscribe function. */
function subscribe(channel, listener) {
  const wrapped = (_event, payload) => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('digitalHuman', {
  /** Subscribe to the projected snapshot; returns an unsubscribe function. */
  onSnapshot: (listener) => subscribe(CHANNELS.snapshot, listener),

  /** Request a fresh snapshot (the first one may have been sent before mount). */
  requestSnapshot: () => ipcRenderer.send(CHANNELS.command, { type: 'request-snapshot' }),

  /** Answer one held permission request. */
  decide: (approvalId, decision) => ipcRenderer.invoke(CHANNELS.command, { type: 'decide', approvalId, decision }),

  /** Send a text prompt to one session. */
  prompt: (sessionId, text) => ipcRenderer.invoke(CHANNELS.command, { type: 'prompt', sessionId, text }),

  /** Cancel the active turn of one session. */
  cancel: (sessionId) => ipcRenderer.invoke(CHANNELS.command, { type: 'cancel', sessionId }),

  /** Pick a model for one session from the deployment catalog. */
  selectModel: (sessionId, provider, model) => ipcRenderer.invoke(CHANNELS.command, { type: 'select-model', sessionId, provider, model }),

  /** Re-read the model catalog. */
  refreshModels: () => ipcRenderer.invoke(CHANNELS.command, { type: 'models' }),

  /** Rename one session. */
  rename: (sessionId, title) => ipcRenderer.invoke(CHANNELS.command, { type: 'rename', sessionId, title }),

  /** Create a session: opens a directory picker, then asks the bridge to create it. */
  createSession: () => ipcRenderer.invoke(CHANNELS.command, { type: 'create-session' }),

  /** First-run wizard: diagnose the machine, install the bridge, save preferences. */
  wizardState: () => ipcRenderer.invoke(CHANNELS.command, { type: 'wizard-state' }),
  wizardPickPackage: () => ipcRenderer.invoke(CHANNELS.command, { type: 'wizard-pick-package' }),
  wizardInstallBridge: (packagePath, profile) => ipcRenderer.invoke(CHANNELS.command, { type: 'wizard-install-bridge', packagePath, profile }),
  wizardFinish: (prefs) => ipcRenderer.invoke(CHANNELS.command, { type: 'wizard-finish', prefs }),
  wizardReopen: () => ipcRenderer.invoke(CHANNELS.command, { type: 'wizard-reopen' }),

  /** Follow (or stop following) one session's activity stream. */
  subscribeSession: (sessionId) => ipcRenderer.invoke(CHANNELS.command, { type: 'subscribe', sessionId }),
  unsubscribeSession: (sessionId) => ipcRenderer.invoke(CHANNELS.command, { type: 'unsubscribe', sessionId }),

  /** Retry the connection now instead of waiting for the backoff. */
  reconnect: () => ipcRenderer.invoke(CHANNELS.command, { type: 'reconnect' }),

  /** Window and app controls. */
  setAlwaysOnTop: (value) => ipcRenderer.invoke(CHANNELS.command, { type: 'always-on-top', value }),
  setPanelOpacity: (value) => ipcRenderer.invoke(CHANNELS.command, { type: 'set-panel-opacity', value }),
  setStartWithWindows: (value) => ipcRenderer.invoke(CHANNELS.command, { type: 'start-with-windows', value }),
  setNotify: (value) => ipcRenderer.invoke(CHANNELS.command, { type: 'notify', value }),
  /** Show and focus the function panel (the approval card lives there). */
  showPanel: () => ipcRenderer.invoke(CHANNELS.command, { type: 'show-panel' }),
  /** Hide the function panel without quitting. */
  hidePanel: () => ipcRenderer.invoke(CHANNELS.command, { type: 'hide-panel' }),
  /** Right-click menu for the avatar chip: the same items the tray shows. */
  showAvatarMenu: () => ipcRenderer.invoke(CHANNELS.command, { type: 'show-avatar-menu' }),
  /** Show the panel when hidden, hide it when shown. */
  togglePanel: () => ipcRenderer.invoke(CHANNELS.command, { type: 'toggle-panel' }),
  /** Long-press drag of the avatar chip, moved by the main process. */
  beginDrag: () => ipcRenderer.invoke(CHANNELS.command, { type: 'begin-drag' }),
  dragTo: (x, y) => ipcRenderer.invoke(CHANNELS.command, { type: 'drag-to', x, y }),
  endDrag: () => ipcRenderer.invoke(CHANNELS.command, { type: 'end-drag' }),
  /** Hide the avatar chip. */
  hide: () => ipcRenderer.invoke(CHANNELS.command, { type: 'hide' }),
  quit: () => ipcRenderer.invoke(CHANNELS.command, { type: 'quit' }),
});
