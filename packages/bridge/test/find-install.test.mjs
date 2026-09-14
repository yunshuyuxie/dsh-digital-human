/**
 * Discovery tests for tools/find-install.mjs.
 *
 * Resolve-DshInstall must recognise every layout `dsh` arrives through, and they
 * differ in where the bin shim sits relative to the package:
 *
 *   * npm prefix / npm global / nvm:  <prefix>/dsh.cmd
 *   * npm or pnpm local install:      <root>/node_modules/.bin/dsh.cmd
 *   * pnpm global:                    <pnpm home>/dsh.cmd
 *
 * Every case builds one of those trees from the shim text npm and pnpm really
 * generate and passes PATH, the app-data roots and the platform in as arguments,
 * so the real environment cannot influence the result.
 *
 * The same discovery is implemented for the installer in scripts/common.ps1 and
 * covered by test/resolve-dshinstall.test.ps1.
 *
 * Run with `node test/run.mjs` (one process) or `npm test`.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { findDshInstall } from '../tools/find-install.mjs';

/** The shim npm writes for a global/prefix install (verbatim shape from npm). */
const NPM_CMD_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*
`;

/** The same shim npm writes into <root>/node_modules/.bin: one '..' segment. */
const NPM_BIN_SHIM = NPM_CMD_SHIM.replace('%dp0%\\node_modules\\', '%dp0%\\..\\node_modules\\');

/** The PowerShell shim (a different base variable and forward slashes). */
const NPM_PS1_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args
  $ret=$LASTEXITCODE
} else {
  & "node$exe"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args
  $ret=$LASTEXITCODE
}
exit $ret
`;

/** The POSIX sh shim. */
const NPM_SH_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

exec node  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
`;

/**
 * Write a minimal but valid @deepseek-ai/dsh package.
 *
 * @param {string} dir - Package directory.
 * @param {string} [version] - Version to declare.
 */
async function writeDshPackage(dir, version = '9.9.9') {
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  await writeFile(join(dir, 'lib', 'bin.js'), '// fixture entry\n');
}

/**
 * Write a shim file, creating its directory.
 *
 * @param {string} file - Shim path.
 * @param {string} text - Shim body.
 */
async function writeShim(file, text) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}

describe('find-install', () => {
  /** @type {string} */
  let root;
  /** App-data roots that contain no dsh, so only the case under test can match. */
  let bareEnv;
  /** PATH value that holds no shim at all. */
  let barePath;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-find-install-'));
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    barePath = empty;
    bareEnv = {
      USERPROFILE: join(root, 'home'),
      APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'localappdata'),
    };
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Run discovery against fixture-only inputs. */
  const discover = (pathValue, env = bareEnv, explicit = undefined) =>
    findDshInstall({ explicit, pathValue, env, platform: 'win32' });

  it('reads the package path out of an npm prefix shim (cmd, %dp0%)', async () => {
    const prefix = join(root, 'npm-prefix');
    await writeDshPackage(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'));
    await writeShim(join(prefix, 'dsh.cmd'), NPM_CMD_SHIM);
    assert.equal(discover(prefix), join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  });

  it('reads the package path out of an npm prefix shim (ps1, $basedir)', async () => {
    const prefix = join(root, 'npm-prefix-ps1');
    await writeDshPackage(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'));
    await writeShim(join(prefix, 'dsh.ps1'), NPM_PS1_SHIM);
    assert.equal(discover(prefix), join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  });

  it('reads the package path out of a POSIX sh shim', async () => {
    const prefix = join(root, 'npm-prefix-sh');
    await writeDshPackage(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'));
    await writeShim(join(prefix, 'dsh'), NPM_SH_SHIM);
    assert.equal(discover(prefix), join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  });

  it('follows the ..\\node_modules reference of a local .bin shim', async () => {
    const local = join(root, 'npm-local');
    await writeDshPackage(join(local, 'node_modules', '@deepseek-ai', 'dsh'));
    await writeShim(join(local, 'node_modules', '.bin', 'dsh.cmd'), NPM_BIN_SHIM);
    assert.equal(discover(join(local, 'node_modules', '.bin')), join(local, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  });

  it('resolves a pnpm global store path containing + and @', async () => {
    const pnpmHome = join(root, 'pnpm');
    const vstore = join(pnpmHome, 'global', '5', '.pnpm', '@deepseek-ai+dsh@9.9.9_abcdef', 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(vstore);
    const shim = NPM_CMD_SHIM.replace(
      '%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      '%dp0%\\global\\5\\.pnpm\\@deepseek-ai+dsh@9.9.9_abcdef\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    );
    await writeShim(join(pnpmHome, 'dsh.cmd'), shim);
    assert.equal(discover(pnpmHome), join(vstore, 'package.json'));
  });

  it('expands a %PNPM_HOME% reference in a shim', async () => {
    const pnpmHome = join(root, 'pnpm-home');
    const vstore = join(pnpmHome, 'store', 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(vstore);
    await writeShim(join(pnpmHome, 'dsh.cmd'), 'node "%PNPM_HOME%\\store\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\n');
    assert.equal(discover(pnpmHome, { ...bareEnv, PNPM_HOME: pnpmHome }), join(vstore, 'package.json'));
  });

  it('resolves an absolute path reference in a shim', async () => {
    const root2 = join(root, 'absolute');
    const pkg = join(root2, 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(pkg);
    const shimDir = join(root2, 'bin');
    await writeShim(join(shimDir, 'dsh.cmd'), `node "${join(pkg, 'lib', 'bin.js')}" %*\n`);
    assert.equal(discover(shimDir), join(pkg, 'package.json'));
  });

  it('falls back to the pnpm global root when the shim body carries no path', async () => {
    const binDir = join(root, 'opaque-bin');
    await writeShim(join(binDir, 'dsh.cmd'), '@ECHO off\nnode "launcher.js" %*\n');
    const localAppData = join(root, 'pnpm-known');
    const store = join(localAppData, 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(store);
    assert.equal(discover(binDir, { ...bareEnv, LOCALAPPDATA: localAppData }), join(store, 'package.json'));
  });

  it('falls back to the npm user prefix when no shim is on PATH', async () => {
    const appData = join(root, 'npm-userprefix');
    const pkg = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(pkg);
    assert.equal(discover(barePath, { ...bareEnv, APPDATA: appData }), join(pkg, 'package.json'));
  });

  it('discovers an nvm-windows per-version root without a shim', async () => {
    const appData = join(root, 'appdata-nvm');
    const pkg = join(appData, 'nvm', 'v22.11.0', 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(pkg);
    assert.equal(discover(barePath, { ...bareEnv, APPDATA: appData }), join(pkg, 'package.json'));
  });

  it('honours an explicit install path', async () => {
    const pkg = join(root, 'explicit', 'node_modules', '@deepseek-ai', 'dsh');
    await writeDshPackage(pkg);
    assert.equal(discover(barePath, bareEnv, pkg), join(pkg, 'package.json'));
    assert.equal(discover(barePath, bareEnv, join(pkg, 'package.json')), join(pkg, 'package.json'));
  });

  it('refuses to guess when nothing matches', () => {
    assert.throws(() => discover(barePath), /cannot find @deepseek-ai\/dsh/);
  });
});
