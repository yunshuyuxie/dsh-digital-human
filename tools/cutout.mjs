#!/usr/bin/env node
/**
 * Cut a character out of a flat-background render.
 *
 * A desktop avatar needs a transparent, trimmed image. Backgrounds of generated
 * renders are smooth light gradients, so a per-step flood fill from the image
 * border separates them from the subject far better than a global colour key
 * (which would also eat white clothing).
 *
 * Also handles the other two chores of preparing such an asset: clearing
 * watermark rectangles, and trimming the transparent margin.
 *
 * Usage:
 *   node tools/cutout.mjs <in.png> <out.png> [options]
 *
 * Options:
 *   --tolerance <n>     per-step colour distance accepted as background (default 14)
 *   --feather <n>       alpha blur radius in pixels (default 1.2)
 *   --trim              crop to the subject's bounding box
 *   --clear x,y,w,h     force alpha to 0 in a rectangle (repeatable; watermarks)
 *   --pad <n>           transparent pixels to keep when trimming (default 4)
 *   --max <n>           downscale the longer side to this many pixels
 *
 * `sharp` is resolved from the installed harness, so the workspace stays
 * dependency-free.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve sharp from the harness install or a local node_modules. */
function resolveSharp() {
  const candidates = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const shim of ['dsh.ps1', 'dsh.cmd', 'dsh.bat', 'dsh']) {
      if (!existsSync(join(dir, shim))) continue;
      candidates.push(join(dirname(dir), 'sharp'));
      break;
    }
  }
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'sharp'));
  for (const candidate of candidates) {
    try {
      return createRequire(join(candidate, 'noop.js'))('sharp');
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('cutout: sharp is not resolvable; install it or run inside a harness checkout');
}

/** Parse the flag family this tool owns. */
function parseArgs(argv) {
  const args = { tolerance: 14, feather: 1.2, pad: 4, seal: 1, clears: [], positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--tolerance') args.tolerance = Number(argv[++index]);
    else if (flag === '--feather') args.feather = Number(argv[++index]);
    else if (flag === '--pad') args.pad = Number(argv[++index]);
    else if (flag === '--max') args.max = Number(argv[++index]);
    else if (flag === '--trim') args.trim = true;
    else if (flag === '--flatten') args.flatten = argv[++index];
    else if (flag === '--seal') args.seal = Number(argv[++index]);
    else if (flag === '--protect-chroma') args.protectChroma = Number(argv[++index]);
    else if (flag === '--tolerance2') args.tolerance2 = Number(argv[++index]);
    else if (flag === '--fade-bottom') args.fadeBottom = Number(argv[++index]);
    else if (flag === '--keep-debris') args.despeckle = false;
    else if (flag === '--clear') {
      const [x, y, w, h] = argv[++index].split(',').map(Number);
      args.clears.push({ x, y, w, h });
    } else args.positional.push(flag);
  }
  return args;
}

/** Squared RGB distance, to avoid a square root per neighbour. */
function distanceSquared(data, a, b) {
  const dr = data[a] - data[b];
  const dg = data[a + 1] - data[b + 1];
  const db = data[a + 2] - data[b + 2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Chroma of one pixel: max channel minus min channel.
 *
 * A generated render's backdrop is neutral grey while its glows and props are
 * tinted, so chroma is what tells "still background" from "already the
 * subject's soft glow" when brightness alone cannot.
 */
function chroma(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Separable box blur over one channel, used to feather the cut edge. */
function blurAlpha(alpha, width, height, radius) {
  if (radius <= 0) return alpha;
  const size = Math.max(1, Math.round(radius * 2 + 1));
  const half = Math.floor(size / 2);
  const horizontal = new Float32Array(width * height);
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -half; x <= half; x += 1) sum += alpha[y * width + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / size;
      const out = Math.min(width - 1, Math.max(0, x - half));
      const incoming = Math.min(width - 1, Math.max(0, x + half + 1));
      sum += alpha[y * width + incoming] - alpha[y * width + out];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -half; y <= half; y += 1) sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / size;
      const out = Math.min(height - 1, Math.max(0, y - half));
      const incoming = Math.min(height - 1, Math.max(0, y + half + 1));
      sum += horizontal[incoming * width + x] - horizontal[out * width + x];
    }
  }
  return output;
}

const args = parseArgs(process.argv.slice(2));
const [input, output] = args.positional;
if (input === undefined || output === undefined) {
  process.stderr.write('usage: node tools/cutout.mjs <in.png> <out.png> [--tolerance n] [--feather n] [--trim] [--clear x,y,w,h] [--max n]\n');
  process.exit(2);
}

const sharp = resolveSharp();
let pipeline = sharp(input).ensureAlpha();
if (args.max !== undefined) pipeline = pipeline.resize({ width: args.max, height: args.max, fit: 'inside' });
const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
const limit = args.tolerance * args.tolerance;
// 0 disables the guard; a positive value keeps tinted glows inside the subject.
const protectChroma = args.protectChroma ?? 0;

// Region-grow the background from the border: each step compares a candidate to
// the pixel it grew from, so smooth gradients are followed instead of keyed out.
const background = new Uint8Array(width * height);
const stack = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = y * width + x;
  if (background[index] === 1) return;
  stack.push(index);
};
for (let x = 0; x < width; x += 1) {
  push(x, 0);
  push(x, height - 1);
}
for (let y = 0; y < height; y += 1) {
  push(0, y);
  push(width - 1, y);
}
while (stack.length > 0) {
  const index = stack.pop();
  if (background[index] === 1) continue;
  background[index] = 1;
  const x = index % width;
  const y = (index - x) / width;
  const offset = index * channels;
  const neighbours = [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
  for (const [nx, ny] of neighbours) {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const neighbourIndex = ny * width + nx;
    if (background[neighbourIndex] === 1) continue;
    // Never grow across a tinted pixel: the subject's own glow is brighter than
    // the backdrop, so brightness alone would let the fill tunnel through it and
    // amputate whatever the glow touches.
    if (protectChroma > 0 && chroma(data, neighbourIndex * channels) > protectChroma) continue;
    if (distanceSquared(data, neighbourIndex * channels, offset) <= limit) stack.push(neighbourIndex);
  }
}

// A soft contact shadow has a steep local gradient, so one pass stops at its
// edge. Re-growing from the already-keyed region with a looser limit removes it
// without ever letting the first pass touch the subject.
if (args.tolerance2 !== undefined && args.tolerance2 > args.tolerance) {
  const loose = args.tolerance2 * args.tolerance2;
  const stack2 = [];
  const seed2 = (x, y) => {
    const index = y * width + x;
    if (background[index] === 1) stack2.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    seed2(x, 0);
    seed2(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    seed2(0, y);
    seed2(width - 1, y);
  }
  while (stack2.length > 0) {
    const index = stack2.pop();
    const x = index % width;
    const y = (index - x) / width;
    const offset = index * channels;
    const neighbours = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbourIndex = ny * width + nx;
      if (background[neighbourIndex] === 1) continue;
      if (protectChroma > 0 && chroma(data, neighbourIndex * channels) > protectChroma) continue;
      if (distanceSquared(data, neighbourIndex * channels, offset) <= loose) {
        background[neighbourIndex] = 1;
        stack2.push(neighbourIndex);
      }
    }
  }
  // alpha is derived from the final background mask just below.
}

const alpha = new Float32Array(width * height);
for (let index = 0; index < width * height; index += 1) alpha[index] = background[index] === 1 ? 0 : 1;

/**
 * Drop opaque components smaller than `minSize`.
 *
 * Soft glows and floating props leave speckles once the background is keyed,
 * but a limb connected only through a glow can also end up as its own
 * component — so the filter drops debris by size instead of keeping a single
 * blob, which would amputate that limb.
 */
function dropSmallComponents(mask, minSize) {
  if (minSize <= 0) return 0;
  const seen = new Uint8Array(width * height);
  const stack = [];
  let removed = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    const component = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop();
      component.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbours) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (mask[neighbour] === 0 || seen[neighbour] === 1) continue;
        seen[neighbour] = 1;
        stack.push(neighbour);
      }
    }
    if (component.length >= minSize) continue;
    for (const index of component) mask[index] = 0;
    removed += component.length;
  }
  return removed;
}

/** Fill transparent pixels unreachable from the border: the subject's inner holes. */
function fillEnclosedHoles(mask) {
  const reachable = new Uint8Array(width * height);
  const stack = [];
  const seed = (x, y) => {
    const index = y * width + x;
    if (reachable[index] === 1 || mask[index] === 1) return;
    reachable[index] = 1;
    stack.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    seed(0, y);
    seed(width - 1, y);
  }
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    const neighbours = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      seed(nx, ny);
    }
  }
  let filled = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0 && reachable[index] === 0) {
      mask[index] = 1;
      filled += 1;
    }
  }
  return filled;
}

/** Morphological close on the opaque mask, sealing thin see-through gaps. */
function sealMask(mask, radius) {
  if (radius <= 0) return;
  const dilate = (input, output) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let on = 0;
        for (let dy = -radius; dy <= radius && on === 0; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (input[ny * width + nx] === 1) {
              on = 1;
              break;
            }
          }
        }
        output[y * width + x] = on;
      }
    }
  };
  const grown = new Uint8Array(width * height);
  const shrunk = new Uint8Array(width * height);
  dilate(mask, grown);
  // Erode the grown mask: a pixel survives only if its whole neighbourhood is set.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let all = 1;
      for (let dy = -radius; dy <= radius && all === 1; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (grown[ny * width + nx] === 0) {
            all = 0;
            break;
          }
        }
      }
      shrunk[y * width + x] = all;
    }
  }
  mask.set(shrunk);
}

const opaque = new Uint8Array(width * height);
for (let index = 0; index < opaque.length; index += 1) opaque[index] = alpha[index] > 0 ? 1 : 0;
// Debris is tiny; a limb cut loose by a keyed-out glow is not.
const minComponent = args.minComponent ?? Math.max(64, Math.round(width * height * 0.0005));
dropSmallComponents(opaque, minComponent);
fillEnclosedHoles(opaque);
sealMask(opaque, args.seal);
for (let index = 0; index < width * height; index += 1) alpha[index] = opaque[index] === 1 ? 1 : 0;

const feathered = blurAlpha(alpha, width, height, args.feather);

const out = Buffer.from(data);
for (let index = 0; index < width * height; index += 1) {
  out[index * channels + 3] = Math.round(Math.min(1, Math.max(0, feathered[index])) * 255);
}
for (const rect of args.clears) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) out[(y * width + x) * channels + 3] = 0;
}

// A render's contact shadow is contiguous with the subject, so a geometric clear
// would slice the feet off. Fading the subject's own lowest pixels instead keeps
// the silhouette whole while the shadow disappears smoothly.
if (args.fadeBottom !== undefined && args.fadeBottom > 0) {
  let lowest = -1;
  for (let y = height - 1; y >= 0 && lowest < 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      if (out[(y * width + x) * channels + 3] > 8) {
        lowest = y;
        break;
      }
    }
  }
  if (lowest > 0) {
    const band = Math.min(args.fadeBottom, lowest + 1);
    for (let y = lowest - band + 1; y <= lowest; y += 1) {
      const t = (lowest - y + 1) / band;
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * channels + 3;
        out[offset] = Math.round(out[offset] * t);
      }
    }
  }
}

let result = sharp(out, { raw: { width, height, channels } });
if (args.trim === true) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (out[(y * width + x) * channels + 3] < 8) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX > minX && maxY > minY) {
    const pad = args.pad;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    result = result.extract({
      left,
      top,
      width: Math.min(width - left, maxX - minX + 1 + pad * 2),
      height: Math.min(height - top, maxY - minY + 1 + pad * 2),
    });
  }
}

const buffer = await (args.flatten === undefined
  ? result.png({ compressionLevel: 9 })
  : result.flatten({ background: args.flatten }).png({ compressionLevel: 9 })
).toBuffer();
const { writeFileSync } = await import('node:fs');
writeFileSync(output, buffer);
const meta = await sharp(buffer).metadata();
let transparent = 0;
for (let index = 0; index < width * height; index += 1) if (background[index] === 1) transparent += 1;
process.stdout.write(
  `cutout: ${input} -> ${output} (${String(meta.width)}x${String(meta.height)}, ${String(Math.round((transparent / (width * height)) * 100))}% keyed, ${String(buffer.length)} bytes)\n`,
);
