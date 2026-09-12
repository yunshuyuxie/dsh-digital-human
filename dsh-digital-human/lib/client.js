window.__ModuleLoader__.load({
	id: "dsh-digital-human",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var registry = {};
		var cache = {};
		/** Register one inlined plugin module under its './name.js' key. */
		function __define(key, factory) {
			registry[key] = factory;
		}
		/** Resolve a relative request; the client source directory is flat. */
		function __resolve(request) {
			return request.charAt(0) === '.' ? (request.endsWith('.js') ? request : request + '.js') : request;
		}
		/** Require one inlined module, or hand an external request to the loader. */
		function __require(request) {
			if (request.charAt(0) !== '.') return require(request);
			var key = __resolve(request);
			var cached = cache[key];
			if (cached !== undefined) return cached.exports;
			var factory = registry[key];
			if (factory === undefined) throw new Error("dsh-digital-human: unknown client module " + key);
			var record = { exports: {} };
			cache[key] = record;
			factory(record, record.exports, __require);
			return record.exports;
		}
		__define("./approval.js", (module, exports, require) => {
		/**
		 * One answerable presentation of a forwarded Host approval request.
		 *
		 * Mirrors the shipped approval panel's contract: the request is held until the
		 * digital human answers it, delegates it down the waterfall, or its lifetime
		 * ends by abort. The outcome vocabulary is the Host's closed set —
		 * `allowed-once` is the only grant.
		 */

		/** The only granting outcome. */
		const ALLOW_ONCE = 'allowed-once';
		/** The explicit refusal outcome. */
		const REJECTED = 'rejected';

		/**
		 * Cross-domain pending-interaction precedence. `dsh-client-ui-approval` uses 0
		 * and `dsh-client-ui-user-questions` uses 1 (2 for plan review), so the digital
		 * human outranks the approval panel it replaces while a question still wins.
		 */
		const APPROVAL_PRECEDENCE = 0.5;

		let nextKey = 0;

		/** One decision the digital human is holding open. */
		class PendingApproval {
		  /**
		   * @param sessionId - the session whose agent asked for the decision.
		   * @param request - Host approval request projected through the Remote Event.
		   */
		  constructor(sessionId, request) {
		    this.sessionId = sessionId;
		    this.kind = 'approval';
		    nextKey += 1;
		    this.key = `digital-human:approval:${String(nextKey)}`;
		    this.toolName = request.toolName;
		    this.callId = request.callId;
		    this.reason = request.reason;
		    this.outcome = undefined;

		    let settle;
		    let fail;
		    this.result = new Promise((resolve, reject) => {
		      settle = resolve;
		      fail = reject;
		    });
		    this.#resolve = settle;
		    this.#reject = fail;
		    this.#delegated = Symbol('digital-human:approval delegated');
		    this.#settled = false;

		    const signal = request.signal;
		    if (signal === undefined) return;
		    const onAbort = () => {
		      this.abort(signal.reason ?? new Error('approval request was aborted'));
		    };
		    this.#signal = signal;
		    this.#onAbort = onAbort;
		    signal.addEventListener('abort', onAbort, { once: true });
		    if (signal.aborted) onAbort();
		  }

		  #resolve;

		  #reject;

		  #signal;

		  #onAbort;

		  #delegated;

		  #settled;

		  /**
		   * Answer the waiting Host waterfall.
		   * @param outcome - `allowed-once` or `rejected`.
		   * @returns whether this call settled the request.
		   */
		  answer(outcome) {
		    if (this.#settled) return false;
		    this.outcome = outcome;
		    this.#finish(() => {
		      this.#resolve(outcome);
		    });
		    return true;
		  }

		  /** Allow this one operation. */
		  allow() {
		    return this.answer(ALLOW_ONCE);
		  }

		  /** Refuse this operation. */
		  reject() {
		    return this.answer(REJECTED);
		  }

		  /** Hand the request to the next waterfall listener. */
		  delegate() {
		    if (this.#settled) return;
		    this.#finish(() => {
		      this.#reject(this.#delegated);
		    });
		  }

		  /**
		   * Whether a rejection is this request's own delegation signal.
		   * @param error - the rejection received from {@link PendingApproval.result}.
		   */
		  isDelegation(error) {
		    return error === this.#delegated;
		  }

		  /**
		   * End an unanswered request when its transport or plugin lifetime ends.
		   * @param reason - rejection exposed to the waiting listener.
		   */
		  abort(reason) {
		    if (this.#settled) return;
		    this.#finish(() => {
		      this.#reject(reason);
		    });
		  }

		  /** Whether this request still waits for a decision. */
		  get settled() {
		    return this.#settled;
		  }

		  #finish(settle) {
		    this.#settled = true;
		    if (this.#signal !== undefined && this.#onAbort !== undefined) {
		      this.#signal.removeEventListener('abort', this.#onAbort);
		    }
		    settle();
		  }
		}

		module.exports = { ALLOW_ONCE, APPROVAL_PRECEDENCE, PendingApproval, REJECTED };

		});
		__define("./avatar.js", (module, exports, require) => {
		/**
		 * The digital human's face: a small animated SVG whose eyes, mouth, and halo
		 * follow the projected state. Pure presentation — every expression is a
		 * function of the `face` value handed in by the overlay.
		 */

		const React = require('react');

		const h = React.createElement;

		/** Eyes for one state, as SVG children keyed `eye-left` / `eye-right`. */
		function eyesFor(face) {
		  if (face === 'error') {
		    const cross = (x, key) => h(
		      'path',
		      {
		        key,
		        className: 'dh-eye-stroke',
		        d: `M${String(x - 3)} 31 L${String(x + 3)} 37 M${String(x + 3)} 31 L${String(x - 3)} 37`,
		      },
		    );
		    return [cross(24, 'eye-left'), cross(40, 'eye-right')];
		  }
		  if (face === 'done') {
		    const arc = (x, key) => h('path', {
		      key,
		      className: 'dh-eye-stroke',
		      d: `M${String(x - 3.4)} 35 Q${String(x)} 30.5 ${String(x + 3.4)} 35`,
		    });
		    return [arc(24, 'eye-left'), arc(40, 'eye-right')];
		  }
		  if (face === 'offline') {
		    const lid = (x, key) => h('path', {
		      key,
		      className: 'dh-eye-stroke',
		      d: `M${String(x - 3.2)} 34.5 H${String(x + 3.2)}`,
		    });
		    return [lid(24, 'eye-left'), lid(40, 'eye-right')];
		  }
		  const waiting = face === 'waiting';
		  const thinking = face === 'thinking';
		  const radiusX = waiting ? 3.5 : 3.1;
		  const radiusY = waiting ? 4.7 : 3.9;
		  const shiftX = thinking ? 1.5 : 0;
		  const shiftY = thinking ? -1.8 : 0;
		  const dot = (x, key) => h('ellipse', {
		    key,
		    className: 'dh-eye',
		    cx: x + shiftX,
		    cy: 34 + shiftY,
		    rx: radiusX,
		    ry: radiusY,
		  });
		  return [dot(24, 'eye-left'), dot(40, 'eye-right')];
		}

		/** Mouth for one state. */
		function mouthFor(face) {
		  if (face === 'waiting') return h('circle', { className: 'dh-mouth dh-mouth-open', cx: 32, cy: 49, r: 3.2 });
		  const paths = {
		    idle: 'M26 47 Q32 51.5 38 47',
		    thinking: 'M28 48.5 H36',
		    working: 'M26 46 Q32 53.5 38 46',
		    error: 'M26 51.5 Q32 45.5 38 51.5',
		    done: 'M24 45 Q32 55 40 45',
		    offline: 'M28 49 H36',
		  };
		  return h('path', { className: 'dh-mouth', d: paths[face] ?? paths.idle });
		}

		/**
		 * One avatar face.
		 * @param props - `{ face }`, the projected state name.
		 * @returns the face SVG.
		 */
		function AvatarFace(props) {
		  return h(
		    'svg',
		    {
		      className: 'dh-svg',
		      width: 72,
		      height: 72,
		      viewBox: '0 0 64 64',
		      'aria-hidden': 'true',
		      focusable: 'false',
		    },
		    h('circle', { key: 'ring', className: 'dh-ring', cx: 32, cy: 36, r: 26 }),
		    h('line', { key: 'antenna', className: 'dh-antenna', x1: 32, y1: 15, x2: 32, y2: 7.5 }),
		    h('circle', { key: 'tip', className: 'dh-antenna-tip', cx: 32, cy: 6.4, r: 2.6 }),
		    h('circle', { key: 'head', className: 'dh-head', cx: 32, cy: 36, r: 22 }),
		    ...eyesFor(props.face),
		    mouthFor(props.face),
		  );
		}

		module.exports = { AvatarFace };

		});
		__define("./locales.js", (module, exports, require) => {
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

		});
		__define("./overlay.js", (module, exports, require) => {
		/**
		 * The floating digital human: one overlay-layer widget that shows the avatar,
		 * its spoken status, a task-monitor panel, and the permission cards it is
		 * holding open.
		 *
		 * It reads only its own store snapshot, so it renders identically whether the
		 * embedding slot hands it props or not.
		 */

		const React = require('react');

		const h = React.createElement;
		const { AvatarFace } = require('./avatar.js');
		const { translatorOf } = require('./locales.js');
		const { getRuntime } = require('./runtime.js');

		/** React 18's store hook, with a local fallback for older renderers. */
		const useSyncExternalStore = typeof React.useSyncExternalStore === 'function'
		  ? React.useSyncExternalStore
		  : function fallback(subscribe, getSnapshot) {
		    const [value, setValue] = React.useState(getSnapshot);
		    React.useEffect(() => subscribe(() => {
		      setValue(getSnapshot());
		    }), [subscribe, getSnapshot]);
		    return value;
		  };

		/** Subscribe to the plugin store. */
		function useSnapshot() {
		  const runtime = getRuntime();
		  return useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
		}

		/** Elapsed time in at most two adjacent units. */
		function formatDuration(elapsedMs, t) {
		  const total = Math.max(0, Math.floor(elapsedMs / 1000));
		  const seconds = total % 60;
		  const minutes = Math.floor(total / 60) % 60;
		  const hours = Math.floor(total / 3600);
		  if (hours > 0) return t('duration.hours', { hours, minutes });
		  if (minutes > 0) return t('duration.minutes', { minutes, seconds });
		  return t('duration.seconds', { seconds });
		}

		/** Marker semantics shared with the background-job list. */
		function dotState(status) {
		  if (status === 'running') return 'ongoing';
		  if (status === 'completed') return 'done';
		  if (status === 'failed') return 'error';
		  return 'warning';
		}

		/** Human status word for one wire status. */
		function statusLabel(status, t) {
		  const keys = {
		    running: 'status.running',
		    stopping: 'status.stopping',
		    completed: 'status.completed',
		    killed: 'status.killed',
		    failed: 'status.failed',
		  };
		  const key = keys[status];
		  return key === undefined ? status : t(key);
		}

		/** One background-job row. */
		function JobRow(props) {
		  const { job, now, t } = props;
		  const running = job.status === 'running' || job.status === 'stopping';
		  const elapsed = running ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt;
		  return h(
		    'div',
		    { className: 'dh-row' },
		    h('span', { className: 'dh-dot', 'data-state': dotState(job.status) }),
		    h('span', { className: 'dh-kind' }, job.kind),
		    h('span', { className: 'dh-label', title: job.label }, job.label),
		    h('span', { className: 'dh-meta', title: job.detail ?? statusLabel(job.status, t) }, job.detail ?? statusLabel(job.status, t)),
		    h(
		      'span',
		      { className: 'dh-meta', title: t(running ? 'duration.title.live' : 'duration.title.done', { duration: formatDuration(elapsed, t) }) },
		      formatDuration(elapsed, t),
		    ),
		  );
		}

		/** The permission card the digital human is holding open. */
		function ApprovalCard(props) {
		  const { approval, pendingCount, t } = props;
		  const [settling, setSettling] = React.useState(false);
		  const answer = (allow) => {
		    if (settling) return;
		    setSettling(true);
		    if (allow) approval.allow();
		    else approval.reject();
		  };
		  return h(
		    'div',
		    { className: 'dh-approval', 'data-approval-key': approval.key },
		    h('div', { className: 'dh-approval-title' }, t('approval.title')),
		    h('div', { className: 'dh-approval-tool' }, t('approval.escalation', { toolName: approval.toolName })),
		    typeof approval.reason === 'string' && approval.reason !== ''
		      ? h('div', { className: 'dh-approval-reason' }, `${t('approval.reason')}: ${approval.reason}`)
		      : null,
		    h(
		      'div',
		      { className: 'dh-actions' },
		      h(
		        'button',
		        { type: 'button', className: 'dh-btn dh-btn-allow', disabled: settling, onClick: () => { answer(true); } },
		        t('approval.allow'),
		      ),
		      h(
		        'button',
		        { type: 'button', className: 'dh-btn dh-btn-reject', disabled: settling, onClick: () => { answer(false); } },
		        t('approval.reject'),
		      ),
		    ),
		    pendingCount > 1 ? h('div', { className: 'dh-foot' }, t('approval.more', { count: pendingCount - 1 })) : null,
		  );
		}

		/** The monitor panel. */
		function MonitorPanel(props) {
		  const { snapshot, t, onToggleVoice } = props;
		  const current = snapshot.current;
		  return h(
		    'div',
		    { className: 'dh-panel' },
		    h(
		      'div',
		      { className: 'dh-panel-head' },
		      h('span', { className: 'dh-title' }, t('panel.title')),
		      h(
		        'button',
		        {
		          type: 'button',
		          className: 'dh-icon-btn',
		          title: t(snapshot.voice ? 'panel.voiceOn' : 'panel.voiceOff'),
		          'aria-pressed': snapshot.voice,
		          onClick: onToggleVoice,
		        },
		        snapshot.voice ? '🔊' : '🔇',
		      ),
		    ),
		    snapshot.approvals.length > 0
		      ? h(ApprovalCard, {
		        key: snapshot.approvals[0].key,
		        approval: snapshot.approvals[0],
		        pendingCount: snapshot.approvals.length,
		        t,
		      })
		      : null,
		    h(
		      'div',
		      { className: 'dh-section' },
		      h('div', { className: 'dh-section-title' }, t('panel.current')),
		      current === null
		        ? h('div', { className: 'dh-empty' }, t('panel.noSession'))
		        : h(
		          'div',
		          { className: 'dh-row' },
		          h('span', { className: 'dh-dot', 'data-state': current.running ? 'ongoing' : 'done' }),
		          h('span', { className: 'dh-label', title: current.title }, current.title),
		          h('span', { className: 'dh-meta' }, t(current.running ? 'session.running' : 'session.idle')),
		        ),
		      current !== null && current.error !== null && current.error !== ''
		        ? h('div', { className: 'dh-err' }, current.error)
		        : null,
		    ),
		    h(
		      'div',
		      { className: 'dh-section' },
		      h('div', { className: 'dh-section-title' }, `${t('panel.jobs')} · ${String(snapshot.counts.jobs)}`),
		      snapshot.jobs.length === 0
		        ? h('div', { className: 'dh-empty' }, t('panel.noJobs'))
		        : snapshot.jobs.map((job) => h(JobRow, { key: job.id, job, now: snapshot.now, t })),
		    ),
		    h(
		      'div',
		      { className: 'dh-section' },
		      h('div', { className: 'dh-section-title' }, `${t('panel.sessions')} · ${String(snapshot.counts.sessions)}`),
		      snapshot.sessions.length === 0
		        ? h('div', { className: 'dh-empty' }, t('panel.noSessions'))
		        : snapshot.sessions.map((session) => h(
		          'div',
		          { className: 'dh-row', key: session.id },
		          h('span', { className: 'dh-dot', 'data-state': 'ongoing' }),
		          h('span', { className: 'dh-label', title: session.title }, session.title),
		          h('span', { className: 'dh-meta' }, t('session.running')),
		        )),
		    ),
		    h('div', { className: 'dh-foot' }, t('panel.foot')),
		  );
		}

		/**
		 * The overlay-layer widget.
		 * @param props - slot props; only a namespaced `t` is consumed, and it is optional.
		 * @returns the avatar, its status bubble, and the panel when open.
		 */
		function DigitalHumanOverlay(props) {
		  const snapshot = useSnapshot();
		  const runtime = getRuntime();
		  const t = translatorOf(props);
		  const [open, setOpen] = React.useState(false);
		  const rootRef = React.useRef(null);
		  const pending = snapshot.approvals.length;

		  React.useEffect(() => {
		    if (pending > 0) setOpen(true);
		  }, [pending]);

		  React.useEffect(() => {
		    if (!open) return undefined;
		    const onPointerDown = (event) => {
		      const root = rootRef.current;
		      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
		    };
		    const onKeyDown = (event) => {
		      if (event.key === 'Escape') setOpen(false);
		    };
		    document.addEventListener('pointerdown', onPointerDown);
		    document.addEventListener('keydown', onKeyDown);
		    return () => {
		      document.removeEventListener('pointerdown', onPointerDown);
		      document.removeEventListener('keydown', onKeyDown);
		    };
		  }, [open]);

		  const message = t(snapshot.message.key, snapshot.message.params);

		  return h(
		    'div',
		    { className: 'dh-root', 'data-face': snapshot.face, ref: rootRef },
		    open ? h(MonitorPanel, { snapshot, t, onToggleVoice: runtime.toggleVoice }) : null,
		    !open ? h('div', { className: 'dh-bubble' }, message) : null,
		    h(
		      'div',
		      { className: 'dh-face-wrap' },
		      h(
		        'button',
		        {
		          type: 'button',
		          className: 'dh-face',
		          title: message,
		          'aria-label': `${t('panel.title')} — ${message}`,
		          'aria-expanded': open,
		          onClick: () => setOpen((value) => !value),
		        },
		        h(AvatarFace, { face: snapshot.face }),
		      ),
		      pending > 0 ? h('span', { className: 'dh-badge' }, String(pending)) : null,
		    ),
		  );
		}

		module.exports = { DigitalHumanOverlay, MonitorPanel, ApprovalCard, formatDuration, useSnapshot };

		});
		__define("./plugin.js", (module, exports, require) => {
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

		});
		__define("./runtime.js", (module, exports, require) => {
		/**
		 * The one module-scoped handoff between the plugin body and its React tree.
		 *
		 * A separate module (rather than an import from `plugin.js`) keeps the overlay
		 * from depending on the entry that mounts it, which would be a require cycle
		 * inside the loader bundle.
		 */

		let current = null;

		/** Publish the plugin runtime for the overlay to read. */
		function setRuntime(runtime) {
		  current = runtime;
		}

		/** Read the published runtime. */
		function getRuntime() {
		  if (current === null) throw new Error('dsh-digital-human: the overlay rendered before apply() published its runtime');
		  return current;
		}

		module.exports = { getRuntime, setRuntime };

		});
		__define("./store.js", (module, exports, require) => {
		/**
		 * Digital-human state: a tiny observable store plus the pure projection that
		 * turns the client session mirror into one avatar snapshot.
		 *
		 * The store keeps `useSyncExternalStore` honest — `getSnapshot` returns the
		 * previous object whenever nothing the UI shows has changed, so the one-second
		 * duration tick never re-renders an idle avatar.
		 */

		/** Avatar faces, in the projection's priority order. */
		const FACE = {
		  WAITING: 'waiting',
		  ERROR: 'error',
		  WORKING: 'working',
		  THINKING: 'thinking',
		  DONE: 'done',
		  OFFLINE: 'offline',
		  IDLE: 'idle',
		};

		/** Wire statuses whose work is still in flight. */
		const LIVE_STATUSES = ['running', 'stopping'];

		/** How long a finished turn keeps the celebratory face. */
		const DONE_HOLD_MS = 6000;

		/** Whether one job is still running (and therefore ticks). */
		function isLive(job) {
		  return LIVE_STATUSES.includes(job.status);
		}

		/**
		 * Create one immutable-snapshot observable store.
		 * @param initial - the first snapshot.
		 * @returns `{ getSnapshot, subscribe, set }`.
		 */
		function createStore(initial) {
		  let snapshot = initial;
		  const listeners = new Set();
		  return {
		    getSnapshot: () => snapshot,
		    subscribe(listener) {
		      listeners.add(listener);
		      return () => {
		        listeners.delete(listener);
		      };
		    },
		    set(next) {
		      if (Object.is(next, snapshot)) return;
		      snapshot = next;
		      for (const listener of [...listeners]) {
		        try {
		          listener();
		        } catch (error) {
		          console.error('[digital-human] store listener failed', error);
		        }
		      }
		    },
		  };
		}

		/** Count the jobs a session's mirror still holds open. */
		function countLive(jobs) {
		  let live = 0;
		  for (const job of jobs) if (isLive(job)) live += 1;
		  return live;
		}

		/**
		 * Project the session mirror into one avatar snapshot.
		 * @param input - `{ list, approvals, voice, now, doneAt }`.
		 * @returns the snapshot the overlay renders.
		 */
		function project(input) {
		  const list = input.list ?? {};
		  const byId = list.byId ?? {};
		  const ids = Array.isArray(list.ids) ? list.ids : [];
		  const currentId = list.current;
		  const summary = currentId === undefined ? undefined : byId[currentId];
		  const jobsBySession = list.jobsBySession ?? {};
		  const jobs = currentId !== undefined && Array.isArray(jobsBySession[currentId]) ? [...jobsBySession[currentId]] : [];
		  const liveJobs = countLive(jobs);
		  const failedJobs = jobs.filter((job) => job.status === 'failed').length;
		  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
		  const siblings = ids
		    .map((id) => byId[id])
		    .filter((row) => row !== undefined && row.running === true && row.id !== currentId)
		    .map((row) => ({ id: row.id, title: row.displayTitle ?? row.title ?? row.id }));
		  const agentError = summary?.lastAgentError ?? null;
		  const currentRunning = summary?.running === true;
		  const recentDone = input.doneAt !== undefined && input.now - input.doneAt < DONE_HOLD_MS;

		  let face = FACE.IDLE;
		  let message = { key: 'state.idle' };
		  if (approvals.length > 0) {
		    face = FACE.WAITING;
		    message = {
		      key: approvals.length === 1 ? 'state.waiting.one' : 'state.waiting.other',
		      params: { count: approvals.length },
		    };
		  } else if (agentError !== null && agentError !== '') {
		    face = FACE.ERROR;
		    message = { key: 'state.error.agent', params: { detail: agentError } };
		  } else if (failedJobs > 0 && !recentDone) {
		    face = FACE.ERROR;
		    message = { key: 'state.error.jobs', params: { count: failedJobs } };
		  } else if (liveJobs > 0) {
		    face = FACE.WORKING;
		    message = { key: 'state.working.jobs', params: { count: liveJobs } };
		  } else if (siblings.length > 0 && !currentRunning) {
		    face = FACE.WORKING;
		    message = { key: 'state.working.sessions', params: { count: siblings.length + (currentRunning ? 1 : 0) + (liveJobs > 0 ? 1 : 0) } };
		  } else if (currentRunning) {
		    face = FACE.THINKING;
		    message = { key: 'state.thinking' };
		  } else if (recentDone) {
		    face = FACE.DONE;
		    message = { key: 'state.done' };
		  } else if (currentId === undefined && ids.length === 0) {
		    face = FACE.OFFLINE;
		    message = { key: 'state.offline' };
		  }

		  return {
		    face,
		    message,
		    now: input.now,
		    voice: input.voice === true,
		    approvals,
		    jobs,
		    sessions: siblings,
		    current: summary === undefined
		      ? null
		      : {
		        id: summary.id,
		        title: summary.displayTitle ?? summary.title ?? summary.id,
		        running: currentRunning,
		        error: agentError,
		      },
		    counts: {
		      approvals: approvals.length,
		      liveJobs,
		      jobs: jobs.length,
		      failedJobs,
		      sessions: siblings.length,
		    },
		  };
		}

		/**
		 * Everything the UI shows except ticking durations. Two snapshots with the same
		 * signature differ only in `now`, which matters only while a live row ticks.
		 */
		function signature(snapshot) {
		  return [
		    snapshot.face,
		    snapshot.message.key,
		    JSON.stringify(snapshot.message.params ?? {}),
		    snapshot.voice ? 'voice' : 'mute',
		    snapshot.counts.approvals,
		    snapshot.counts.liveJobs,
		    snapshot.counts.jobs,
		    snapshot.counts.failedJobs,
		    snapshot.counts.sessions,
		    snapshot.current === null
		      ? '-'
		      : `${snapshot.current.id}:${String(snapshot.current.running)}:${snapshot.current.title}:${snapshot.current.error ?? ''}`,
		    snapshot.jobs.map((job) => `${job.id}:${job.status}:${job.label}`).join(','),
		    snapshot.sessions.map((session) => session.id).join(','),
		    snapshot.approvals.map((approval) => approval.key).join(','),
		  ].join('|');
		}

		/**
		 * Re-project, reusing the previous snapshot object when nothing changed and no
		 * live row needs its duration to tick.
		 * @param previous - the snapshot currently published.
		 * @param input - projection input.
		 * @returns the snapshot to publish.
		 */
		function projectInto(previous, input) {
		  const next = project(input);
		  if (previous !== undefined && signature(previous) === signature(next) && next.counts.liveJobs === 0) return previous;
		  return next;
		}

		module.exports = { FACE, DONE_HOLD_MS, createStore, isLive, project, projectInto, signature };

		});
		__define("./styles.js", (module, exports, require) => {
		/**
		 * Digital-human styles. One `<style data-plugin>` tag per page, injected on
		 * apply, mirroring how the shipped client plugins ship their CSS.
		 *
		 * Colors lean on the shell's own theme variables where they exist and fall back
		 * to self-contained values, so the widget reads correctly in both themes.
		 */

		const TAG_ID = 'dsh-digital-human/overlay.css';

		const CSS = `
		.dh-root {
		  --dh-accent: #4c8dff;
		  --dh-surface: var(--dsw-specific-menu, rgba(28, 29, 32, 0.96));
		  --dh-label: var(--dsw-alias-label-primary, #f2f3f5);
		  --dh-label-soft: var(--dsw-alias-label-secondary, #a9adb6);
		  --dh-label-faint: var(--dsw-alias-label-tertiary, #7d838d);
		  --dh-border: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));
		  position: fixed;
		  right: 18px;
		  bottom: 18px;
		  z-index: 60;
		  display: flex;
		  flex-direction: column;
		  align-items: flex-end;
		  gap: 8px;
		  pointer-events: auto;
		  font-size: 13px;
		  line-height: 18px;
		  color: var(--dh-label);
		}
		.dh-root[data-face="offline"] { --dh-accent: #7a7f87; }
		.dh-root[data-face="idle"] { --dh-accent: #4c8dff; }
		.dh-root[data-face="thinking"] { --dh-accent: #7c6cff; }
		.dh-root[data-face="working"] { --dh-accent: #17b8a6; }
		.dh-root[data-face="waiting"] { --dh-accent: #f0a020; }
		.dh-root[data-face="error"] { --dh-accent: #f0524d; }
		.dh-root[data-face="done"] { --dh-accent: #35b96a; }

		.dh-bubble {
		  box-sizing: border-box;
		  max-width: 268px;
		  padding: 8px 12px;
		  border-radius: 14px 14px 4px 14px;
		  background: var(--dh-surface);
		  border: 1px solid var(--dh-border);
		  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
		  color: var(--dh-label);
		  animation: dh-pop 0.18s ease-out;
		  word-break: break-word;
		}
		.dh-bubble::after {
		  content: "";
		  display: block;
		  height: 2px;
		  margin-top: 6px;
		  border-radius: 2px;
		  background: var(--dh-accent);
		  opacity: 0.85;
		}

		.dh-face-wrap { position: relative; }
		.dh-face {
		  display: block;
		  padding: 0;
		  border: 0;
		  background: none;
		  cursor: pointer;
		  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.24));
		}
		.dh-face:focus-visible { outline: 2px solid var(--dh-accent); outline-offset: 3px; border-radius: 50%; }
		.dh-head { fill: var(--dh-surface); stroke: var(--dh-accent); stroke-width: 2; }
		.dh-eye { fill: var(--dh-accent); transform-box: fill-box; transform-origin: center; animation: dh-blink 5.4s infinite; }
		.dh-eye-stroke { fill: none; stroke: var(--dh-accent); stroke-width: 2.2; stroke-linecap: round; }
		.dh-mouth { fill: none; stroke: var(--dh-accent); stroke-width: 2.4; stroke-linecap: round; }
		.dh-mouth-open { fill: var(--dh-accent); stroke: none; }
		.dh-ring { fill: none; stroke: var(--dh-accent); stroke-width: 2; opacity: 0.45; stroke-dasharray: 22 12; transform-origin: 32px 36px; }
		.dh-antenna { stroke: var(--dh-accent); stroke-width: 2; }
		.dh-antenna-tip { fill: var(--dh-accent); animation: dh-pulse 2.2s ease-in-out infinite; }

		.dh-root[data-face="working"] .dh-ring { animation: dh-spin 2.6s linear infinite; opacity: 0.7; }
		.dh-root[data-face="thinking"] .dh-ring { animation: dh-spin 4.5s linear infinite; stroke-dasharray: 6 18; }
		.dh-root[data-face="waiting"] .dh-ring { animation: dh-pulse 1s ease-in-out infinite; opacity: 1; stroke-dasharray: none; }
		.dh-root[data-face="waiting"] .dh-face { animation: dh-hop 1.1s ease-in-out infinite; }
		.dh-root[data-face="error"] .dh-face { animation: dh-shake 2.6s ease-in-out infinite; }
		.dh-root[data-face="done"] .dh-antenna-tip { animation: dh-pulse 0.7s ease-in-out infinite; }

		.dh-badge {
		  position: absolute;
		  top: -2px;
		  right: -2px;
		  min-width: 18px;
		  height: 18px;
		  padding: 0 5px;
		  border-radius: 9px;
		  background: #f0a020;
		  color: #1b1c1f;
		  font-size: 11px;
		  font-weight: 600;
		  line-height: 18px;
		  text-align: center;
		  box-shadow: 0 0 0 2px var(--dh-surface);
		}

		.dh-panel {
		  box-sizing: border-box;
		  width: 328px;
		  max-width: calc(100vw - 36px);
		  max-height: min(60vh, 520px);
		  overflow: auto;
		  padding: 12px;
		  border-radius: 16px;
		  background: var(--dh-surface);
		  border: 1px solid var(--dh-border);
		  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
		  animation: dh-pop 0.16s ease-out;
		  display: flex;
		  flex-direction: column;
		  gap: 10px;
		}
		.dh-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.dh-title { font-weight: 600; }
		.dh-icon-btn {
		  border: 1px solid var(--dh-border);
		  background: transparent;
		  color: var(--dh-label-soft);
		  border-radius: 8px;
		  padding: 2px 8px;
		  font-size: 12px;
		  line-height: 18px;
		  cursor: pointer;
		}
		.dh-icon-btn:hover { color: var(--dh-label); border-color: var(--dh-accent); }
		.dh-section { display: flex; flex-direction: column; gap: 6px; }
		.dh-section-title { color: var(--dh-label-faint); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
		.dh-empty { color: var(--dh-label-faint); }
		.dh-row { display: flex; align-items: center; gap: 8px; min-height: 22px; }
		.dh-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dh-label-faint); }
		.dh-dot[data-state="ongoing"] { background: #17b8a6; animation: dh-pulse 1.6s ease-in-out infinite; }
		.dh-dot[data-state="done"] { background: #35b96a; }
		.dh-dot[data-state="warning"] { background: #f0a020; }
		.dh-dot[data-state="error"] { background: #f0524d; }
		.dh-kind {
		  flex: none;
		  padding: 0 6px;
		  border-radius: 5px;
		  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, 0.08));
		  color: var(--dh-label-soft);
		  font-size: 11px;
		}
		.dh-label {
		  flex: 1;
		  min-width: 0;
		  overflow: hidden;
		  text-overflow: ellipsis;
		  white-space: nowrap;
		  font-family: var(--dsw-font-mono, ui-monospace, monospace);
		  font-size: 12px;
		}
		.dh-meta { flex: none; color: var(--dh-label-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
		.dh-current { display: flex; align-items: center; gap: 6px; }
		.dh-err { color: #f0524d; word-break: break-word; font-size: 12px; }

		.dh-approval {
		  display: flex;
		  flex-direction: column;
		  gap: 8px;
		  padding: 10px;
		  border-radius: 12px;
		  border: 1px solid rgba(240, 160, 32, 0.55);
		  background: rgba(240, 160, 32, 0.12);
		}
		.dh-approval-title { font-weight: 600; color: #f0a020; }
		.dh-approval-tool { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
		.dh-approval-reason { color: var(--dh-label-soft); font-size: 12px; word-break: break-word; }
		.dh-actions { display: flex; gap: 8px; }
		.dh-btn {
		  flex: 1;
		  padding: 6px 10px;
		  border-radius: 9px;
		  border: 1px solid var(--dh-border);
		  background: transparent;
		  color: var(--dh-label);
		  font-size: 12px;
		  line-height: 18px;
		  cursor: pointer;
		}
		.dh-btn-allow { border-color: rgba(53, 185, 106, 0.6); background: rgba(53, 185, 106, 0.16); color: #35b96a; font-weight: 600; }
		.dh-btn-allow:hover { background: rgba(53, 185, 106, 0.26); }
		.dh-btn-reject { border-color: rgba(240, 82, 77, 0.55); background: rgba(240, 82, 77, 0.12); color: #f0524d; }
		.dh-btn-reject:hover { background: rgba(240, 82, 77, 0.22); }
		.dh-foot { color: var(--dh-label-faint); font-size: 11px; }

		@keyframes dh-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
		@keyframes dh-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
		@keyframes dh-spin { to { transform: rotate(360deg); } }
		@keyframes dh-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
		@keyframes dh-hop { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
		@keyframes dh-shake { 0%, 100% { transform: translateX(0); } 12% { transform: translateX(-2px); } 24% { transform: translateX(2px); } 36% { transform: translateX(0); } }

		@media (prefers-reduced-motion: reduce) {
		  .dh-root .dh-face, .dh-root .dh-ring, .dh-root .dh-eye, .dh-root .dh-antenna-tip, .dh-root .dh-dot { animation: none !important; }
		}
		`;

		/** Inject the plugin stylesheet once per page. */
		function ensureStyles() {
		  if (typeof document === 'undefined') return;
		  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return;
		  const tag = document.createElement('style');
		  tag.dataset.plugin = 'dsh-digital-human';
		  tag.dataset.pluginCss = TAG_ID;
		  tag.textContent = CSS;
		  document.head.appendChild(tag);
		}

		module.exports = { CSS, TAG_ID, ensureStyles };

		});
		module.exports = __require("./plugin.js");
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
