#!/usr/bin/env node
/**
 * Build the digital-human plugin artifacts.
 *
 * The host half is a plain ES module — copied verbatim, because the Cordis
 * Loader imports it directly.
 *
 * The browser half must reach the page as one `window.__ModuleLoader__.load()`
 * factory bundle: the Web client module system resolves only platform seed
 * modules by name, so the plugin's own files are inlined behind a tiny CJS
 * registry that turns `require('./x.js')` into a local lookup and everything
 * else into the loader's own `require`.
 *
 * Usage: node tools/build.mjs
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = join(ROOT, 'src', 'client');
const LIB = join(ROOT, 'lib');
const PACKAGE_NAME = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).name;
const ENTRY = './plugin.js';

/** Resolve one relative request against this flat client source directory. */
function moduleKey(request) {
  return request.endsWith('.js') ? request : `${request}.js`;
}

/** Indent a source file so it reads as one registry body. */
function indent(source) {
  return source
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => (line === '' ? '' : `\t\t${line}`))
    .join('\n');
}

const files = (await readdir(CLIENT_SRC))
  .filter((name) => name.endsWith('.js'))
  .sort();

if (!files.includes(ENTRY.slice(2))) {
  throw new Error(`build: client entry ${ENTRY} is missing from src/client`);
}

const registrations = [];
for (const file of files) {
  const key = `./${file}`;
  const source = await readFile(join(CLIENT_SRC, file), 'utf8');
  registrations.push(
    `\t\t__define(${JSON.stringify(key)}, (module, exports, require) => {\n${indent(source)}\n\t\t});`,
  );
}

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tvar registry = {};
\t\tvar cache = {};
\t\t/** Register one inlined plugin module under its './name.js' key. */
\t\tfunction __define(key, factory) {
\t\t\tregistry[key] = factory;
\t\t}
\t\t/** Resolve a relative request; the client source directory is flat. */
\t\tfunction __resolve(request) {
\t\t\treturn request.charAt(0) === '.' ? (request.endsWith('.js') ? request : request + '.js') : request;
\t\t}
\t\t/** Require one inlined module, or hand an external request to the loader. */
\t\tfunction __require(request) {
\t\t\tif (request.charAt(0) !== '.') return require(request);
\t\t\tvar key = __resolve(request);
\t\t\tvar cached = cache[key];
\t\t\tif (cached !== undefined) return cached.exports;
\t\t\tvar factory = registry[key];
\t\t\tif (factory === undefined) throw new Error(${JSON.stringify(`${PACKAGE_NAME}: unknown client module `)} + key);
\t\t\tvar record = { exports: {} };
\t\t\tcache[key] = record;
\t\t\tfactory(record, record.exports, __require);
\t\t\treturn record.exports;
\t\t}
${registrations.join('\n')}
\t\tmodule.exports = __require(${JSON.stringify(ENTRY)});
\t\treturn module.exports;
\t}
});

//# sourceMappingURL=client.js.map
`;

await mkdir(LIB, { recursive: true });
await writeFile(join(LIB, 'client.js'), bundle, 'utf8');
await writeFile(join(LIB, 'index.js'), await readFile(join(ROOT, 'src', 'index.js'), 'utf8'), 'utf8');
await writeFile(
  join(LIB, 'client.js.map'),
  `${JSON.stringify({ version: 3, file: 'client.js', sources: files.map((name) => `../src/client/${name}`), names: [], mappings: '' }, null, 2)}\n`,
  'utf8',
);

const bytes = Buffer.byteLength(bundle, 'utf8');
console.log(`built ${PACKAGE_NAME}: lib/client.js (${String(bytes)} bytes, ${String(files.length)} modules), lib/index.js`);
