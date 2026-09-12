/**
 * Endpoint discovery for the local bridge.
 *
 * The bridge publishes one JSON file per profile under
 * `<dsh-home>/digital-human/endpoints/`, plus the shared token store. Nothing
 * here is network-facing: discovery is a directory scan of the harness home.
 */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the harness home the way the launcher does.
 * @param override - an explicit home from app config, when set.
 * @returns the absolute harness home.
 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override !== '') return override;
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

/**
 * Read every published endpoint.
 * @param dshHome - absolute harness home.
 * @returns endpoint descriptors, newest first; an empty list when none exist.
 */
export async function discoverEndpoints(dshHome) {
  const dir = join(dshHome, 'digital-human', 'endpoints');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const endpoints = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const value = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (typeof value?.path !== 'string' || value.path === '') continue;
      endpoints.push({
        profile: typeof value.profile === 'string' ? value.profile : name.replace(/\.json$/u, ''),
        path: value.path,
        pipeName: typeof value.pipeName === 'string' ? value.pipeName : '',
        protocol: typeof value.protocol === 'number' ? value.protocol : 0,
        pid: typeof value.pid === 'number' ? value.pid : 0,
        host: typeof value.host === 'string' ? value.host : '',
        dshVersion: typeof value.dshVersion === 'string' ? value.dshVersion : 'unknown',
        bridgeVersion: typeof value.bridgeVersion === 'string' ? value.bridgeVersion : '',
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
        capabilities: Array.isArray(value.capabilities) ? value.capabilities : [],
      });
    } catch {
      /* a half-written or stale file is not an endpoint */
    }
  }
  endpoints.sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''));
  return endpoints;
}

/**
 * Read the bridge token for one profile.
 * @param dshHome - absolute harness home.
 * @param profile - the profile whose token to read.
 * @returns the token, or null when the store has none for that profile.
 */
export async function readToken(dshHome, profile) {
  try {
    const secrets = JSON.parse(await readFile(join(dshHome, 'digital-human', 'secrets.json'), 'utf8'));
    const token = secrets?.profiles?.[profile]?.token;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}
