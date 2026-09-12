#!/usr/bin/env node
/**
 * Preflight: verify a dsh profile is actually wired for this plugin before
 * asking anyone to refresh the Web GUI.
 *
 * It answers the questions the browser cannot answer for you:
 *   * does the profile depend on this package, and where does the link point?
 *   * do the host and client entries both resolve from the profile directory?
 *   * does the host half import, and does the client bundle register the right
 *     package identity?
 *   * does the profile patch carry the managed rows, and does it hand
 *     permission confirmation to the digital human?
 *
 * Usage: node tools/preflight.mjs [--profile web] [--dsh-home <path>]
 */
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')), '..');
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

/** Parse the two flags this script owns. */
function parseArgs(argv) {
  const args = { profile: 'web' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') args.profile = argv[index + 1];
    if (argv[index] === '--dsh-home') args.dshHome = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dshHome = args.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', args.profile);
const linked = join(profileDir, 'node_modules', manifest.name);

const failures = [];
let checks = 0;

/** Record one assertion. */
function check(label, ok, detail) {
  checks += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

console.log(`preflight: ${manifest.name} into profile '${args.profile}' (${profileDir})`);
check('profile directory exists', await exists(profileDir), profileDir);

const profileManifestPath = join(profileDir, 'package.json');
let profileManifest = {};
if (await exists(profileManifestPath)) {
  profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'));
}
const spec = profileManifest.dependencies?.[manifest.name];
check('profile depends on this package', typeof spec === 'string', spec ?? 'absent');
check('profile lists base + web-app bundles', Array.isArray(profileManifest.dsh?.profile?.bundles));

check('package is linked into the profile', await exists(linked), linked);
let realLinked;
try {
  realLinked = await realpath(linked);
} catch {
  realLinked = undefined;
}
check('link points at this checkout', realLinked !== undefined && resolve(realLinked) === resolve(ROOT), realLinked);

const linkedManifestPath = join(linked, 'package.json');
if (await exists(linkedManifestPath)) {
  const linkedManifest = JSON.parse(await readFile(linkedManifestPath, 'utf8'));
  check('linked package identity matches', linkedManifest.name === manifest.name, linkedManifest.name);
  check('declares a web client half', linkedManifest.dsh?.client?.platform === 'web', JSON.stringify(linkedManifest.dsh?.client));
  check('exposes ./client', typeof linkedManifest.exports?.['./client'] === 'object' || typeof linkedManifest.exports?.['./client'] === 'string');
}

const hostEntry = join(linked, 'lib', 'index.js');
const clientEntry = join(linked, 'lib', 'client.js');
check('host entry exists', await exists(hostEntry), hostEntry);
check('client bundle exists', await exists(clientEntry), clientEntry);

if (await exists(hostEntry)) {
  const host = await import(pathToFileURL(hostEntry).href);
  check('host half exports apply()', typeof host.apply === 'function');
}

if (await exists(clientEntry)) {
  const bundle = await readFile(clientEntry, 'utf8');
  check('client bundle registers this package id', bundle.includes(`id: ${JSON.stringify(manifest.name)}`));
  check('client bundle is a loader factory', bundle.includes('__ModuleLoader__.load(') && bundle.includes('factory:'));
}

const patchPath = join(profileDir, 'cordis.patch.yml');
const patch = (await exists(patchPath)) ? await readFile(patchPath, 'utf8') : '';
const start = patch.indexOf('# >>> dsh-digital-human (managed) >>>');
const end = patch.indexOf('# <<< dsh-digital-human (managed) <<<');
const block = start >= 0 && end > start ? patch.slice(start, end) : '';
check('patch carries the managed block', block !== '');
check('patch inserts the plugin row', /id:\s*digital-human/u.test(block) && block.includes(manifest.name));
const ownsApprovals = /id:\s*ui-approval/u.test(block) && /disabled:\s*true/u.test(block);
console.log(`  info permission confirmation owned by: ${ownsApprovals ? 'the digital human' : 'the shipped approval panel (run install.ps1 -OwnApprovals to switch)'}`);

console.log(`\n${String(checks - failures.length)}/${String(checks)} checks passed`);
if (failures.length > 0) {
  console.error('preflight: fix the failures above before refreshing the Web GUI');
  process.exitCode = 1;
} else {
  console.log('preflight: refresh the Web GUI page and look for the avatar in the bottom-right corner');
}
