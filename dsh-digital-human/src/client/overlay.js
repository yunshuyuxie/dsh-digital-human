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
