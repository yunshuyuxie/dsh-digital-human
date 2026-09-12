#!/usr/bin/env node
/**
 * Compose check: recompute a dsh profile's composed plugin rows with the very
 * API the boot path uses, and report the state of the rows this plugin cares
 * about.
 *
 * `preflight.mjs` proves the *files* are wired; this proves the *composition*
 * honors them — in particular that the `ui-approval` disable row really parses
 * and really reaches the composed tree. It is read-only: it calls `loadProfile`
 * and `composeEntries`, never `prepareProfile`, so it does not rewrite the
 * profile's root config, and it needs no running server.
 *
 * Usage:
 *   node tools/compose-check.mjs [--profile web] [--dsh-home <path>] [--install <path>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Parse the flags this script owns. */
function parseArgs(argv) {
  const args = { profile: 'web' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') args.profile = argv[index + 1];
    if (argv[index] === '--dsh-home') args.dshHome = argv[index + 1];
    if (argv[index] === '--install') args.install = argv[index + 1];
  }
  return args;
}

/** Package-manifest anchors found by scanning PATH for the `dsh` bin shim. */
function anchorsFromPath() {
  const anchors = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const shim of ['dsh.ps1', 'dsh.cmd', 'dsh.bat', 'dsh']) {
      if (!existsSync(join(dir, shim))) continue;
      // <cache>/node_modules/.bin/dsh -> <cache>/node_modules/@deepseek-ai/dsh
      anchors.push(join(dirname(dir), '@deepseek-ai', 'dsh', 'package.json'));
      break;
    }
  }
  return anchors;
}

/**
 * Locate the installed `@deepseek-ai/dsh` package.
 *
 * Order: `--install`, `$DSH_INSTALL_ANCHOR`, then the `dsh` bin shim on PATH
 * (it sits beside `node_modules/@deepseek-ai/dsh`).
 */
function findInstall(explicit) {
  const candidates = [];
  if (explicit !== undefined) candidates.push(explicit);
  if (process.env.DSH_INSTALL_ANCHOR !== undefined) candidates.push(process.env.DSH_INSTALL_ANCHOR);
  candidates.push(...anchorsFromPath());
  for (const candidate of candidates) {
    const manifestPath = candidate.endsWith('package.json') ? candidate : join(candidate, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') return manifestPath;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('compose-check: cannot find the installed @deepseek-ai/dsh — pass --install <path to its package.json>');
}

const args = parseArgs(process.argv.slice(2));
const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', args.profile);
const dshManifestPath = findInstall(args.install);
const dshDir = dirname(dshManifestPath);
const dshRequire = createRequire(dshManifestPath);

const appBootManifestPath = dshRequire.resolve('@deepseek-ai/dsh-app-boot/package.json');
const appBootDir = dirname(appBootManifestPath);
const appBootManifest = JSON.parse(readFileSync(appBootManifestPath, 'utf8'));
const appBootEntry = join(appBootDir, typeof appBootManifest.main === 'string' ? appBootManifest.main : 'lib/index.js');
const appBoot = await import(pathToFileURL(appBootEntry).href);

console.log(`compose-check: profile '${args.profile}' (${profileDir})`);
console.log(`compose-check: dsh install (${dshManifestPath})`);

const profile = appBoot.loadProfile('dsh', args.profile, dshManifestPath, undefined, { userLayer: true });
console.log(`  patchReload: ${String(profile.patchReload)}`);
console.log(`  bundles: ${(profile.layers ?? []).map((layer) => layer.packageName).join(', ')}`);
console.log(`  profile patch entries: ${JSON.stringify(profile.patches)}`);

const bundlePatches = (profile.layers ?? []).flatMap((layer) => layer.patches);
const rows = appBoot.composeEntries([bundlePatches, profile.patches]);
const byId = new Map();
for (const row of rows) if (typeof row.id === 'string') byId.set(row.id, row);

const failures = [];
/** Report one row's composed state. */
function report(id, expectation) {
  const row = byId.get(id);
  if (row === undefined) {
    console.log(`  FAIL ${id}: not in the composed tree`);
    failures.push(id);
    return;
  }
  const disabled = row.disabled === true;
  const ok = expectation === undefined || expectation === !disabled;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id}: name=${String(row.name)} disabled=${String(disabled)}`);
  if (!ok) failures.push(id);
}

report('digital-human', true);
report('ui-approval', undefined);

const approvalRow = byId.get('ui-approval');
const owner = approvalRow?.disabled === true ? 'the digital human' : 'the shipped approval panel';
console.log(`  info permission confirmation owned by: ${owner}`);
console.log(`  info composed rows: ${String(rows.length)}`);

if (failures.length > 0) {
  console.error('compose-check: the composition does not match the patch layer — fix the patch before refreshing the Web GUI');
  process.exitCode = 1;
}
