#!/usr/bin/env node
/**
 * Inline the shared protocol into every artifact that must be self-contained.
 *
 * The bridge plugin ships inside a profile the user installs offline, and the
 * Electron app ships as its own installer; neither can resolve a workspace
 * sibling at runtime. Both therefore carry a byte-identical copy of the
 * protocol under `src/vendor/protocol/`, produced here.
 *
 * The digest printed (and written into a packed CHECKSUMS.txt) is SHA-256 over
 * the concatenation of the copied files' bytes in file-name order — the same
 * definition `verify.ps1` recomputes on the installed copy.
 *
 * Usage:
 *   node tools/sync-protocol.mjs            # copy into every target
 *   node tools/sync-protocol.mjs --check    # fail if any target differs
 *   node tools/sync-protocol.mjs --json     # machine-readable result
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'packages', 'protocol', 'src');

/** Every artifact that must carry its own protocol copy. */
const TARGETS = [
  join(ROOT, 'packages', 'bridge', 'src', 'vendor', 'protocol'),
  join(ROOT, 'packages', 'app', 'src', 'vendor', 'protocol'),
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const asJson = args.includes('--json');

/** Files of the protocol source, in the digest's stable order. */
async function sourceFiles() {
  const names = (await readdir(SOURCE)).filter((name) => name.endsWith('.js')).sort();
  if (names.length === 0) throw new Error(`sync-protocol: no .js files under ${SOURCE}`);
  return names;
}

/** SHA-256 over concatenated bytes in name order. */
function digestOf(nameList, buffers) {
  const hash = createHash('sha256');
  for (const name of nameList) hash.update(buffers.get(name));
  return hash.digest('hex');
}

/** Read every source file once. */
async function readSources(names) {
  const buffers = new Map();
  for (const name of names) buffers.set(name, await readFile(join(SOURCE, name)));
  return buffers;
}

/** Compare one target directory against the source bytes. */
async function targetMatches(target, names, buffers) {
  try {
    const present = (await readdir(target)).filter((name) => name.endsWith('.js')).sort();
    if (present.length !== names.length) return false;
    for (const name of names) {
      if (present[names.indexOf(name)] !== name) return false;
      const bytes = await readFile(join(target, name));
      if (!bytes.equals(buffers.get(name))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const names = await sourceFiles();
const buffers = await readSources(names);
const digest = digestOf(names, buffers);
const results = [];

for (const target of TARGETS) {
  // A target whose package does not exist yet (a milestone not reached) is
  // reported and skipped rather than failing the check.
  const packageDir = dirname(dirname(dirname(target)));
  if (!existsSync(packageDir)) {
    results.push({ target: relative(ROOT, target), status: 'skipped' });
    continue;
  }
  const matches = await targetMatches(target, names, buffers);
  if (checkOnly) {
    results.push({ target: relative(ROOT, target), status: matches ? 'ok' : 'stale' });
    continue;
  }
  if (!matches) {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const name of names) await writeFile(join(target, name), buffers.get(name));
  }
  results.push({ target: relative(ROOT, target), status: matches ? 'ok' : 'written' });
}

const stale = results.filter((entry) => entry.status === 'stale');
if (asJson) {
  console.log(JSON.stringify({ digest, files: names, results }, null, 2));
} else {
  for (const entry of results) console.log(`sync-protocol: ${entry.status.padEnd(7)} ${entry.target}`);
  console.log(`sync-protocol: ${names.length} files, digest ${digest}`);
  if (checkOnly) {
    console.log(stale.length === 0
      ? 'sync-protocol: OK'
      : `sync-protocol: ${String(stale.length)} target(s) stale — run without --check`);
  }
}
if (stale.length > 0) process.exitCode = 1;
