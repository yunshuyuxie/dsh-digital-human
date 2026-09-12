/**
 * Hand-written frame validators for the digital-human local IPC protocol (design.md §5.1).
 *
 * Every `validate*` function is total and non-throwing: it returns `undefined` on success or a
 * human-readable message string on failure. Callers that prefer exceptions use `assertOk`.
 * Unknown message types intentionally validate as successful ("not my problem") — `validateFrame`
 * is the single place that turns an unknown `type` into a rejection.
 *
 * @module dsh-digital-human-protocol/guards
 */

import {
  ACTIVITY_KINDS,
  APPROVAL_DECISIONS,
  APPROVAL_OUTCOMES,
  NOTICE_LEVELS,
  PROTOCOL_VERSION,
} from './messages.js'

/**
 * Error thrown by protocol consumers, and by `assertOk` on a failed validation.
 */
export class ProtocolError extends Error {
  /**
   * @param {string} message - Human-readable description.
   * @param {object} [options] - Error options.
   * @param {string} [options.code] - Machine-readable error code.
   * @param {unknown} [options.details] - Extra JSON-serializable details.
   * @param {Error} [options.cause] - Underlying error.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProtocolError'
    /** @type {string} Machine-readable error code. */
    this.code = options.code === undefined ? 'protocol-invalid-frame' : options.code
    if (options.details !== undefined) this.details = options.details
  }
}

const OBJECT_PROTO = Object.prototype
const hasOwn = (value, key) => OBJECT_PROTO.hasOwnProperty.call(value, key)
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === OBJECT_PROTO || Object.getPrototypeOf(value) === null)

/**
 * Describe a value for error messages without ever throwing.
 *
 * @param {unknown} value - Value to describe.
 * @returns {string} Short type description, e.g. `string` or `null`.
 */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Deep-check that a value survives `JSON.stringify`/`JSON.parse` unchanged.
 *
 * Accepts only `null`, booleans, finite numbers, strings, arrays of accepted values and plain
 * objects of accepted values. Rejects `undefined`, functions, symbols, bigint, non-finite
 * numbers, class instances, boxed primitives and cyclic structures.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when the value is a plain JSON value.
 */
export function isJsonValue(value) {
  return checkJson(value, new Set())
}

/**
 * Recursive worker for `isJsonValue`, carrying the ancestor set for cycle detection.
 *
 * @param {unknown} value - Value to inspect.
 * @param {Set<object>} ancestors - Objects on the current path only.
 * @returns {boolean} True when the value is a plain JSON value.
 */
function checkJson(value, ancestors) {
  if (value === null) return true
  const type = typeof value
  if (type === 'boolean' || type === 'string') return true
  if (type === 'number') return Number.isFinite(value)
  if (type !== 'object') return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.constructor !== Array) return false
      for (const item of value) {
        if (!checkJson(item, ancestors)) return false
      }
      return true
    }
    if (!isPlainObject(value) || hasOwn(value, 'constructor')) return false
    for (const key of Object.keys(value)) {
      if (!checkJson(value[key], ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Validate an optional value against a predicate.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Optional key.
 * @param {string} expected - Expected type label.
 * @param {(candidate: unknown) => boolean} predicate - Type predicate.
 * @returns {string | undefined} Failure message, if any.
 */
function checkOptionalTyped(value, key, expected, predicate) {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined
  return predicate(value[key]) ? undefined : `${key}: expected ${expected}, got ${describe(value[key])}`
}

/**
 * Validate the `type` discriminator of a frame.
 *
 * @param {unknown} value - Candidate frame.
 * @param {string} name - Expected `type` value.
 * @returns {string | undefined} Failure message, if any.
 */
function checkType(value, name) {
  if (!isPlainObject(value)) return `expected an object, got ${describe(value)}`
  return value.type === name ? undefined : `type: expected ${JSON.stringify(name)}, got ${JSON.stringify(value.type)}`
}

/**
 * Validate a required string field.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Required key.
 * @returns {string | undefined} Failure message, if any.
 */
function checkString(value, key) {
  if (!hasOwn(value, key) || value[key] === undefined) return `${key}: missing required string field`
  return typeof value[key] === 'string' ? undefined : `${key}: expected string, got ${describe(value[key])}`
}

/**
 * Validate an optional string field.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Optional key.
 * @returns {string | undefined} Failure message, if any.
 */
function checkOptionalString(value, key) {
  return checkOptionalTyped(value, key, 'string', (candidate) => typeof candidate === 'string')
}

/**
 * Validate a required finite number field.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Required key.
 * @returns {string | undefined} Failure message, if any.
 */
function checkNumber(value, key) {
  if (!hasOwn(value, key) || value[key] === undefined) return `${key}: missing required number field`
  return Number.isFinite(value[key]) ? undefined : `${key}: expected a finite number, got ${JSON.stringify(value[key])}`
}

/**
 * Validate a required boolean field.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Required key.
 * @returns {string | undefined} Failure message, if any.
 */
function checkBoolean(value, key) {
  if (!hasOwn(value, key) || value[key] === undefined) return `${key}: missing required boolean field`
  return typeof value[key] === 'boolean' ? undefined : `${key}: expected boolean, got ${describe(value[key])}`
}

/**
 * Validate a required enum field.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Required key.
 * @param {readonly string[]} allowed - Allowed values.
 * @returns {string | undefined} Failure message, if any.
 */
function checkEnum(value, key, allowed) {
  if (!hasOwn(value, key) || value[key] === undefined) return `${key}: missing required field`
  return allowed.includes(value[key])
    ? undefined
    : `${key}: expected one of ${allowed.join(', ')}, got ${JSON.stringify(value[key])}`
}

/**
 * Validate a required JSON value field.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Required key.
 * @returns {string | undefined} Failure message, if any.
 */
function checkJsonField(value, key) {
  if (!hasOwn(value, key) || value[key] === undefined) return `${key}: missing required field`
  return isJsonValue(value[key]) ? undefined : `${key}: expected a JSON value`
}

/**
 * Validate a required array of strings.
 *
 * @param {object} value - Owner object.
 * @param {string} key - Required key.
 * @returns {string | undefined} Failure message, if any.
 */
function checkStringArray(value, key) {
  if (!hasOwn(value, key) || value[key] === undefined) return `${key}: missing required field`
  if (!Array.isArray(value[key])) return `${key}: expected array, got ${describe(value[key])}`
  for (const item of value[key]) {
    if (typeof item !== 'string') return `${key}: expected array of strings, got ${describe(item)}`
  }
  return undefined
}

/**
 * Reject keys outside the protocol vocabulary of a message.
 *
 * @param {object} value - Owner object.
 * @param {readonly string[]} allowed - Allowed keys.
 * @returns {string | undefined} Failure message, if any.
 */
function checkKnownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return `${key}: unknown field`
  }
  return undefined
}

/**
 * Return the first failure message produced by the given checks.
 *
 * @param {Array<string | undefined>} results - Check outcomes in order.
 * @returns {string | undefined} First failure message, if any.
 */
function firstFailure(results) {
  for (const failure of results) {
    if (failure !== undefined) return failure
  }
  return undefined
}

/**
 * Validate a client `hello` frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateHello(value) {
  const typeFailure = checkType(value, 'hello')
  if (typeFailure !== undefined) return typeFailure
  return firstFailure([
    checkString(value, 'clientId'),
    checkString(value, 'clientName'),
    checkString(value, 'token'),
    checkString(value, 'clientNonce'),
    value.protocol === PROTOCOL_VERSION
      ? undefined
      : `protocol: expected ${PROTOCOL_VERSION}, got ${JSON.stringify(value.protocol)}`,
    checkKnownKeys(value, ['type', 'protocol', 'clientId', 'clientName', 'token', 'clientNonce']),
  ])
}

/**
 * Validate a server `welcome` frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateWelcome(value) {
  const typeFailure = checkType(value, 'welcome')
  if (typeFailure !== undefined) return typeFailure
  return firstFailure([
    checkString(value, 'host'),
    checkString(value, 'profile'),
    checkNumber(value, 'pid'),
    checkString(value, 'bridgeVersion'),
    checkString(value, 'dshVersion'),
    checkStringArray(value, 'capabilities'),
    checkString(value, 'serverNonce'),
    checkString(value, 'proof'),
    value.protocol === PROTOCOL_VERSION
      ? undefined
      : `protocol: expected ${PROTOCOL_VERSION}, got ${JSON.stringify(value.protocol)}`,
    checkKnownKeys(value, [
      'type', 'protocol', 'host', 'profile', 'pid', 'bridgeVersion',
      'dshVersion', 'capabilities', 'serverNonce', 'proof',
    ]),
  ])
}

/**
 * Validate a client `ready` frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateReady(value) {
  const typeFailure = checkType(value, 'ready')
  if (typeFailure !== undefined) return typeFailure
  return checkKnownKeys(value, ['type'])
}

/**
 * Validate an RPC request frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateRpc(value) {
  const typeFailure = checkType(value, 'rpc')
  if (typeFailure !== undefined) return typeFailure
  return firstFailure([
    checkString(value, 'id'),
    checkString(value, 'method'),
    checkJsonField(value, 'params'),
    checkKnownKeys(value, ['type', 'id', 'method', 'params']),
  ])
}

/**
 * Validate an RPC success frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateResult(value) {
  const typeFailure = checkType(value, 'result')
  if (typeFailure !== undefined) return typeFailure
  return firstFailure([
    checkString(value, 'id'),
    checkJsonField(value, 'value'),
    checkKnownKeys(value, ['type', 'id', 'value']),
  ])
}

/**
 * Validate an RPC error frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateError(value) {
  const typeFailure = checkType(value, 'error')
  if (typeFailure !== undefined) return typeFailure
  return firstFailure([
    checkString(value, 'id'),
    checkString(value, 'code'),
    checkString(value, 'message'),
    checkOptionalTyped(value, 'details', 'a JSON value', isJsonValue),
    checkKnownKeys(value, ['type', 'id', 'code', 'message', 'details']),
  ])
}

/**
 * Validate a server event frame.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateEvent(value) {
  const typeFailure = checkType(value, 'event')
  if (typeFailure !== undefined) return typeFailure
  return firstFailure([
    checkString(value, 'event'),
    checkJsonField(value, 'data'),
    checkKnownKeys(value, ['type', 'event', 'data']),
  ])
}

/**
 * Validate an activity entry pushed inside an `activity` event.
 *
 * @param {unknown} value - Candidate entry.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateActivity(value) {
  if (!isPlainObject(value)) return `expected an object, got ${describe(value)}`
  return firstFailure([
    checkString(value, 'sessionId'),
    checkNumber(value, 'seq'),
    checkEnum(value, 'kind', ACTIVITY_KINDS),
    checkOptionalString(value, 'tool'),
    checkOptionalString(value, 'status'),
    checkOptionalString(value, 'text'),
    checkOptionalTyped(value, 'truncated', 'boolean', (candidate) => typeof candidate === 'boolean'),
    checkOptionalTyped(value, 'args', 'a JSON value', isJsonValue),
    checkKnownKeys(value, ['sessionId', 'seq', 'kind', 'tool', 'status', 'text', 'truncated', 'args']),
  ])
}

/**
 * Validate a `SessionSummaryMirror` row.
 *
 * @param {unknown} value - Candidate summary.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateSessionSummary(value) {
  if (!isPlainObject(value)) return `expected an object, got ${describe(value)}`
  return firstFailure([
    checkString(value, 'id'),
    checkString(value, 'displayTitle'),
    checkBoolean(value, 'running'),
    checkBoolean(value, 'blank'),
    checkNumber(value, 'updatedAt'),
    checkOptionalString(value, 'cwd'),
    checkOptionalString(value, 'lastAgentError'),
    // A child session names its parent so a client can fold it away instead of
    // listing subagent work as if it were a session the user started.
    checkOptionalString(value, 'parentId'),
    checkOptionalString(value, 'origin'),
    checkOptionalString(value, 'model'),
    checkKnownKeys(value, [
      'id', 'displayTitle', 'cwd', 'running', 'blank', 'updatedAt', 'lastAgentError',
      'parentId', 'origin', 'model',
    ]),
  ])
}

/**
 * Validate an approval decision sent by an App.
 *
 * @param {unknown} decision - Candidate decision.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateDecision(decision) {
  return APPROVAL_DECISIONS.includes(decision)
    ? undefined
    : `decision: expected one of ${APPROVAL_DECISIONS.join(', ')}, got ${JSON.stringify(decision)}`
}

/**
 * Validate an approval outcome reported in `approval.settled`.
 *
 * @param {unknown} outcome - Candidate outcome.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateApprovalOutcome(outcome) {
  return APPROVAL_OUTCOMES.includes(outcome)
    ? undefined
    : `outcome: expected one of ${APPROVAL_OUTCOMES.join(', ')}, got ${JSON.stringify(outcome)}`
}

/**
 * Validate a bridge notice level.
 *
 * @param {unknown} level - Candidate level.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateNoticeLevel(level) {
  return NOTICE_LEVELS.includes(level)
    ? undefined
    : `level: expected one of ${NOTICE_LEVELS.join(', ')}, got ${JSON.stringify(level)}`
}

/**
 * Validate any frame by dispatching on its `type`.
 *
 * An unknown `type` (including a completely absent one) yields a failure, so callers treat it as
 * invalid. Payloads of known events are validated with their entry guards.
 *
 * @param {unknown} value - Candidate frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
export function validateFrame(value) {
  if (!isPlainObject(value)) return `expected an object, got ${describe(value)}`
  switch (value.type) {
    case 'hello':
      return validateHello(value)
    case 'welcome':
      return validateWelcome(value)
    case 'ready':
      return validateReady(value)
    case 'rpc':
      return validateRpc(value)
    case 'result':
      return validateResult(value)
    case 'error':
      return validateError(value)
    case 'event':
      return validateEventPayload(value)
    default:
      return `type: unknown message type ${JSON.stringify(value.type)}`
  }
}

/**
 * Validate an event frame together with the payload shape of the events this package defines.
 *
 * @param {object} value - Candidate event frame.
 * @returns {string | undefined} Failure message, or `undefined` when valid.
 */
function validateEventPayload(value) {
  const frameFailure = validateEvent(value)
  if (frameFailure !== undefined) return frameFailure
  const data = value.data
  switch (value.event) {
    case 'activity':
      return validateActivity(data)
    case 'sessions.changed':
      return firstFailure([
        checkOptionalTyped(data, 'upsert', 'array', Array.isArray),
        checkOptionalTyped(data, 'removed', 'array', Array.isArray),
      ])
    case 'approval.settled':
      return firstFailure([checkString(data, 'approvalId'), checkEnum(data, 'outcome', APPROVAL_OUTCOMES)])
    case 'approval.request':
      return firstFailure([
        checkString(data, 'approvalId'),
        checkString(data, 'sessionId'),
        checkString(data, 'toolName'),
        checkOptionalString(data, 'callId'),
        checkOptionalString(data, 'reason'),
        checkOptionalTyped(data, 'args', 'a JSON value', isJsonValue),
        checkNumber(data, 'deadlineAt'),
      ])
    case 'bridge.notice':
      return firstFailure([
        checkEnum(data, 'level', NOTICE_LEVELS),
        checkString(data, 'code'),
        checkString(data, 'message'),
      ])
    default:
      return undefined
  }
}

/**
 * Throw a `ProtocolError` when a validation returned a message.
 *
 * @param {string | undefined} validation - Result of a `validate*` call.
 * @param {string} context - Caller-supplied context, e.g. `'welcome'` or `'frame'`.
 * @returns {void}
 * @throws {ProtocolError} When `validation` is a failure message.
 */
export function assertOk(validation, context) {
  if (validation === undefined) return
  throw new ProtocolError(`${context}: ${validation}`, { code: 'protocol-invalid-frame' })
}
