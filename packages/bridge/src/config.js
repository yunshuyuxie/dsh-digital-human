/**
 * Bridge configuration: hand-rolled validation with zero dependencies (design.md §5.2.1).
 *
 * The plugin deliberately exports no `Config` schema (that would pull in
 * `@deepseek-ai/schemastery`), so every field is checked here and any invalid value fails loud
 * with an `Error` that names the field and the accepted shape.
 *
 * @module dsh-digital-human-bridge/config
 */

import { homedir } from 'node:os'

import { MAX_FRAME_BYTES_DEFAULT } from './vendor/protocol/index.js'

/**
 * Accepted values of `approvalRouting`.
 *
 * @type {readonly string[]}
 */
const ROUTING_MODES = Object.freeze(['primary', 'fallback', 'off'])

/**
 * Characters that must never appear in a pipe name: path separators would let config escape the
 * state directory, and NUL would produce an unusable OS path.
 *
 * @type {RegExp}
 */
const PIPE_NAME_FORBIDDEN = /[/\\\u0000]/

/**
 * Raise the uniform configuration error.
 *
 * @param {string} field - Field name as it appears in the raw config.
 * @param {string} expected - Human-readable description of the accepted shape.
 * @returns {never} Always throws.
 */
function reject(field, expected) {
  throw new Error(`digital-human-bridge: invalid config field "${field}": expected ${expected}`)
}

/**
 * Validate an optional boolean field.
 *
 * @param {unknown} value - Raw value.
 * @param {string} field - Field name, for the error message.
 * @returns {boolean} The validated value.
 */
function checkBoolean(value, field) {
  if (typeof value !== 'boolean') reject(field, 'a boolean')
  return value
}

/**
 * Validate an optional integer field with an inclusive range.
 *
 * @param {unknown} value - Raw value.
 * @param {string} field - Field name, for the error message.
 * @param {{ min: number, max: number }} range - Inclusive bounds.
 * @returns {number} The validated value.
 */
function checkInteger(value, field, range) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range.min || value > range.max) {
    reject(field, `an integer between ${range.min} and ${range.max}`)
  }
  return value
}

/**
 * Validate an optional non-empty string field.
 *
 * @param {unknown} value - Raw value.
 * @param {string} field - Field name, for the error message.
 * @returns {string} The validated value.
 */
function checkNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) reject(field, 'a non-empty string')
  return value
}

/**
 * Default state directory for a DSH home: `<home>/digital-human`.
 *
 * @param {string} home - DSH home directory.
 * @returns {string} The bridge state directory.
 */
export function defaultStateDir(home) {
  return `${home}/digital-human`
}

/**
 * Resolve the DSH home directory that the bridge should write under.
 *
 * Order: `context.home`, then `DSH_HOME`, then `<os.homedir()>/.dsh`.
 *
 * @param {{ home?: string }} [context] - Plugin context.
 * @returns {string} Absolute-ish home directory, without a trailing separator.
 */
function resolveHome(context) {
  const fromContext = context?.home
  if (typeof fromContext === 'string' && fromContext.length > 0) return trimTrailingSeparators(fromContext)
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return trimTrailingSeparators(fromEnv)
  return trimTrailingSeparators(`${homedir()}/.dsh`)
}

/**
 * Drop trailing path separators so `<home>/digital-human` never doubles a slash.
 *
 * @param {string} value - Path to normalize.
 * @returns {string} Path without trailing separators (except a bare root).
 */
function trimTrailingSeparators(value) {
  let end = value.length
  while (end > 1 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1
  return value.slice(0, end)
}

/**
 * Validate and normalize the raw plugin config.
 *
 * Unknown keys are ignored so a newer caller (or a future App) can pass extra options without
 * breaking an older bridge. The returned object and its array fields are frozen.
 *
 * @param {unknown} [raw] - Raw config object handed to `apply(ctx, rawConfig)`.
 * @param {{ profile?: string, home?: string }} [context] - Plugin context.
 * @returns {Readonly<object>} Frozen, fully-defaulted config.
 * @throws {Error} When `raw` is not an object or any known field is invalid.
 */
export function parseConfig(raw, context) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    reject('config', 'an object')
  }
  /** @type {Record<string, unknown>} */
  const input = raw ?? {}
  const profile = checkNonEmptyString(context?.profile ?? 'default', 'profile')
  const stateDir = defaultStateDir(resolveHome(context))

  const enabled = input.enabled === undefined ? true : checkBoolean(input.enabled, 'enabled')

  let pipeName
  if (input.pipeName === undefined) {
    pipeName = `dsh-digital-human-${profile}`
  } else {
    pipeName = checkNonEmptyString(input.pipeName, 'pipeName')
    if (pipeName.length > 200) reject('pipeName', 'a string of at most 200 characters')
    if (PIPE_NAME_FORBIDDEN.test(pipeName)) reject('pipeName', 'a string without "/", "\\" or NUL')
  }

  let approvalRouting = 'primary'
  if (input.approvalRouting !== undefined) {
    if (typeof input.approvalRouting !== 'string' || !ROUTING_MODES.includes(input.approvalRouting)) {
      reject('approvalRouting', `one of ${ROUTING_MODES.join(', ')}`)
    }
    approvalRouting = input.approvalRouting
  }

  const approvalTimeoutMs =
    input.approvalTimeoutMs === undefined
      ? 120000
      : checkInteger(input.approvalTimeoutMs, 'approvalTimeoutMs', { min: 1000, max: Number.MAX_SAFE_INTEGER })

  let approvalToolAllowlist = Object.freeze([])
  if (input.approvalToolAllowlist !== undefined) {
    if (!Array.isArray(input.approvalToolAllowlist)) {
      reject('approvalToolAllowlist', 'an array of non-empty strings')
    }
    for (const entry of input.approvalToolAllowlist) {
      if (typeof entry !== 'string' || entry.length === 0) {
        reject('approvalToolAllowlist', 'an array of non-empty strings')
      }
    }
    approvalToolAllowlist = Object.freeze([...input.approvalToolAllowlist])
  }

  const activityBufferPerSession =
    input.activityBufferPerSession === undefined
      ? 200
      : checkInteger(input.activityBufferPerSession, 'activityBufferPerSession', { min: 1, max: 10000 })

  const activityMaxTextBytes =
    input.activityMaxTextBytes === undefined
      ? 2048
      : checkInteger(input.activityMaxTextBytes, 'activityMaxTextBytes', { min: 64, max: 1048576 })

  const maxClients = input.maxClients === undefined ? 4 : checkInteger(input.maxClients, 'maxClients', { min: 1, max: 64 })

  const maxFrameBytes =
    input.maxFrameBytes === undefined
      ? MAX_FRAME_BYTES_DEFAULT
      : checkInteger(input.maxFrameBytes, 'maxFrameBytes', { min: 1024, max: 16777216 })

  const writeBufferLimitBytes =
    input.writeBufferLimitBytes === undefined
      ? 4194304
      : checkInteger(input.writeBufferLimitBytes, 'writeBufferLimitBytes', { min: 65536, max: 268435456 })

  const auditFile =
    input.auditFile === undefined ? `${stateDir}/audit.jsonl` : checkNonEmptyString(input.auditFile, 'auditFile')

  const pipePath =
    process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : `${stateDir}/${pipeName}.sock`

  return Object.freeze({
    enabled,
    pipeName,
    approvalRouting,
    approvalTimeoutMs,
    approvalToolAllowlist,
    activityBufferPerSession,
    activityMaxTextBytes,
    maxClients,
    maxFrameBytes,
    writeBufferLimitBytes,
    auditFile,
    profile,
    stateDir,
    pipePath,
  })
}
