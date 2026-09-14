#!/usr/bin/env node
/**
 * Offline composition check: recompute a dsh profile's composed plugin rows with
 * the same `@deepseek-ai/dsh-app-boot` API the boot path uses, and assert that
 * this package's row is present.
 *
 * `verify.ps1` covers the filesystem half of an offline install; this covers the
 * half that only the composition can answer — that the row really parses and
 * really reaches the tree. It is read-only (it calls `loadProfile` /
 * `composeEntries`, never `prepareProfile`) and needs no running server.
 *
 * Usage:
 *   node tools/compose-verify.mjs --profile web --row digital-human-bridge \
 *     --name dsh-digital-human-bridge [--dsh-home <path>] [--install <path>]
 *
 * Exits 0 when the row is composed and enabled, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findDshInstall } from './find-install.mjs';

/** Parse the flags this script owns. */
function parseArgs(argv) {
  const args = { profile: 'web', row: 'digital-human-bridge', name: 'dsh-digital-human-bridge' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--profile') args.profile = argv[index + 1];
    if (flag === '--row') args.row = argv[index + 1];
    if (flag === '--name') args.name = argv[index + 1];
    if (flag === '--dsh-home') args.dshHome = argv[index + 1];
    if (flag === '--install') args.install = argv[index + 1];
  }
  return args;
}

/** Locate the installed `@deepseek-ai/dsh` package (see tools/find-install.mjs). */
function findInstall(explicit) {
  try {
    return findDshInstall({ explicit });
  } catch {
    throw new Error('compose-verify: cannot find @deepseek-ai/dsh — pass --install <path to its package.json>');
  }
}

const args = parseArgs(process.argv.slice(2));
const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', args.profile);
const dshManifestPath = findInstall(args.install);
const dshRequire = createRequire(dshManifestPath);

const appBootManifestPath = dshRequire.resolve('@deepseek-ai/dsh-app-boot/package.json');
const appBootDir = dirname(appBootManifestPath);
const appBootManifest = JSON.parse(readFileSync(appBootManifestPath, 'utf8'));
const appBootEntry = join(appBootDir, typeof appBootManifest.main === 'string' ? appBootManifest.main : 'lib/index.js');
const appBoot = await import(pathToFileURL(appBootEntry).href);

// The resolved home is handed to loadProfile: passing undefined would silently
// fall back to the process default and compose a different profile than the one
// --dsh-home names.
const profile = appBoot.loadProfile('dsh', args.profile, dshManifestPath, dshHome, { userLayer: true });
const rows = appBoot.composeEntries([
  (profile.layers ?? []).flatMap((layer) => layer.patches),
  profile.patches,
]);

const row = rows.find((entry) => entry.id === args.row);
console.log(`compose-verify: profile '${args.profile}' (${profileDir})`);
console.log(`compose-verify: composed rows: ${String(rows.length)}`);
if (row === undefined) {
  console.error(`compose-verify: FAIL row '${args.row}' is not in the composed tree`);
  process.exit(1);
}
const disabled = row.disabled === true;
console.log(`compose-verify: row '${args.row}' name=${String(row.name)} disabled=${String(disabled)}`);
if (row.name !== args.name) {
  console.error(`compose-verify: FAIL row '${args.row}' resolves to ${String(row.name)}, expected ${args.name}`);
  process.exit(1);
}
if (disabled) {
  console.error(`compose-verify: FAIL row '${args.row}' is composed but disabled`);
  process.exit(1);
}
console.log('compose-verify: OK');
