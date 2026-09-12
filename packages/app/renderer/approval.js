/**
 * The permission card: the first pending approval, rendered as an alert dialog.
 *
 * The card never invents a decision — it forwards one and then waits for the
 * next snapshot to remove it, so the UI can never claim an outcome the host did
 * not confirm.
 */
import { t } from './locales.js';

/** How much of one `args` value is shown before it is cut. */
const ARGS_LIMIT = 400;

/** Countdown refresh period; the deadline is also recomputed per snapshot. */
const TICK_MS = 250;

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

/** Pretty-print one argument value, or `undefined` when there is nothing. */
function formatValue(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Render the `args` payload as a single capped text block.
 * @param args - the approval's `args` value, whatever shape it has.
 * @returns `undefined` when there is nothing worth showing.
 */
export function formatArgs(args) {
  if (args === undefined || args === null) return undefined;
  if (typeof args !== 'object') return String(args);
  const entries = Object.entries(args);
  let text;
  if (entries.length === 0) return undefined;
  if (entries.length === 1) {
    // One argument is by far the common case: show the value, not the wrapper.
    text = formatValue(entries[0][1]);
  } else {
    text = entries
      .map(([name, value]) => `${name}: ${formatValue(value) ?? 'undefined'}`)
      .join('\n\n');
  }
  if (text === undefined) return undefined;
  if (text.length > ARGS_LIMIT) return `${text.slice(0, ARGS_LIMIT)}${t('util.truncated')}`;
  return text;
}

/** `remainingMs` as whole seconds for the countdown line. */
function secondsLeft(remainingMs) {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs)) return null;
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/**
 * Create the permission card.
 * @param options - `{ onDecide }`, called as `onDecide(approvalId, decision)`.
 * @returns `{ el, update }`; `update(snapshot)` renders or hides the card.
 */
export function createApprovalCard(options = {}) {
  const onDecide = options.onDecide;
  const onError = options.onError;

  let card = null;
  let remainingMs = null;
  let submittedId = null;
  let timer = null;

  const toolText = h('span', { class: 'dh-approval-tool-text' });
  const reasonText = h('span', { class: 'dh-approval-reason-text' });
  const argsText = h('pre', { class: 'dh-approval-args-text' });
  const countdown = h('span', { class: 'dh-approval-countdown' });
  const more = h('p', { class: 'dh-approval-more', attrs: { hidden: '' } });
  const status = h('p', { class: 'dh-approval-status', attrs: { hidden: '' } });
  const reasonRow = h(
    'p',
    { class: 'dh-approval-reason' },
    h('span', { class: 'dh-approval-label', text: t('approval.reason') }),
    reasonText,
  );
  const argsBox = h(
    'div',
    { class: 'dh-approval-args' },
    h('span', { class: 'dh-approval-label', text: t('approval.args') }),
    argsText,
  );
  const allowButton = h('button', {
    class: 'dh-btn dh-btn-allow',
    text: t('approval.allow'),
    attrs: { type: 'button', 'aria-label': t('approval.allow') },
  });
  const rejectButton = h('button', {
    class: 'dh-btn dh-btn-reject',
    text: t('approval.reject'),
    attrs: { type: 'button', 'aria-label': t('approval.reject') },
  });

  const el = h(
    'section',
    {
      class: 'dh-approval',
      attrs: { role: 'alertdialog', 'aria-live': 'assertive', 'aria-labelledby': 'dh-approval-title', tabindex: '-1' },
    },
    h(
      'header',
      { class: 'dh-approval-head' },
      h('h2', { class: 'dh-approval-title', text: t('approval.title'), attrs: { id: 'dh-approval-title' } }),
      countdown,
    ),
    h(
      'p',
      { class: 'dh-approval-tool' },
      h('span', { class: 'dh-approval-label', text: t('approval.tool') }),
      toolText,
    ),
    reasonRow,
    argsBox,
    more,
    h('div', { class: 'dh-actions' }, allowButton, rejectButton),
    status,
  );

  /** Paint the countdown from the last known `remainingMs`. */
  function paintCountdown() {
    const seconds = secondsLeft(remainingMs);
    countdown.textContent = seconds === null ? t('approval.noDeadline') : t('approval.countdown', { seconds });
  }

  /** Stop the local countdown. */
  function stopTimer() {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
  }

  /** Freeze both buttons once a decision has been submitted. */
  function setLocked(locked) {
    allowButton.disabled = locked;
    rejectButton.disabled = locked;
    el.setAttribute('aria-busy', String(locked));
    status.hidden = !locked;
    status.textContent = locked ? t('approval.pending') : '';
  }

  /** Forward one decision; the card only disappears on the next snapshot. */
  function decide(decision) {
    if (card === null || submittedId === card.approvalId) return;
    submittedId = card.approvalId;
    setLocked(true);
    Promise.resolve()
      .then(() => onDecide?.(card.approvalId, decision))
      .catch((error) => {
        // A failed decision re-opens the card: the request is still pending.
        submittedId = null;
        setLocked(false);
        onError?.(error);
      });
  }

  allowButton.addEventListener('click', () => {
    decide('allow-once');
  });
  rejectButton.addEventListener('click', () => {
    decide('reject');
  });

  /**
   * Render the first pending approval, or hide the card when there is none.
   * @param snapshot - the projected snapshot from `window.digitalHuman`.
   */
  function update(snapshot) {
    const approvals = Array.isArray(snapshot?.approvals) ? snapshot.approvals : [];
    const next = approvals[0] ?? null;

    if (next === null) {
      card = null;
      remainingMs = null;
      submittedId = null;
      stopTimer();
      el.hidden = true;
      return;
    }

    if (card === null || card.approvalId !== next.approvalId) {
      card = next;
      submittedId = null;
      setLocked(false);
      toolText.textContent = typeof next.toolName === 'string' && next.toolName !== '' ? next.toolName : '—';
      const reason = typeof next.reason === 'string' ? next.reason.trim() : '';
      reasonRow.hidden = reason === '';
      reasonText.textContent = reason;
      const args = formatArgs(next.args);
      argsBox.hidden = args === undefined;
      argsText.textContent = args ?? '';
    }
    const wasHidden = el.hidden;
    el.hidden = false;
    // A new card must interrupt: move focus onto the alert so a keyboard user
    // is not left typing into the composer behind it.
    if (wasHidden) el.focus?.();

    remainingMs = typeof next.remainingMs === 'number' ? next.remainingMs : null;
    if (card.approvalId === submittedId) setLocked(true);
    const extra = approvals.length - 1;
    more.hidden = extra <= 0;
    more.textContent = extra > 0 ? t('approval.more', { count: extra }) : '';
    paintCountdown();
    if (remainingMs === null) {
      stopTimer();
    } else if (timer === null) {
      timer = window.setInterval(() => {
        if (remainingMs === null) return;
        remainingMs = Math.max(0, remainingMs - TICK_MS);
        paintCountdown();
      }, TICK_MS);
    }
  }

  return { el, update };
}
