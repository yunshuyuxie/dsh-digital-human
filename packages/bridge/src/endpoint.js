/**
 * Endpoint discovery and token persistence (design.md §5.2.5).
 *
 * Two files live under `<stateDir>`:
 *
 * - `endpoints/<profile>.json` — public discovery record (no secrets); deleted on release.
 * - `secrets.json` — per-profile shared token, mode 0600; the App reads it locally.
 *
 * Everything is plain JSON with no BOM so the zero-dependency desktop App can parse it directly.
 *
 * @module dsh-digital-human-bridge/endpoint
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { PROTOCOL_VERSION } from './vendor/protocol/index.js'

/**
 * Schema revision of `endpoints/<profile>.json` and `secrets.json`.
 *
 * @type {number}
 */
const FILE_VERSION = 1

/**
 * Length in bytes of a generated token. 32 bytes encode to 52 base32 characters.
 *
 * @type {number}
 */
const TOKEN_BYTES = 32

/**
 * RFC 4648 base32 alphabet, uppercase, no padding.
 *
 * @type {string}
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Encode bytes as RFC 4648 base32 without padding.
 *
 * @param {Buffer | Uint8Array} buffer - Bytes to encode.
 * @returns {string} Base32 text (no `=` padding).
 * @throws {TypeError} When `buffer` is not a `Buffer`/`Uint8Array`.
 */
export function encodeBase32(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('encodeBase32: expected a Buffer or Uint8Array')
  }
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * Test whether an error is a "file does not exist" failure.
 *
 * @param {unknown} error - Thrown value.
 * @returns {boolean} `true` for `ENOENT`.
 */
function isMissing(error) {
  return Boolean(error) && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
}

/**
 * Parse JSON text, translating a syntax error into a named `Error`.
 *
 * @param {string} text - File contents.
 * @param {string} label - File description used in the message.
 * @returns {any} Parsed value.
 * @throws {Error} When the text is not valid JSON.
 */
function parseJsonFile(text, label) {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`digital-human-bridge: ${label} is corrupt and was left untouched: ${cause.message}`, { cause })
  }
}

/**
 * Read a UTF-8 JSON file, returning `null` when it does not exist.
 *
 * @param {string} file - Absolute path.
 * @param {string} label - File description used in the corrupt-file message.
 * @returns {Promise<any | null>} Parsed value or `null`.
 * @throws {Error} When the file exists but cannot be parsed.
 */
async function readJsonIfPresent(file, label) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  return parseJsonFile(text.replace(/^\uFEFF/, ''), label)
}

/**
 * Write a file atomically: contents land in `<file>.tmp` first and are then renamed into place, so
 * a reader never observes a half-written file.
 *
 * @param {string} file - Destination path.
 * @param {string} text - UTF-8 text (the caller includes the trailing newline).
 * @param {number} [mode] - Optional POSIX permission bits.
 * @returns {Promise<void>} Resolves once the rename happened.
 */
async function writeFileAtomic(file, text, mode) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  try {
    await writeFile(temporary, text, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Create the per-state-directory token store.
 *
 * Reads and writes of `secrets.json` are serialized through a module-level promise chain so two
 * profiles calling `ensure` concurrently can never clobber each other's entry.
 *
 * @param {object} input - Store options.
 * @param {string} input.stateDir - Bridge state directory.
 * @returns {{ read: (profile: string) => Promise<string | null>, ensure: (profile: string) => Promise<{ token: string, created: boolean }>, remove: (profile: string) => Promise<void>, path: string }} Token store.
 * @throws {TypeError} When `stateDir` is missing.
 */
export function createTokenStore({ stateDir } = /** @type {any} */ ({})) {
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new TypeError('createTokenStore: stateDir must be a non-empty string')
  }
  const file = `${stateDir}/secrets.json`

  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()

  /**
   * Run `task` after every previously queued task, so file updates never interleave.
   *
   * @template T
   * @param {() => Promise<T>} task - Work to serialize.
   * @returns {Promise<T>} The task result.
   */
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Load the secrets document, tolerating a missing file but never a corrupt one.
   *
   * @returns {Promise<{ version: number, profiles: Record<string, object> }>} Document, possibly empty.
   * @throws {Error} When `secrets.json` exists but is not parsable.
   */
  async function load() {
    const parsed = await readJsonIfPresent(file, file)
    if (parsed === null) return { version: FILE_VERSION, profiles: {} }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`digital-human-bridge: ${file} is corrupt and was left untouched: expected a JSON object`)
    }
    const profiles = parsed.profiles
    if (profiles !== undefined && (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles))) {
      throw new Error(
        `digital-human-bridge: ${file} is corrupt and was left untouched: expected "profiles" to be a JSON object`,
      )
    }
    return { version: FILE_VERSION, profiles: profiles ?? {} }
  }

  /**
   * Persist the document with a trailing newline and no BOM.
   *
   * @param {{ version: number, profiles: Record<string, object> }} document - Document to write.
   * @returns {Promise<void>} Resolves once written.
   */
  async function save(document) {
    const text = `${JSON.stringify({ version: FILE_VERSION, profiles: document.profiles }, null, 2)}\n`
    await writeFileAtomic(file, text, 0o600)
  }

  /**
   * Read the stored token for one profile.
   *
   * @param {string} profile - DSH profile name.
   * @returns {Promise<string | null>} The token, or `null` when absent or malformed.
   * @throws {Error} When `secrets.json` exists but is not parsable.
   */
  async function read(profile) {
    const document = await load()
    const entry = document.profiles[profile]
    if (entry === null || typeof entry !== 'object') return null
    const token = /** @type {{ token?: unknown }} */ (entry).token
    return typeof token === 'string' && token.length > 0 ? token : null
  }

  /**
   * Read the token for one profile, creating and persisting it when missing.
   *
   * @param {string} profile - DSH profile name.
   * @returns {Promise<{ token: string, created: boolean }>} The token and whether it was just created.
   * @throws {Error} When `secrets.json` exists but is not parsable (never silently overwritten).
   */
  function ensure(profile) {
    return serialize(async () => {
      const document = await load()
      const entry = document.profiles[profile]
      if (entry !== null && typeof entry === 'object') {
        const existing = /** @type {{ token?: unknown }} */ (entry).token
        if (typeof existing === 'string' && existing.length > 0) return { token: existing, created: false }
      }
      const token = encodeBase32(randomBytes(TOKEN_BYTES))
      document.profiles[profile] = { token, createdAt: new Date().toISOString(), rotatedAt: null }
      await save(document)
      return { token, created: true }
    })
  }

  /**
   * Drop one profile's entry, leaving every other profile untouched.
   *
   * @param {string} profile - DSH profile name.
   * @returns {Promise<void>} Resolves once the change is on disk (or is a no-op).
   * @throws {Error} When `secrets.json` exists but is not parsable.
   */
  function remove(profile) {
    return serialize(async () => {
      const document = await load()
      if (!Object.prototype.hasOwnProperty.call(document.profiles, profile)) return
      delete document.profiles[profile]
      await save(document)
    })
  }

  return { read, ensure, remove, path: file }
}

/**
 * Publish the endpoint record for one profile.
 *
 * @param {object} input - Endpoint inputs.
 * @param {string} input.stateDir - Bridge state directory.
 * @param {string} input.profile - DSH profile name.
 * @param {object} input.info - Discovery fields: `pid`, `host`, `dshVersion`, `bridgeVersion`,
 *   `startedAt`, `capabilities`.
 * @returns {Promise<string>} Path of the file written.
 * @throws {TypeError} When a required argument is missing.
 */
export async function writeEndpoint({ stateDir, profile, info } = /** @type {any} */ ({})) {
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new TypeError('writeEndpoint: stateDir must be a non-empty string')
  }
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new TypeError('writeEndpoint: profile must be a non-empty string')
  }
  if (typeof info !== 'object' || info === null || Array.isArray(info)) {
    throw new TypeError('writeEndpoint: info must be an object')
  }
  const pipeName = typeof info.pipeName === 'string' && info.pipeName.length > 0 ? info.pipeName : `dsh-digital-human-${profile}`
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : `${stateDir}/${pipeName}.sock`
  const record = {
    ...info,
    version: FILE_VERSION,
    protocol: PROTOCOL_VERSION,
    transport: 'pipe',
    path: pipePath,
    profile,
    updatedAt: new Date().toISOString(),
  }
  const file = `${stateDir}/endpoints/${profile}.json`
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
  return file
}

/**
 * Delete the endpoint record for one profile. A missing file is not an error.
 *
 * @param {object} input - Endpoint inputs.
 * @param {string} input.stateDir - Bridge state directory.
 * @param {string} input.profile - DSH profile name.
 * @returns {Promise<void>} Resolves once gone.
 * @throws {TypeError} When a required argument is missing.
 */
export async function removeEndpoint({ stateDir, profile } = /** @type {any} */ ({})) {
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new TypeError('removeEndpoint: stateDir must be a non-empty string')
  }
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new TypeError('removeEndpoint: profile must be a non-empty string')
  }
  await rm(`${stateDir}/endpoints/${profile}.json`, { force: true })
}

/**
 * Read one profile's endpoint record.
 *
 * @param {object} input - Endpoint inputs.
 * @param {string} input.stateDir - Bridge state directory.
 * @param {string} input.profile - DSH profile name.
 * @returns {Promise<object | null>} Parsed record, or `null` when absent.
 * @throws {Error} When the file exists but is not parsable.
 */
export async function readEndpoint({ stateDir, profile } = /** @type {any} */ ({})) {
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new TypeError('readEndpoint: stateDir must be a non-empty string')
  }
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new TypeError('readEndpoint: profile must be a non-empty string')
  }
  return readJsonIfPresent(`${stateDir}/endpoints/${profile}.json`, `${stateDir}/endpoints/${profile}.json`)
}
