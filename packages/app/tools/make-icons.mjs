#!/usr/bin/env node
/**
 * Derive the app and tray icons from the avatar's idle state.
 *
 * A tray icon is viewed at 16–32px, so it is cropped to the head rather than
 * shrunk from the full body. Run after replacing the avatar assets.
 *
 * Usage:
 *   node tools/make-icons.mjs [<state.png>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  throw new Error('make-icons: sharp is not resolvable');
}

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? join(appRoot, 'assets', 'avatar', 'states', 'idle.png');
if (!existsSync(source)) throw new Error(`make-icons: ${source} not found — run the avatar pipeline first`);

const sharp = resolveSharp();
const assets = join(appRoot, 'assets');
mkdirSync(assets, { recursive: true });
const meta = await sharp(source).metadata();

// The head occupies roughly the top 38% of the avatar canvas; crop it with a
// little margin so the tray glyph reads at 16px.
const headHeight = Math.round(meta.height * 0.38);
const headWidth = Math.min(meta.width, headHeight);
const headLeft = Math.round((meta.width - headWidth) / 2);
const head = await sharp(source)
  .extract({ left: headLeft, top: 0, width: headWidth, height: headHeight })
  .png()
  .toBuffer();

writeFileSync(join(assets, 'icon.png'), await sharp(head).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
writeFileSync(join(assets, 'tray.png'), await sharp(head).resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
process.stdout.write(`make-icons: wrote assets/icon.png and assets/tray.png from ${source}\n`);
