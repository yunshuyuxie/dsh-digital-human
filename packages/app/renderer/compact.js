/**
 * The compact (avatar-only) form.
 *
 * The compact window is about 200x220: it shows the avatar and nothing else,
 * plus one thing that must never be hidden — a pending approval, which appears
 * as an amber strip under the avatar and hands the user over to the full panel.
 *
 * The avatar element is created by `app.js` and handed in here, so the compact
 * and expanded forms share one live avatar and never fight over its face.
 */
import { t } from './locales.js';

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

/**
 * Run one optional callback, turning a throw or a rejected promise into
 * `onError` instead of an unhandled rejection.
 *
 * @param action - the call, or `undefined` when the host lacks the method.
 * @param onError - called with whatever was thrown.
 */
function attempt(action, onError) {
  if (typeof action !== 'function') return;
  try {
    Promise.resolve()
      .then(() => action())
      .catch((error) => {
        onError?.(error);
      });
  } catch (error) {
    onError?.(error);
  }
}

/**
 * Create the compact body.
 *
 * @param options - `{ avatar, onExpand, onError }`, where `avatar` is the
 *   element returned by `createAvatar()` and `onExpand()` asks for the panel.
 * @returns `{ el, update, approvals }`; `update(snapshot)` renders the strip.
 */
export function createCompact(options = {}) {
  const onError = options.onError;

  /** The last rendered approval count, so an unchanged strip is left alone. */
  let approvals = 0;

  const stripText = h('span', { class: 'dh-compact-strip-text' });
  const processButton = h('button', {
    class: 'dh-btn dh-compact-process',
    text: t('view.compact.process'),
    attrs: { type: 'button', 'aria-label': t('view.compact.process') },
  });

  const strip = h(
    'div',
    {
      class: 'dh-compact-strip',
      attrs: { role: 'status', 'aria-live': 'polite', hidden: '' },
    },
    stripText,
    processButton,
  );

  // The avatar is a real button: clicking it expands, and the keyboard gets the
  // same action for free.
  const avatarButton = h('button', {
    class: 'dh-compact-avatar',
    attrs: { type: 'button', 'aria-label': t('view.compact.expand') },
  });
  if (options.avatar !== undefined && options.avatar !== null) avatarButton.append(options.avatar);

  const el = h('div', { class: 'dh-compact' }, avatarButton, strip);


  const expand = () => {
    attempt(options.onExpand, onError);
  };

  avatarButton.addEventListener('click', () => {
    expand();
  });
  processButton.addEventListener('click', () => {
    expand();
  });

  /**
   * Render one snapshot: only the approval strip changes here — the avatar is
   * driven by `avatar.update(face)`, which `app.js` calls on the same snapshot.
   *
   * @param snapshot - the projected snapshot from `window.digitalHuman`.
   */
  function update(snapshot) {
    const list = Array.isArray(snapshot?.approvals) ? snapshot.approvals : [];
    const count = list.length;
    if (count === approvals) return;
    approvals = count;
    strip.hidden = count === 0;
    if (count === 0) return;
    stripText.textContent = t('view.compact.pending', { count });
  }

  return { el, update, approvals: () => approvals, button: avatarButton };
}
