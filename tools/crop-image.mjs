#!/usr/bin/env node
/**
 * Crop (and optionally upscale) a region of an image.
 *
 * Reviewing a screenshot of the app means looking at one window, not the whole
 * desktop; `sharp` is resolved from the harness so the workspace stays
 * dependency-free.
 *
 * Usage:
 *   node tools/crop-image.mjs <in.png> <out.png> <x,y,w,h> [--scale 2]
 */
import { existsSync, writeFileSync } from 'node:fs';
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
  throw new Error('crop-image: sharp is not resolvable');
}

const [input, output, rect] = process.argv.slice(2);
if (input === undefined || output === undefined || rect === undefined) {
  process.stderr.write('usage: node tools/crop-image.mjs <in.png> <out.png> <x,y,w,h> [--scale n]\n');
  process.exit(2);
}
const scaleIndex = process.argv.indexOf('--scale');
const scale = scaleIndex >= 0 ? Number(process.argv[scaleIndex + 1]) : 1;
const [x, y, w, h] = rect.split(',').map(Number);
if ([x, y, w, h].some((value) => !Number.isFinite(value))) {
  process.stderr.write('crop-image: rect must be x,y,w,h\n');
  process.exit(2);
}

const sharp = resolveSharp();
const meta = await sharp(input).metadata();
const left = Math.max(0, Math.min(x, meta.width - 1));
const top = Math.max(0, Math.min(y, meta.height - 1));
const width = Math.min(w, meta.width - left);
const height = Math.min(h, meta.height - top);
let pipeline = sharp(input).extract({ left, top, width, height });
if (scale !== 1) pipeline = pipeline.resize({ width: Math.round(width * scale), kernel: 'nearest' });
const buffer = await pipeline.png().toBuffer();
writeFileSync(output, buffer);
process.stdout.write(`crop-image: ${input} [${String(left)},${String(top)} ${String(width)}x${String(height)}] -> ${output} (${String(buffer.length)} bytes)\n`);
