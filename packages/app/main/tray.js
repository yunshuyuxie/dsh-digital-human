/**
 * Tray icon and its menu: the app's always-available entry point.
 *
 * Closing a window hides it; only the tray menu (or Cmd/Ctrl+Q) quits, which is
 * what a desktop pet should do.
 */
import { Menu, Tray, nativeImage } from 'electron';

/**
 * Build the one menu both entry points show.
 *
 * The tray icon and the avatar's right-click must never drift apart, so the
 * template is built here and used by both.
 *
 * @param options - the same callbacks the tray takes.
 * @param pending - how many approvals await a decision.
 * @returns a `Menu.buildFromTemplate` template.
 */
export function buildMenuTemplate(options, pending) {
  return [
    { label: pending > 0 ? `数字人 · ${String(pending)} 项待确认` : '数字人', enabled: false },
    { type: 'separator' },
    {
      label: '显示/隐藏面板',
      // Display only: the shortcut itself is a global registration in the main
      // process, so it also works while another app has focus.
      accelerator: options.panelShortcut,
      click: () => { options.onTogglePanel(); },
    },
    { label: '显示/隐藏化身', click: () => { options.onToggleAvatar(); } },
    { label: '重新连接', click: () => { options.onReconnect(); } },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: options.isAlwaysOnTop(),
      click: (item) => { options.onAlwaysOnTop(item.checked); },
    },
    {
      label: '权限请求时通知',
      type: 'checkbox',
      checked: options.isNotify(),
      click: (item) => { options.onNotify(item.checked); },
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: options.isStartWithWindows(),
      click: (item) => { options.onStartWithWindows(item.checked); },
    },
    { type: 'separator' },
    { label: '退出', click: () => { options.onQuit(); } },
  ];
}

/**
 * Create the tray.
 * @param options - callbacks and the icon path.
 * @returns `{ tray, setTooltip, setPending, destroy }`.
 */
export function createTray(options) {
  const image = nativeImage.createFromPath(options.iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  let pending = 0;

  /** Rebuild the menu from current state. */
  function refresh() {
    tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(options, pending)));
  }

  tray.setToolTip('数字人 · 任务监控与权限确认');
  tray.on('click', () => {
    options.onTogglePanel();
  });
  refresh();

  return {
    tray,
    setTooltip: (text) => {
      tray.setToolTip(text);
    },
    setPending: (count) => {
      pending = count;
      refresh();
    },
    refresh,
    destroy: () => {
      tray.destroy();
    },
  };
}
