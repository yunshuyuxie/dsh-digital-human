/**
 * Direct test entry point: imports every `*.test.mjs` sibling so `node test/run.mjs` runs the whole
 * suite inside ONE process.
 *
 * The standard `node --test` runner spawns a child process per file with piped stdio, which some
 * restricted harnesses deny; this file avoids that by registering every test in the current
 * process and letting `node:test` run them on exit.
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('test/run.mjs: no *.test.mjs files found')
  process.exitCode = 1
} else {
  for (const entry of files) {
    await import(pathToFileURL(join(here, entry)).href)
  }
}
