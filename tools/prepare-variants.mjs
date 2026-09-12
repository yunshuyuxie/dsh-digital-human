#!/usr/bin/env node
/**
 * Normalize expression variants against a reference avatar.
 *
 * Generated variants drift a little in framing and scale. Cross-fading between
 * them only looks right if the character sits in exactly the same place, so this
 * scales each variant so its silhouette height matches the reference's and then
 * translates it so the silhouette centres coincide, emitting every variant on
 * the reference's canvas.
 *
 * Variants are expected to be already cut out (run tools/cutout.mjs first); this
 * tool only aligns.
 *
 * Usage:
 *   node tools/prepare-variants.mjs --reference <base.png> --out <dir> <variant.png>...
 *
 * Prints the bounding box it measured for each input so alignment can be
 * verified from the log.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { delimiter } from 'node:path';
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
  throw new Error('prepare-variants: sharp is not resolvable');
}

/** Parse `--flag value` pairs and the trailing positional list. */
function parseArgs(argv) {
  const args = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--reference') args.reference = argv[++index];
    else if (argv[index] === '--out') args.out = argv[++index];
    else if (argv[index] === '--alpha-threshold') args.alphaThreshold = Number(argv[++index]);
    else if (argv[index] === '--sheet') args.sheet = argv[++index];
    else if (argv[index] === '--cell-size') args.cellSize = Number(argv[++index]);
    else if (argv[index] === '--export-out') args.exportOut = argv[++index];
    else if (argv[index] === '--export-width') args.exportWidth = Number(argv[++index]);
    else args.positional.push(argv[index]);
  }
  return args;
}

/** Bounding box of pixels whose alpha clears the threshold. */
async function alphaBox(sharp, file, threshold) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) throw new Error(`${file}: no opaque pixels found`);
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1, canvasWidth: width, canvasHeight: height };
}

const args = parseArgs(process.argv.slice(2));
if (args.reference === undefined || args.positional.length === 0) {
  process.stderr.write('usage: node tools/prepare-variants.mjs --reference <base.png> [--out <dir>] <variant.png>...\n');
  process.exit(2);
}

const sharp = resolveSharp();
const threshold = args.alphaThreshold ?? 8;
const reference = await alphaBox(sharp, args.reference, threshold);
const referenceCenterX = reference.minX + reference.width / 2;
const referenceCenterY = reference.minY + reference.height / 2;
const outDir = args.out ?? join(dirname(args.reference), 'variants');
mkdirSync(outDir, { recursive: true });
console.log(
  `prepare-variants: reference ${basename(args.reference)} canvas ${String(reference.canvasWidth)}x${String(reference.canvasHeight)} subject ${String(reference.width)}x${String(reference.height)}`,
);

const aligned = [];

for (const file of args.positional) {
  const box = await alphaBox(sharp, file, threshold);
  const cropped = await sharp(file).ensureAlpha().extract({
    left: box.minX,
    top: box.minY,
    width: box.width,
    height: box.height,
  }).png().toBuffer();

  // Match the reference subject height, keeping the variant's own aspect ratio.
  const scaled = await sharp(cropped).resize({ height: reference.height }).png().toBuffer();
  const scaledMeta = await sharp(scaled).metadata();
  const left = Math.round(referenceCenterX - scaledMeta.width / 2);
  const top = Math.round(referenceCenterY - scaledMeta.height / 2);

  const target = join(outDir, basename(file));
  const canvas = await sharp({
    create: {
      width: reference.canvasWidth,
      height: reference.canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: scaled, left: Math.max(0, left), top: Math.max(0, top) }]).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(target, canvas);
  aligned.push({ name: basename(file).replace(/\.[^.]+$/u, ''), buffer: canvas });
  console.log(
    `prepare-variants: ${basename(file)} subject ${String(box.width)}x${String(box.height)} -> ${String(scaledMeta.width)}x${String(scaledMeta.height)} at ${String(Math.max(0, left))},${String(Math.max(0, top))} => ${target}`,
  );
}

// Shipping copy: the aligned PNGs are the source of truth (lossless, reviewable),
// while the app loads a smaller alpha-capable export.
if (args.exportOut !== undefined && aligned.length > 0) {
  mkdirSync(args.exportOut, { recursive: true });
  const exportWidth = args.exportWidth ?? 420;
  for (const entry of aligned) {
    const buffer = await sharp(entry.buffer).resize({ width: exportWidth }).webp({ quality: 92, alphaQuality: 100 }).toBuffer();
    writeFileSync(join(args.exportOut, `${entry.name}.webp`), buffer);
    console.log(`prepare-variants: export ${entry.name}.webp ${String(buffer.length)} bytes`);
  }
}

// A contact sheet is how a variant set gets reviewed in one look instead of N.
if (args.sheet !== undefined && aligned.length > 0) {
  const cell = args.cellSize ?? 300;
  const gap = 14;
  const label = 26;
  const cells = [];
  for (const entry of aligned) {
    cells.push(await sharp(entry.buffer).resize({ height: cell, fit: 'inside' }).png().toBuffer());
  }
  const metas = await Promise.all(cells.map((buffer) => sharp(buffer).metadata()));
  const width = metas.reduce((sum, meta) => sum + meta.width, 0) + gap * (cells.length + 1);
  const height = cell + label + gap * 2;
  const labels = aligned
    .map((entry, index) => {
      const x = gap + metas.slice(0, index).reduce((sum, meta) => sum + meta.width + gap, 0) + metas[index].width / 2;
      return `<text x="${String(x)}" y="${String(height - 10)}" fill="#9FE3F0" font-family="Segoe UI, sans-serif" font-size="17" text-anchor="middle">${entry.name}</text>`;
    })
    .join('');
  const placements = [];
  let cursor = gap;
  for (let index = 0; index < cells.length; index += 1) {
    placements.push({ input: cells[index], left: cursor, top: gap });
    cursor += metas[index].width + gap;
  }
  const sheet = await sharp({
    create: { width, height, channels: 4, background: { r: 0x14, g: 0x16, b: 0x1c, alpha: 1 } },
  })
    .composite([
      ...placements,
      { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">${labels}</svg>`), left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(args.sheet, sheet);
  const meta = await sharp(sheet).metadata();
  console.log(`prepare-variants: sheet ${String(meta.width)}x${String(meta.height)} => ${args.sheet}`);
}
