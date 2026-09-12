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
