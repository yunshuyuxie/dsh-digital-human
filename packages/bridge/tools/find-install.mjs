/**
 * Offline discovery of the installed `@deepseek-ai/dsh` package.
 *
 * `dsh` reaches PATH through several layouts, and the shim's own directory only
 * implies the package location in one of them:
 *
 *   * npm prefix, npm global, nvm:  <prefix>/dsh.cmd  with the package in
 *     <prefix>/node_modules/@deepseek-ai/dsh;
 *   * npm or pnpm local install:    <root>/node_modules/.bin/dsh.cmd  with the
 *     package in <root>/node_modules/@deepseek-ai/dsh;
 *   * pnpm global store:            <pnpm home>/dsh.cmd  with the package in
 *     <pnpm home>/global/<store>/node_modules/@deepseek-ai/dsh.
 *
 * The shim body is therefore the primary evidence: every shim npm, pnpm or yarn
 * generates launches the entry script of its own package and names it as
 * '%dp0%\<relative>', '$basedir/<relative>' or an absolute path. Known global
 * roots come next. Every candidate is verified against its manifest `name`, so a
 * wrong guess is skipped instead of trusted.
 *
 * Pure filesystem work: no registry, no package manager, no network.
 *
 * @module dsh-digital-human-bridge/tools/find-install
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

/** The package this module looks for. */
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';

/** The PATH separator of a platform. */
function pathSeparator(platform) {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Expand every leading `%NAME%` of a shim path token.
 *
 * @param {string} token - A path token taken from a shim body.
 * @param {NodeJS.ProcessEnv} env - Environment holding the variables.
 * @returns {string|null} The expanded token, or null when a name is unknown.
 */
export function expandVariables(token, env) {
  let text = token;
  for (;;) {
    const match = text.match(/^%([A-Za-z_][A-Za-z0-9_]*)%(.*)$/);
    if (match === null) return text;
    const value = env[match[1]];
    if (value === undefined || value === '') return null;
    text = value + match[2];
  }
}

/**
 * Package roots named by a bin shim's own body.
 *
 * The reference continues past the package directory (for example
 * '\lib\bin.js'), so the manifest directory is the segment ending in 'dsh'.
 *
 * @param {string} shimPath - Path of the shim file.
 * @param {NodeJS.ProcessEnv} [env] - Environment for `%NAME%` expansion.
 * @returns {string[]} Candidate package directories, in body order.
 */
export function rootsFromShim(shimPath, env = process.env) {
  let text;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return [];
  }
  const shimDir = dirname(shimPath);
  const roots = new Set();
  const leftChars = /[A-Za-z0-9_~%.$\\/:@+-]/;
  const rightChars = /[A-Za-z0-9_~$.\\/:@+-]/;
  for (const match of text.matchAll(/node_modules[\\/](?:@[A-Za-z0-9._~-]+[\\/])?dsh(?=[\\/]|$)/g)) {
    let start = match.index;
    while (start > 0 && leftChars.test(text[start - 1])) start -= 1;
    let end = match.index + match[0].length;
    while (end < text.length && rightChars.test(text[end])) end += 1;
    const token = text.slice(start, end);

    const variable = token.match(/^(%~?dp0%|\$basedir)/);
    let candidate;
    if (variable !== null) candidate = join(shimDir, token.slice(variable[1].length));
    else if (token.startsWith('%')) {
      // '%PNPM_HOME%\...' and friends: expand every leading %NAME% ('dp0' is
      // already handled above). An unknown name makes the token unusable.
      const expanded = expandVariables(token, env);
      candidate = expanded === null ? null : normalize(expanded);
    } else if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith('\\') || token.startsWith('/')) candidate = token;
    else candidate = join(shimDir, token);
    if (candidate === null) continue;

    const resolved = normalize(candidate);
    const inner = resolved.match(/node_modules[\\/](?:@[A-Za-z0-9._~-]+[\\/])?dsh/);
    roots.add(inner === null ? resolved : resolved.slice(0, inner.index + inner[0].length));
  }
  return [...roots];
}

/**
 * Package-manifest anchors found by scanning a PATH value for the `dsh` shim.
 *
 * @param {string} [pathValue] - PATH to scan.
 * @param {NodeJS.ProcessEnv} [env] - Environment for `%NAME%` expansion.
 * @param {string} [platform] - Platform whose PATH separator applies.
 * @returns {string[]} Candidate manifest paths.
 */
export function anchorsFromPath(pathValue = process.env.PATH ?? '', env = process.env, platform = process.platform) {
  const anchors = [];
  for (const dir of pathValue.split(pathSeparator(platform))) {
    if (dir === '') continue;
    for (const shim of ['dsh.cmd', 'dsh.bat', 'dsh.ps1', 'dsh']) {
      const shimPath = join(dir, shim);
      if (!existsSync(shimPath)) continue;
      for (const root of rootsFromShim(shimPath, env)) anchors.push(join(root, 'package.json'));
      // Legacy assumption, kept because it is exact for a .bin shim.
      anchors.push(join(dirname(dir), DSH_PACKAGE_NAME, 'package.json'));
      break;
    }
  }
  return anchors;
}

/**
 * Global roots dsh is commonly installed into, independent of PATH.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment holding the app-data roots.
 * @param {string} [platform] - Platform whose layout applies.
 * @returns {string[]} Candidate manifest paths.
 */
export function wellKnownAnchors(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  const anchors = [];
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    // npm's default user prefix; nvm-windows keeps one node per version, each
    // with its own global node_modules, below the same roaming directory.
    anchors.push(join(appData, 'npm', 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
    const nvm = join(appData, 'nvm');
    try {
      for (const version of readdirSync(nvm)) anchors.push(join(nvm, version, 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
    } catch {
      /* nvm-windows is not installed */
    }
    // pnpm keeps its global bin directory on PATH but the package itself in a
    // store below it.
    const pnpmGlobal = join(localAppData, 'pnpm', 'global');
    try {
      for (const store of readdirSync(pnpmGlobal)) anchors.push(join(pnpmGlobal, store, 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
      anchors.push(join(pnpmGlobal, 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
    } catch {
      /* no pnpm global store */
    }
  } else {
    anchors.push(join(home, '.npm-global', 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
    anchors.push(join(home, '.local', 'share', 'pnpm', 'global', 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
    anchors.push(join(home, '.local', 'share', 'npm', 'node_modules', DSH_PACKAGE_NAME, 'package.json'));
  }
  return anchors;
}

/**
 * Locate the installed `@deepseek-ai/dsh` package.
 *
 * @param {object} [options] - Discovery inputs.
 * @param {string} [options.explicit] - Explicit package.json or its directory.
 * @param {string} [options.pathValue] - PATH to scan; defaults to the process PATH.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment to read.
 * @param {string} [options.platform] - Platform to assume.
 * @returns {string} Path of the package.json that declares @deepseek-ai/dsh.
 * @throws {Error} When no candidate passes the manifest check.
 */
export function findDshInstall({ explicit, pathValue, env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (explicit !== undefined) candidates.push(explicit);
  if (env.DSH_INSTALL_ANCHOR !== undefined && env.DSH_INSTALL_ANCHOR !== '') candidates.push(env.DSH_INSTALL_ANCHOR);
  candidates.push(...anchorsFromPath(pathValue ?? env.PATH ?? '', env, platform));
  candidates.push(...wellKnownAnchors(env, platform));
  for (const candidate of candidates) {
    const manifestPath = candidate.endsWith('package.json') ? candidate : join(candidate, 'package.json');
    try {
      if (JSON.parse(readFileSync(manifestPath, 'utf8')).name === DSH_PACKAGE_NAME) return manifestPath;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`cannot find ${DSH_PACKAGE_NAME} (looked at ${String(candidates.length)} locations)`);
}
