/**
 * Renderer dictionaries.
 *
 * Simplified Chinese is the key-set source of truth; `en` must stay
 * key-identical. Values may carry `{name}` placeholders filled by `format()`.
 */

/** Simplified Chinese dictionary (key-set source of truth). */
export const zh = {
  'app.name': '数字人',
  'app.drag': '按住此处拖动窗口',

  'view.compact.title': '紧凑视图：只显示化身',
  'view.compact.expand': '展开为完整面板',
  'view.expanded.collapse': '收起为紧凑视图',
  'view.compact.pending': '待确认 {count}',
  'view.compact.process': '处理',

  'status.connected': '{host} · {profile} · 桥接 {bridge}',
  'status.phase.searching': '正在寻找端点文件…',
  'status.phase.connecting': '正在连接桥接…',
  'status.phase.disconnected': '桥接连接已断开',
  'status.phase.offline': '未连接',
  'status.phase.error': '发生错误',
  'status.retry': '重试',
  'status.retrying': '正在重试…',
  'status.noDetail': '没有更多信息',
  'status.code.no-endpoint': '未找到端点文件 —— dsh 是否在运行、桥接插件是否已安装？',
  'status.code.no-token': 'profile {profile} 没有记录令牌',
  'status.code.connecting': '正在连接 {path}',
  'status.code.protocol-mismatch': '协议版本不匹配：桥接 {bridge}，App {app}',
  'status.code.bad-proof': '桥接未能证明它持有本机令牌',
  'status.code.closed': '桥接连接已断开',

  'face.offline': '离线',
  'face.idle': '空闲',
  'face.thinking': '思考中',
  'face.working': '工作中',
  'face.waiting': '等待确认',
  'face.error': '出错',
  'face.done': '已完成',

  'avatar.label.offline': '化身：未连接，离线状态',
  'avatar.label.idle': '化身：已连接，空闲待命',
  'avatar.label.thinking': '化身：正在思考',
  'avatar.label.working': '化身：正在执行任务',
  'avatar.label.waiting': '化身：有权限请求等待确认',
  'avatar.label.error': '化身：出错了',
  'avatar.label.done': '化身：任务已完成',

  'approval.title': '权限确认',
  'approval.tool': '工具',
  'approval.reason': '原因',
  'approval.args': '参数',
  'approval.countdown': '剩余 {seconds} 秒',
  'approval.noDeadline': '无超时',
  'approval.allow': '允许一次',
  'approval.reject': '拒绝',
  'approval.more': '还有 {count} 项待确认',
  'approval.pending': '已提交，等待处理…',

  'panel.sessions': '会话',
  'panel.noSessions': '暂无会话',
  'panel.activity': '活动',
  'panel.noActivity': '暂无活动',
  'panel.selectHint': '选择一个会话查看活动',
  // P2-7: the two-state scope switch in the activity header, the pinned group,
  // and the per-row session prefix of the all-sessions view.
  'activity.scope.current': '当前会话',
  'activity.scope.all': '全部会话',
  'activity.modeAll': '全部会话',
  'activity.noActivity': '所有会话都还没有活动',
  'activity.pinned': '需要处理',
  'activity.recent': '最近 {session}',
  'activity.rowTitle': '{session} · {kind}',

  'activity.toolCall': '工具调用',
  'activity.toolResult': '工具结果',
  'activity.turnStart': '轮次开始',
  'activity.turnEnd': '轮次结束',
  'activity.assistantMessage': '回复',
  'activity.agentError': '代理错误',
  'activity.text': '文本',
  'activity.unknown': '活动',

  'session.running': '运行中',
  'session.idle': '空闲',
  'session.error': '出错',
  'session.jobs': '后台 {count}',
  'session.tools': '工具 {count}',
  'session.children': '子会话 {count}',
  'session.childrenHide': '隐藏子会话',
  'session.childrenHead': '子会话',
  'session.childChip': '子',
  'session.create': '新建会话',
  'session.created': '已新建并选中该会话',
  'session.createCancelled': '已取消新建会话',
  'session.rename': '重命名',
  'session.renamePrompt': '输入新的会话标题',
  'session.renameUnavailable': '当前环境不支持输入标题',
  'session.renamed': '已重命名',

  'model.select': '选择模型',
  'model.unsupported': '桥接插件版本较旧，重启 dsh 后可选模型',
  'model.empty': '没有可用模型',
  'model.unset': '未设置',
  'model.refresh': '刷新',
  'model.refreshed': '已请求刷新模型列表',
  'model.selected': '已选择 {model}',

  'time.justNow': '刚刚',
  'time.seconds': '{count} 秒前',
  'time.minutes': '{count} 分前',
  'time.hours': '{count} 小时前',

  'composer.placeholder': '输入要发送给该会话的指令…',
  'composer.send': '发送',
  'composer.cancel': '取消当前轮次',
  'composer.sent': '已发送',
  'composer.cancelled': '已请求取消当前轮次',
  'composer.noSession': '先选择一个会话',

  'footer.counts': '会话 {sessions} · 运行中 {running} · 后台任务 {jobs}',
  'footer.pin': '置顶',
  'footer.unpin': '取消置顶',
  'footer.hide': '隐藏',
  'footer.opacity.label': '面板不透明度',
  'footer.opacity.dim': '半透明',
  'footer.opacity.default': '标准',
  'footer.opacity.solid': '不透明',
  'footer.opacity.unavailable': '当前版本不支持调整不透明度：请更新桌面应用。',

  'error.dismiss': '关闭错误提示',
  'error.bridgeMissing.title': '无法连接桌面桥接',
  'error.bridgeMissing.body': 'window.digitalHuman 不存在：请在 Electron 中启动本应用（app/main），不要在浏览器里直接打开 index.html。',
  'error.call': '调用失败：{message}',
  'error.unhandled': '未捕获的错误：{message}',
  'error.unknown': '未知错误',
  'error.promise': '操作失败，请稍后重试',

  'wizard.title': '首次使用向导',
  'wizard.step.env': '环境检查',
  'wizard.step.install': '安装桥接',
  'wizard.step.prefs': '偏好',
  'wizard.step.done': '完成',
  'wizard.next': '下一步',
  'wizard.back': '上一步',
  'wizard.finish': '开始使用',
  'wizard.unknown': '未知',
  'wizard.unavailable': '当前版本缺少接口 {method}，该功能不可用：请更新桌面应用。',
  'wizard.env.checking': '正在检查环境…',
  'wizard.env.checkFailed': '无法完成环境检查，请重试。',
  'wizard.env.homeTitle': 'dsh 主目录',
  'wizard.env.homeMissing': '目录不存在。请先安装 dsh，再按「重新检查」。',
  'wizard.env.profilesTitle': '配置档案（{count} 个）',
  'wizard.env.profilesNone': '未发现配置档案：请先运行一次 dsh。',
  'wizard.env.bridgeTitle': '桥接插件已安装',
  'wizard.env.bridgeMissing': '尚未在任一配置档案中安装桥接插件。',
  'wizard.env.runningTitle': 'harness 运行中',
  'wizard.env.runningDetail': '{count} 个端点正在运行 · 桥接版本 {version}',
  'wizard.env.runningNone': '未发现运行中的端点：启动 dsh 后将自动连接（现在也可继续）。',
  'wizard.env.olderBridge': '已安装的桥接版本为 {version}，低于当前应用所需版本：模型选择与重命名等新功能会保持隐藏，更新桥接并重启 dsh 后即可使用。',
  'wizard.env.recheck': '重新检查',
  'wizard.env.nextBlocked': '请先安装 dsh，然后按「重新检查」；也可以退出向导，稍后再从托盘图标重新打开。',
  'wizard.install.already': '桥接插件已安装。',
  'wizard.install.alreadyHint': '如需更新，请关闭 dsh，在本页重新选择安装包并安装。',
  'wizard.install.package': '离线安装包',
  'wizard.install.pick': '选择离线安装包…',
  'wizard.install.packageNone': '尚未选择安装包（.zip 或已解压目录）',
  'wizard.install.profile': '安装到配置档案',
  'wizard.install.profileDefault': 'web（默认）',
  'wizard.install.run': '安装',
  'wizard.install.installing': '正在安装…',
  'wizard.install.ok': '安装完成，桥接插件已就绪。',
  'wizard.install.failed': '安装失败：{message}',
  'wizard.install.noAnswer': '安装未返回任何结果，请重试。',
  'wizard.install.output': '安装输出',
  'wizard.prefs.startWithWindows': '开机自动启动',
  'wizard.prefs.alwaysOnTop': '窗口始终置顶',
  'wizard.prefs.notify': '权限请求时通知',
  'wizard.prefs.hint': '这些设置之后都可以在托盘菜单里修改。',
  'wizard.done.home': 'dsh 主目录位于 {path}。',
  'wizard.done.homeUnknown': '未读取到 dsh 主目录。',
  'wizard.done.bridge': '桥接插件{bridge}。',
  'wizard.done.yes': '已就绪',
  'wizard.done.no': '尚未就绪',
  'wizard.done.notifyYes': '权限请求会弹出系统通知。',
  'wizard.done.notifyNo': '权限请求不会弹出系统通知。',
  'wizard.done.prefs': '开机自动启动：{start}；窗口始终置顶：{top}。',
  'wizard.done.hint': '点击「开始使用」保存设置并进入主界面。',

  'util.truncated': '…（已截断）',
};

/** English dictionary, key-identical to the Chinese source of truth. */
export const en = {
  'app.name': 'Digital human',
  'app.drag': 'Drag to move the window',

  'view.compact.title': 'Compact view: avatar only',
  'view.compact.expand': 'Expand to the full panel',
  'view.expanded.collapse': 'Collapse to the compact view',
  'view.compact.pending': '{count} awaiting a decision',
  'view.compact.process': 'Review',

  'status.connected': '{host} · {profile} · bridge {bridge}',
  'status.phase.searching': 'Looking for the endpoint file…',
  'status.phase.connecting': 'Connecting to the bridge…',
  'status.phase.disconnected': 'The bridge connection closed',
  'status.phase.offline': 'Not connected',
  'status.phase.error': 'Something went wrong',
  'status.retry': 'Retry',
  'status.retrying': 'Retrying…',
  'status.noDetail': 'No further detail',
  'status.code.no-endpoint': 'No endpoint file found — is dsh running with the bridge installed?',
  'status.code.no-token': 'No token recorded for profile {profile}',
  'status.code.connecting': 'Connecting to {path}',
  'status.code.protocol-mismatch': 'Protocol mismatch: bridge {bridge}, app {app}',
  'status.code.bad-proof': 'The bridge did not prove it holds the local token',
  'status.code.closed': 'The bridge connection closed',

  'face.offline': 'offline',
  'face.idle': 'idle',
  'face.thinking': 'thinking',
  'face.working': 'working',
  'face.waiting': 'waiting for approval',
  'face.error': 'error',
  'face.done': 'done',

  'avatar.label.offline': 'Avatar: not connected, offline',
  'avatar.label.idle': 'Avatar: connected and standing by',
  'avatar.label.thinking': 'Avatar: thinking',
  'avatar.label.working': 'Avatar: working on a task',
  'avatar.label.waiting': 'Avatar: an approval request awaits your decision',
  'avatar.label.error': 'Avatar: something failed',
  'avatar.label.done': 'Avatar: the task completed',

  'approval.title': 'Permission request',
  'approval.tool': 'Tool',
  'approval.reason': 'Reason',
  'approval.args': 'Arguments',
  'approval.countdown': '{seconds}s left',
  'approval.noDeadline': 'no timeout',
  'approval.allow': 'Allow once',
  'approval.reject': 'Reject',
  'approval.more': '{count} more awaiting a decision',
  'approval.pending': 'Submitted — waiting for the host…',

  'panel.sessions': 'Sessions',
  'panel.noSessions': 'No session',
  'panel.activity': 'Activity',
  'panel.noActivity': 'No activity yet',
  'panel.selectHint': 'Select a session to see its activity',
  'activity.scope.current': 'This session',
  'activity.scope.all': 'All sessions',
  'activity.modeAll': 'All sessions',
  'activity.noActivity': 'No activity in any session yet',
  'activity.pinned': 'Needs attention',
  'activity.recent': 'Recent · {session}',
  'activity.rowTitle': '{session} · {kind}',

  'activity.toolCall': 'tool call',
  'activity.toolResult': 'tool result',
  'activity.turnStart': 'turn start',
  'activity.turnEnd': 'turn end',
  'activity.assistantMessage': 'reply',
  'activity.agentError': 'agent error',
  'activity.text': 'text',
  'activity.unknown': 'activity',

  'session.running': 'running',
  'session.idle': 'idle',
  'session.error': 'error',
  'session.jobs': '{count} jobs',
  'session.tools': '{count} tools',
  'session.children': '{count} subagent sessions',
  'session.childrenHide': 'Hide subagent sessions',
  'session.childrenHead': 'Subagent sessions',
  'session.childChip': 'sub',
  'session.create': 'New session',
  'session.created': 'Created — the new session is selected',
  'session.createCancelled': 'Session creation cancelled',
  'session.rename': 'Rename',
  'session.renamePrompt': 'Enter a new session title',
  'session.renameUnavailable': 'This environment cannot prompt for a title',
  'session.renamed': 'Renamed',

  'model.select': 'Choose a model',
  'model.unsupported': 'The bridge plugin is older — restart dsh to pick a model',
  'model.empty': 'No model available',
  'model.unset': 'not set',
  'model.refresh': 'Refresh',
  'model.refreshed': 'Model list refresh requested',
  'model.selected': 'Model set to {model}',

  'time.justNow': 'just now',
  'time.seconds': '{count}s ago',
  'time.minutes': '{count}m ago',
  'time.hours': '{count}h ago',

  'composer.placeholder': 'Type an instruction for this session…',
  'composer.send': 'Send',
  'composer.cancel': 'Cancel current turn',
  'composer.sent': 'Sent',
  'composer.cancelled': 'Cancellation requested',
  'composer.noSession': 'Select a session first',

  'footer.counts': 'Sessions {sessions} · running {running} · jobs {jobs}',
  'footer.pin': 'Pin on top',
  'footer.unpin': 'Unpin',
  'footer.hide': 'Hide',
  'footer.opacity.label': 'Panel opacity',
  'footer.opacity.dim': 'Translucent',
  'footer.opacity.default': 'Standard',
  'footer.opacity.solid': 'Opaque',
  'footer.opacity.unavailable': 'This build cannot change the opacity — please update the desktop app.',

  'error.dismiss': 'Dismiss the error message',
  'error.bridgeMissing.title': 'The desktop bridge is unavailable',
  'error.bridgeMissing.body': 'window.digitalHuman is missing: start this app inside Electron (app/main) instead of opening index.html in a browser.',
  'error.call': 'Call failed: {message}',
  'error.unhandled': 'Uncaught error: {message}',
  'error.unknown': 'unknown error',
  'error.promise': 'The operation failed, please retry',

  'wizard.title': 'First-run setup',
  'wizard.step.env': 'Environment',
  'wizard.step.install': 'Install bridge',
  'wizard.step.prefs': 'Preferences',
  'wizard.step.done': 'Finish',
  'wizard.next': 'Next',
  'wizard.back': 'Back',
  'wizard.finish': 'Start using',
  'wizard.unknown': 'unknown',
  'wizard.unavailable': 'This build does not expose {method}, so that action is unavailable — please update the desktop app.',
  'wizard.env.checking': 'Checking the environment…',
  'wizard.env.checkFailed': 'The environment check could not complete. Please retry.',
  'wizard.env.homeTitle': 'dsh home',
  'wizard.env.homeMissing': 'The directory does not exist. Install dsh first, then press “Re-check”.',
  'wizard.env.profilesTitle': 'Profiles ({count})',
  'wizard.env.profilesNone': 'No profiles found — run dsh once first.',
  'wizard.env.bridgeTitle': 'Bridge installed',
  'wizard.env.bridgeMissing': 'The bridge is not installed in any profile yet.',
  'wizard.env.runningTitle': 'Harness running',
  'wizard.env.runningDetail': '{count} endpoints running · bridge {version}',
  'wizard.env.runningNone': 'No endpoint yet — the app connects as soon as dsh starts (you can continue now).',
  'wizard.env.olderBridge': 'The installed bridge is {version}, older than this app needs: model selection, renaming and other new features stay hidden until you update the bridge and restart dsh.',
  'wizard.env.recheck': 'Re-check',
  'wizard.env.nextBlocked': 'Install dsh first, then press “Re-check”; you can also leave the wizard and reopen it later from the tray icon.',
  'wizard.install.already': 'The bridge is already installed.',
  'wizard.install.alreadyHint': 'To update it, quit dsh, pick the package again below, and install.',
  'wizard.install.package': 'Offline package',
  'wizard.install.pick': 'Choose offline package…',
  'wizard.install.packageNone': 'No package chosen yet (.zip or an extracted folder)',
  'wizard.install.profile': 'Install into profile',
  'wizard.install.profileDefault': 'web (default)',
  'wizard.install.run': 'Install',
  'wizard.install.installing': 'Installing…',
  'wizard.install.ok': 'Done — the bridge is ready.',
  'wizard.install.failed': 'Install failed: {message}',
  'wizard.install.noAnswer': 'The installer returned no result. Please retry.',
  'wizard.install.output': 'Installer output',
  'wizard.prefs.startWithWindows': 'Start with Windows',
  'wizard.prefs.alwaysOnTop': 'Keep the window on top',
  'wizard.prefs.notify': 'Notify on permission requests',
  'wizard.prefs.hint': 'All of these can be changed later from the tray menu.',
  'wizard.done.home': 'The dsh home is {path}.',
  'wizard.done.homeUnknown': 'The dsh home could not be read.',
  'wizard.done.bridge': 'The bridge is {bridge}.',
  'wizard.done.yes': 'ready',
  'wizard.done.no': 'not ready yet',
  'wizard.done.notifyYes': 'Permission requests raise a system notification.',
  'wizard.done.notifyNo': 'Permission requests stay silent.',
  'wizard.done.prefs': 'Start with Windows: {start}; always on top: {top}.',
  'wizard.done.hint': 'Press “Start using” to save these settings and open the main view.',

  'util.truncated': '… (truncated)',
};

/** Dictionaries by language tag. */
export const dictionaries = { zh, en };

/** Replace `{name}` placeholders with their parameters. */
export function format(template, params) {
  if (typeof template !== 'string') return '';
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Pick `zh` unless the environment clearly prefers another language. */
function detectLanguage() {
  const tag = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '');
  return tag.toLowerCase().startsWith('zh') || tag === '' ? 'zh' : 'en';
}

let language = detectLanguage();

/** The active language tag. */
export function getLanguage() {
  return language;
}

/** Switch dictionaries; unknown tags fall back to the Chinese source of truth. */
export function setLanguage(tag) {
  language = dictionaries[tag] === undefined ? 'zh' : tag;
}

/**
 * Translate one key.
 * @param key - dictionary key.
 * @param params - optional `{name}` placeholders.
 * @returns the translated string, or the key itself when it is unknown.
 */
export function t(key, params) {
  const table = dictionaries[language] ?? zh;
  const template = table[key] ?? zh[key] ?? key;
  return format(template, params);
}

/**
 * Whether a key is translated.
 *
 * Callers that derive a key from wire data (an activity kind, a phase name) use
 * this to fall back to the raw wire value instead of leaking a dictionary key
 * into the UI when a new value appears.
 *
 * @param key - locale key.
 * @returns true when {@link t} would find a real translation.
 */
export function has(key) {
  const table = dictionaries[language] ?? zh;
  return table[key] !== undefined || zh[key] !== undefined;
}
