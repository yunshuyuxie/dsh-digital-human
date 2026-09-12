/**
 * The avatar: seven stacked face images, an aura ring, and per-state effects.
 *
 * Every visual difference between states is expressed with `data-face` on the
 * root element; the CSS in `styles.css` owns all color, motion, and effect
 * rules. This module only builds the static DOM and reports the current face.
 */
import { t } from './locales.js';

/** The seven faces, in the state machine's priority order. */
export const FACES = ['offline', 'idle', 'thinking', 'working', 'waiting', 'error', 'done'];

/** Where one face image lives, resolved relative to `index.html`. */
function faceSrc(face) {
  return `../assets/avatar/states-app/${face}.webp`;
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

/** Build a namespaced SVG element. */
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  for (const child of children) el.append(child);
  return el;
}

/** The aura ring plus the two effect rings drawn behind the face. */
function buildRings() {
  const aura = svg('circle', { class: 'dh-aura', cx: 50, cy: 50, r: 40 });
  const progress = svg('circle', { class: 'dh-progress', cx: 50, cy: 50, r: 46 });
  const ring = svg(
    'svg',
    { class: 'dh-rings', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' },
    progress,
    aura,
  );
  return ring;
}

/** The stacked face images. */
function buildFaces() {
  const wrap = h('div', { class: 'dh-faces' });
  for (const face of FACES) {
    const img = h('img', {
      class: 'dh-face',
      attrs: {
        src: faceSrc(face),
        alt: '',
        draggable: 'false',
        decoding: 'async',
        'data-face': face,
      },
    });
    img.dataset.face = face;
    wrap.append(img);
  }
  return wrap;
}

/** The effect layer: every effect exists at all times, CSS shows one. */
function buildEffects() {
  const dots = h('div', { class: 'dh-dots' });
  for (let index = 0; index < 3; index += 1) dots.append(h('span', { class: 'dh-dot' }));

  const badge = h('div', {
    class: 'dh-badge',
    text: '!',
    attrs: { 'aria-hidden': 'true' },
  });

  const sweat = h('div', {
    class: 'dh-sweat',
    attrs: { 'aria-hidden': 'true' },
  });

  const sparkles = h('div', { class: 'dh-sparkles', attrs: { 'aria-hidden': 'true' } });
  for (let index = 0; index < 3; index += 1) sparkles.append(h('span', { class: 'dh-sparkle' }));

  const effects = h('div', { class: 'dh-effects', attrs: { 'aria-hidden': 'true' } }, dots, badge, sweat, sparkles);
  effects.dataset.face = 'idle';
  return effects;
}

/**
 * Create the avatar element.
 * @returns `{ el, update, face }`, where `update(face)` re-points the cross-fade.
 */
export function createAvatar() {
  const faces = buildFaces();
  const effects = buildEffects();
  const stage = h('div', { class: 'dh-stage' }, buildRings(), faces, effects);
  const el = h('div', {
    class: 'dh-avatar',
    attrs: { role: 'img', 'aria-label': t('avatar.label.offline') },
  }, stage);

  el.dataset.face = 'offline';

  let current = 'offline';

  /**
   * Point the cross-fade at one face.
   * @param face - one of {@link FACES}; anything else falls back to `offline`.
   */
  function update(face) {
    const next = FACES.includes(face) ? face : 'offline';
    if (next === current) return;
    current = next;
    el.dataset.face = next;
    el.setAttribute('aria-label', t(`avatar.label.${next}`));
  }

  return { el, update, face: () => current };
}
