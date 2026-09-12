/**
 * First-run onboarding: diagnose the machine, and install the bridge plugin.
 *
 * Everything here works while the app is NOT connected, because that is the
 * normal state on a fresh machine: the point of the wizard is to fix it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverEndpoints, resolveDshHome } from './endpoint.js';

/** Bridge versions this app can use to the fullest; older ones still work, degraded. */
export const FULL_FEATURE_BRIDGE = '0.2.0';

/**
 * Compare two dotted versions.
 * @returns a negative number when `left` precedes `right`.
 */
function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** List the profile directories of a harness home. */
async function listProfiles(dshHome) {
  try {
    const entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      // `profiles/` also holds the profile-level node_modules and tool caches;
      // neither is a profile, and offering them as install targets would be wrong.
      .filter((entry) => entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Whether one profile has the bridge linked into its node_modules. */
function bridgeLinkIn(profileDir) {
  return existsSync(join(profileDir, 'node_modules', 'dsh-digital-human-bridge'));
}

/**
 * Inspect the machine and report what the wizard should ask for.
 *
 * @param options - `{ dshHome, profile }`; `dshHome` may be null.
 * @returns a JSON-safe diagnostic.
 */
export async function diagnose(options = {}) {
  const dshHome = resolveDshHome(options.dshHome);
  const dshHomeExists = existsSync(dshHome);
  const profiles = await listProfiles(dshHome);
  const linked = profiles.filter((name) => bridgeLinkIn(join(dshHome, 'profiles', name)));
  const endpoints = await discoverEndpoints(dshHome);
  const newest = endpoints[0] ?? null;

  return {
    dshHome,
    dshHomeExists,
    profiles,
    // The wizard offers these as install targets.
    profilesWithBridge: linked,
    running: endpoints.length > 0,
    endpointCount: endpoints.length,
    endpoints: endpoints.map((entry) => ({
      profile: entry.profile,
      bridgeVersion: entry.bridgeVersion,
      protocol: entry.protocol,
      dshVersion: entry.dshVersion,
    })),
    bridgeVersion: newest?.bridgeVersion ?? null,
    // An installed-but-not-running bridge is the common case right after install.
    bridgeInstalled: linked.length > 0,
    fullFeature: newest === null ? false : compareVersions(newest.bridgeVersion, FULL_FEATURE_BRIDGE) >= 0,
  };
}

/** Run one child process, collecting its output line by line. */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    const lines = [];
    const push = (chunk, level) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line.trim() === '') continue;
        lines.push({ level, text: line });
        options.onOutput?.(line, level);
      }
    };
    child.stdout?.on('data', (chunk) => {
      push(chunk, 'info');
    });
    child.stderr?.on('data', (chunk) => {
      push(chunk, 'error');
    });
    child.on('error', (error) => {
      push(error.message, 'error');
      resolve({ code: -1, lines });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, lines });
    });
  });
}

/**
 * Find the directory that holds the installer inside a chosen path.
 * @returns the absolute package root, or null when it cannot be located.
 */
function locateInstaller(root) {
  const candidates = [root, join(root, 'package'), join(root, 'scripts'), join(root, 'package', 'scripts')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'install.ps1'))) return candidate;
  }
  return null;
}

/**
 * Install the bridge from an offline package.
 *
 * Accepts the packaged `.zip` (expanded first) or an already-extracted directory,
 * which is how the offline bundle is shipped and what the docs describe.
 *
 * @param options - `{ packagePath, profile, dshHome, onOutput }`.
 * @returns `{ ok, steps, error }` — `steps` is the installer's own output.
 */
export async function installBridge(options) {
  const dshHome = resolveDshHome(options.dshHome);
  const profile = typeof options.profile === 'string' && options.profile !== '' ? options.profile : 'web';
  const chosen = options.packagePath;
  const steps = [];
  if (typeof chosen !== 'string' || chosen === '') {
    return { ok: false, steps, error: '没有选择桥接安装包' };
  }
  if (!existsSync(chosen)) {
    return { ok: false, steps, error: `路径不存在：${chosen}` };
  }

  let root = chosen;
  let expanded = null;
  if (chosen.toLowerCase().endsWith('.zip')) {
    // Extract somewhere durable and KEEP it: the installed profile links at this
    // path, so deleting it would leave a dangling junction that still reports a
    // successful install. (Learned the hard way — tools/cold-start-check.mjs
    // covers exactly this.)
    const base = options.extractRoot ?? join(tmpdir(), 'dsh-digital-human-bridge-packages');
    expanded = join(base, basename(chosen).replace(/\.zip$/iu, ''));
    await rm(expanded, { recursive: true, force: true });
    await mkdir(expanded, { recursive: true });
    const unzip = await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${chosen.replace(/'/gu, "''")}' -DestinationPath '${expanded.replace(/'/gu, "''")}' -Force`,
    ], { onOutput: options.onOutput });
    steps.push(...unzip.lines);
    if (unzip.code !== 0) {
      return { ok: false, steps, error: '解压安装包失败' };
    }
    // The archive contains one top-level directory.
    const entries = await readdir(expanded, { withFileTypes: true });
    const first = entries.find((entry) => entry.isDirectory());
    root = first === undefined ? expanded : join(expanded, first.name);
  }

  const installerDir = locateInstaller(root);
  if (installerDir === null) {
    return { ok: false, steps, error: `在 ${basename(chosen)} 里找不到 install.ps1` };
  }

  const install = await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(installerDir, 'install.ps1'),
    '-Profile',
    profile,
  ], { env: { DSH_HOME: dshHome }, onOutput: options.onOutput });
  steps.push(...install.lines);

  if (install.code !== 0) {
    return { ok: false, steps, error: `安装脚本以退出码 ${String(install.code)} 结束` };
  }
  // Verify the link RESOLVES, not merely that a directory entry exists: a dangling
  // junction must fail here rather than at the next launch.
  const link = join(dshHome, 'profiles', profile, 'node_modules', 'dsh-digital-human-bridge');
  let resolved = null;
  try {
    resolved = await realpath(link);
  } catch {
    resolved = null;
  }
  if (resolved === null || !existsSync(join(resolved, 'package.json'))) {
    return { ok: false, steps, error: '安装脚本执行了，但 profile 里的桥接链接无法解析（可能指向已删除的路径）' };
  }
  return { ok: true, steps, error: null, packageRoot: resolved };
}
