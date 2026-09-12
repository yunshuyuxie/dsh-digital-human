/**
 * `digital-human` namespace dictionaries.
 *
 * Simplified Chinese is the key-set source of truth; English must stay
 * key-identical. Every value may carry `{name}` placeholders filled by the
 * plugin's own formatter, so a missing `t` prop from the slot runtime still
 * renders readable copy.
 */

/** Simplified Chinese dictionary (key-set source of truth). */
const zh = {
  'state.offline': '还没有会话，随时待命',
  'state.idle': '空闲中，等待你的指令',
  'state.thinking': '正在思考…',
  'state.working.jobs': '正在执行 {count} 个后台任务',
  'state.working.sessions': '{count} 个会话正在运行',
  'state.waiting.one': '有 1 项权限请求等你确认',
  'state.waiting.other': '有 {count} 项权限请求等你确认',
  'state.error.agent': '出错了：{detail}',
  'state.error.jobs': '有 {count} 个后台任务失败',
  'state.done': '任务完成 ✓',

  'panel.title': '数字人 · 任务监控',
  'panel.collapse': '收起监控面板',
  'panel.expand': '展开监控面板',
  'panel.current': '当前会话',
  'panel.noSession': '未选择会话',
  'panel.jobs': '后台任务',
  'panel.noJobs': '没有后台任务',
  'panel.sessions': '并行会话',
  'panel.noSessions': '没有其他运行中的会话',
  'panel.voiceOn': '语音播报：开',
  'panel.voiceOff': '语音播报：关',
  'panel.foot': '权限请求会直接出现在这里',

  'session.running': '运行中',
  'session.idle': '空闲',

  'status.running': '运行中',
  'status.stopping': '正在停止',
  'status.completed': '已完成',
  'status.killed': '已取消',
  'status.failed': '已失败',

  'duration.seconds': '{seconds}秒',
  'duration.minutes': '{minutes}分{seconds}秒',
  'duration.hours': '{hours}小时{minutes}分',
  'duration.title.live': '已运行 {duration}',
  'duration.title.done': '耗时 {duration}',

  'approval.title': '权限确认',
  'approval.escalation': '工具 {toolName} 请求越权执行',
  'approval.reason': '原因',
  'approval.allow': '允许一次',
  'approval.reject': '拒绝',
  'approval.more': '还有 {count} 项待确认',
  'approval.voice': '有一项权限请求需要你确认',
  'approval.settled.allow': '已允许一次',
  'approval.settled.reject': '已拒绝',

  'voice.done': '任务完成',
  'voice.error': '任务执行出错',
};

/** English dictionary, key-identical to the Chinese source of truth. */
const en = {
  'state.offline': 'No session yet — standing by',
  'state.idle': 'Idle, waiting for your instruction',
  'state.thinking': 'Thinking…',
  'state.working.jobs': 'Running {count} background jobs',
  'state.working.sessions': '{count} sessions are running',
  'state.waiting.one': '1 permission request awaits your decision',
  'state.waiting.other': '{count} permission requests await your decision',
  'state.error.agent': 'Something failed: {detail}',
  'state.error.jobs': '{count} background jobs failed',
  'state.done': 'Task complete ✓',

  'panel.title': 'Digital human · task monitor',
  'panel.collapse': 'Collapse the monitor panel',
  'panel.expand': 'Expand the monitor panel',
  'panel.current': 'Current session',
  'panel.noSession': 'No session selected',
  'panel.jobs': 'Background jobs',
  'panel.noJobs': 'No background jobs',
  'panel.sessions': 'Parallel sessions',
  'panel.noSessions': 'No other running session',
  'panel.voiceOn': 'Voice announcements: on',
  'panel.voiceOff': 'Voice announcements: off',
  'panel.foot': 'Permission requests appear right here',

  'session.running': 'running',
  'session.idle': 'idle',

  'status.running': 'running',
  'status.stopping': 'stopping',
  'status.completed': 'completed',
  'status.killed': 'cancelled',
  'status.failed': 'failed',

  'duration.seconds': '{seconds}s',
  'duration.minutes': '{minutes}m {seconds}s',
  'duration.hours': '{hours}h {minutes}m',
  'duration.title.live': 'Running for {duration}',
  'duration.title.done': 'Took {duration}',

  'approval.title': 'Permission request',
  'approval.escalation': 'Tool {toolName} requests privileged execution',
  'approval.reason': 'Reason',
  'approval.allow': 'Allow once',
  'approval.reject': 'Reject',
  'approval.more': '{count} more awaiting a decision',
  'approval.voice': 'A permission request needs your decision',
  'approval.settled.allow': 'Allowed once',
  'approval.settled.reject': 'Rejected',

  'voice.done': 'Task complete',
  'voice.error': 'A task failed',
};

/** Replace `{name}` placeholders with their parameters. */
function format(template, params) {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve the namespace translator: the slot runtime's `t` when the embedding
 * slot supplied one, otherwise this plugin's own Chinese formatter.
 * @param props - slot props that may carry a namespaced translator.
 * @returns a `(key, params) => string` function.
 */
function translatorOf(props) {
  if (props !== undefined && typeof props.t === 'function') {
    return (key, params) => {
      const text = props.t(key, params);
      return typeof text === 'string' ? text : format(zh[key] ?? key, params);
    };
  }
  return (key, params) => format(zh[key] ?? key, params);
}

module.exports = { NS: 'digital-human', zh, en, format, translatorOf };
