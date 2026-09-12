/**
 * App configuration: a small JSON document in the Electron user-data directory.
 *
 * Only user-owned choices live here (window position, always-on-top, an explicit
 * harness home override). Nothing derived from the bridge is persisted.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Defaults for a first run. */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  dshHome: null,
  activeProfile: null,
  alwaysOnTop: true,
  startWithWindows: false,
  notifyOnApproval: true,
  notifySound: true,
  // Set by the first-run wizard; until then the panel window opens on the wizard.
  onboarded: false,
  // Panel background alpha; the renderer applies it as a CSS variable.
  panelOpacity: 0.92,
  // Where the user parked the avatar chip (`{ x, y }`); it keeps its fixed size.
  avatarWindow: null,
  // Where the user parked the panel (`{ x, y, width, height }`); resizable.
  panelWindow: null,
});

/**
 * Config keys retired by the two-window split. A pre-split config file carries
 * `compact` / `compactWindow` / `window`; they are ignored here so an upgraded
 * install starts clean instead of crashing on a shape it no longer reads.
 */
const LEGACY_KEYS = new Set(['compact', 'compactWindow', 'window']);

/**
 * Create the config store.
 * @param options - `{ dir }`, the Electron user-data directory.
 * @returns the store handle.
 */
export function createConfigStore(options) {
  const path = join(options.dir, 'config.json');
  let current = { ...DEFAULT_CONFIG };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // Drop retired fields before merging so they are never resurrected on write.
    for (const key of LEGACY_KEYS) delete parsed[key];
    current = { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    /* first run, or a corrupt file: defaults are the safe start */
  }

  /** Persist a patch and return the merged config. */
  function write(patch) {
    // Re-read before writing. More than one instance can share this file (a dev
    // run and an installed build), and a stale in-memory copy would otherwise
    // resurrect old values over whatever the other instance just saved.
    let onDisk = {};
    try {
      onDisk = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* no file yet, or unreadable: defaults plus in-memory state are enough */
    }
    for (const key of LEGACY_KEYS) delete onDisk[key];
    current = { ...DEFAULT_CONFIG, ...onDisk, ...current, ...patch };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch {
      /* a read-only profile directory must not break the app */
    }
    return current;
  }

  return {
    path,
    read: () => current,
    write,
  };
}
