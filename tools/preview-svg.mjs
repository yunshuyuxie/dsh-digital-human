#!/usr/bin/env node
/**
 * Rasterize an SVG so it can be reviewed as an image.
 *
 * Drawing an avatar blind is how you get an ugly avatar. This renders a vector
 * source to PNG so the author (or an agent) can look at the result and iterate.
 *
 * `sharp` is not a dependency of this workspace: it is resolved from the
 * installed harness when available, which keeps the repository dependency-free
 * while still allowing local previews.
 *
 * Usage:
 *   node tools/preview-svg.mjs <input.svg> <output.png> [width] [background]
 *
 * `background` accepts a CSS color (e.g. `#202124`) or `none` for transparency.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Search the PATH shims for the harness install, then its own node_modules. */
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
  throw new Error('preview-svg: sharp is not resolvable; install it or run inside a harness checkout');
}

/** Split `--face <state>` out of the positional arguments. */
function splitArgs(argv) {
  const positional = [];
  let face;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--face') {
      face = argv[index + 1];
      index += 1;
      continue;
    }
    positional.push(argv[index]);
  }
  return { positional, face };
}

const { positional, face } = splitArgs(process.argv.slice(2));
const [input, output, widthArg, background] = positional;
if (input === undefined || output === undefined) {
  process.stderr.write('usage: node tools/preview-svg.mjs <input.svg> <output.png> [width] [background] [--face <state>]\n');
  process.exit(2);
}

const sharp = resolveSharp();
const width = widthArg === undefined ? 512 : Number(widthArg);
// Previewing one state matters for an avatar: the seven faces are CSS-switched
// from a single `data-face` attribute on the root element.
let svg = readFileSync(input);
if (face !== undefined) {
  svg = Buffer.from(svg.toString('utf8').replace(/data-face="[^"]*"/u, `data-face="${face}"`), 'utf8');
}
const transparent = background === undefined || background === 'none';

let pipeline = sharp(svg, { density: 384 }).resize({ width });
pipeline = transparent
  ? pipeline.png({ compressionLevel: 9 })
  : pipeline.flatten({ background }).png({ compressionLevel: 9 });

const buffer = await pipeline.toBuffer();
writeFileSync(output, buffer);
process.stdout.write(`preview-svg: ${input} -> ${output} (${String(width)}px, ${String(buffer.length)} bytes)\n`);
