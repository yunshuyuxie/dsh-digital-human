#!/usr/bin/env node
/**
 * Cold-start acceptance for the first-run wizard's install path.
 *
 * Drives the app's own `installBridge()` — not a re-implementation — against a
 * profile that has no bridge, in four scenarios: a successful install from the
 * packaged zip, a repeated install (idempotence), and two failures the wizard
 * must report rather than swallow.
 *
 * Leaves the target profile with the bridge installed (that is the point) and
 * removes the throwaway bits it created.
 *
 * Usage:
 *   node tools/cold-start-check.mjs --profile coldtest [--zip <path>] [--keep]
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, installBridge } from '../main/onboarding.js';

/** Parse the flags this check owns. */
function parseArgs(argv) {
  const args = { profile: 'coldtest' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') args.profile = argv[++index];
    else if (argv[index] === '--zip') args.zip = argv[++index];
    else if (argv[index] === '--keep') args.keep = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const zip = args.zip ?? join(import.meta.dirname, '..', '..', '..', 'dist', 'dsh-digital-human-bridge-0.2.0.zip');
const failures = [];
let counter = 0;

/** Report one scenario. */
function check(label, ok, detail) {
  counter += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

// 0. The environment must really be cold, otherwise the test proves nothing.
const before = await diagnose({});
check(`profile '${args.profile}' exists`, before.profiles.includes(args.profile), before.profiles.join(', '));
check('that profile has no bridge yet', !before.profilesWithBridge.includes(args.profile));
check('the offline package is present', existsSync(zip), zip);

// 1. Install from the packaged zip, exactly as the wizard does.
const out = [];
const first = await installBridge({
  packagePath: zip,
  profile: args.profile,
  onOutput: (text, level) => out.push(`${level}: ${text}`),
});
check('install from .zip succeeds', first.ok === true, first.error ?? `${String(out.length)} output lines`);
check('the installer verified the link itself', existsSync(join(before.dshHome, 'profiles', args.profile, 'node_modules', 'dsh-digital-human-bridge')));

// The wizard shows this output; it must be non-empty and mention the profile.
check('installer output was streamed', out.length > 0, `${String(out.length)} lines`);
check('output names the target profile', out.some((line) => line.includes(args.profile)));

// 2. Diagnose again: the wizard's step 1 must now see the bridge.
const after = await diagnose({});
check('re-diagnosis reports the bridge installed', after.profilesWithBridge.includes(args.profile));

// 3. Idempotence: running the wizard twice must not fail.
const second = await installBridge({ packagePath: zip, profile: args.profile, onOutput: () => {} });
check('a second install still succeeds', second.ok === true, second.error ?? undefined);

// 4. Failures the wizard has to report, not hide.
const missing = await installBridge({ packagePath: join(tmpdir(), 'definitely-not-here.zip'), profile: args.profile, onOutput: () => {} });
check('a missing package is rejected', missing.ok === false && typeof missing.error === 'string', missing.error ?? undefined);

const junkDir = await mkdtemp(join(tmpdir(), 'dsh-junk-'));
await writeFile(join(junkDir, 'readme.txt'), 'not an installer');
const junk = await installBridge({ packagePath: junkDir, profile: args.profile, onOutput: () => {} });
check('a package without install.ps1 is rejected', junk.ok === false, junk.error ?? undefined);
if (args.keep !== true) await rm(junkDir, { recursive: true, force: true });

const empty = await installBridge({ packagePath: '', profile: args.profile, onOutput: () => {} });
check('an empty selection is rejected', empty.ok === false, empty.error ?? undefined);

console.log(failures.length === 0
  ? `cold-start: OK (${String(counter)} checks)`
  : `cold-start: ${String(failures.length)} failure(s): ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
