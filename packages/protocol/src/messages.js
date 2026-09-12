/**
 * Pure message constructors for the digital-human local IPC protocol (NDJSON, design.md §5.1).
 *
 * Every constructor returns a plain object carrying a `type` discriminator. Optional keys are
 * omitted when their argument is `undefined`, so producers never emit `"key": undefined`
 * (which JSON.stringify would silently drop anyway).
 *
 * @module dsh-digital-human-protocol/messages
 */

/** Protocol revision understood by both sides of the pipe. */
export const PROTOCOL_VERSION = 1

/** Default single-frame byte ceiling (256 KiB). */
export const MAX_FRAME_BYTES_DEFAULT = 262144

/** Milliseconds a connection may stay unauthenticated before the server drops it. */
export const HANDSHAKE_TIMEOUT_MS = 5000

/** RPC method names. */
export const METHODS = Object.freeze({
  SESSIONS_LIST: 'sessions.list',
  SESSIONS_MODELS: 'sessions.models',
  SESSION_SUBSCRIBE: 'session.subscribe',
  SESSION_UNSUBSCRIBE: 'session.unsubscribe',
  SESSION_RENAME: 'session.rename',
  COMMAND_CREATE: 'command.create',
  COMMAND_PROMPT: 'command.prompt',
  COMMAND_CANCEL: 'command.cancel',
  COMMAND_SELECT_MODEL: 'command.selectModel',
  APPROVAL_DECIDE: 'approval.decide',
  PING: 'ping',
})

/** Server-pushed event names. */
export const EVENT_NAMES = Object.freeze({
  BASELINE: 'baseline',
  SESSIONS_CHANGED: 'sessions.changed',
  CONTROL_FRAME: 'control.frame',
  ACTIVITY: 'activity',
  APPROVAL_REQUEST: 'approval.request',
  APPROVAL_SETTLED: 'approval.settled',
  BRIDGE_NOTICE: 'bridge.notice',
})

/** Activity entry kinds mirrored from DSH host events. */
export const ACTIVITY_KINDS = Object.freeze([
  'turn/start',
  'turn/end',
  'tool/call',
  'tool/result',
  'assistant/message',
  'agent/error',
])

/** Decisions an App may return for an approval card. */
export const APPROVAL_DECISIONS = Object.freeze(['allow-once', 'reject'])

/** Closed outcome vocabulary of the DSH host approval waterfall. */
export const APPROVAL_OUTCOMES = Object.freeze([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
])

/** Bridge capabilities advertised in `welcome`. */
export const CAPABILITIES = Object.freeze([
  'control',
  'activity',
  'approvals',
  'prompt',
  'cancel',
  'create',
  'selectModel',
])

/** Bridge notice levels. */
export const NOTICE_LEVELS = Object.freeze(['info', 'warn'])

/**
 * Build a client `hello` frame.
 *
 * @param {object} input - Handshake fields.
 * @param {number} input.protocol - Protocol revision, must equal `PROTOCOL_VERSION`.
 * @param {string} input.clientId - Stable App instance id (`app-<uuid>`).
 * @param {string} input.clientName - Human-readable client name (usually the hostname).
 * @param {string} input.token - Shared token read from the endpoint secret file.
 * @param {string} input.clientNonce - Base64 16-byte nonce for the mutual proof.
 * @returns {{type: 'hello', protocol: number, clientId: string, clientName: string, token: string, clientNonce: string}} Hello frame.
 */
export function hello({ protocol, clientId, clientName, token, clientNonce }) {
  return { type: 'hello', protocol, clientId, clientName, token, clientNonce }
}

/**
 * Build a server `welcome` frame.
 *
 * @param {object} input - Handshake fields.
 * @param {number} input.protocol - Protocol revision, must equal `PROTOCOL_VERSION`.
 * @param {string} input.host - Hostname of the dsh machine.
 * @param {string} input.profile - Active dsh profile.
 * @param {number} input.pid - dsh process id.
 * @param {string} input.bridgeVersion - Bridge package version.
 * @param {string} input.dshVersion - DSH version serving the profile.
 * @param {string[]} input.capabilities - Advertised capabilities.
 * @param {string} input.serverNonce - Base64 16-byte nonce for the mutual proof.
 * @param {string} input.proof - Base64 HMAC-SHA256(token, clientNonce ‖ serverNonce).
 * @returns {{type: 'welcome', protocol: number, host: string, profile: string, pid: number, bridgeVersion: string, dshVersion: string, capabilities: string[], serverNonce: string, proof: string}} Welcome frame.
 */
export function welcome({ protocol, host, profile, pid, bridgeVersion, dshVersion, capabilities, serverNonce, proof }) {
  return {
    type: 'welcome',
    protocol,
    host,
    profile,
    pid,
    bridgeVersion,
    dshVersion,
    capabilities,
    serverNonce,
    proof,
  }
}

/**
 * Build a client `ready` frame, sent only after the server proof verified.
 *
 * @returns {{type: 'ready'}} Ready frame.
 */
export function ready() {
  return { type: 'ready' }
}

/**
 * Build an RPC request frame.
 *
 * @param {string} id - Client-chosen correlation id.
 * @param {string} method - One of `METHODS`.
 * @param {object} [params] - Method parameters.
 * @returns {{type: 'rpc', id: string, method: string, params: object}} RPC frame.
 */
export function rpc(id, method, params = {}) {
  return { type: 'rpc', id, method, params }
}

/**
 * Build an RPC success frame.
 *
 * @param {string} id - Correlation id of the request.
 * @param {unknown} value - JSON-serializable result payload.
 * @returns {{type: 'result', id: string, value: unknown}} Result frame.
 */
export function result(id, value) {
  return { type: 'result', id, value }
}

/**
 * Build an RPC error frame. `details` is present only when supplied.
 *
 * @param {string} id - Correlation id of the request.
 * @param {string} code - Stable machine-readable error code.
 * @param {string} message - Human-readable message.
 * @param {unknown} [details] - Optional JSON-serializable details.
 * @returns {{type: 'error', id: string, code: string, message: string, details?: unknown}} Error frame.
 */
export function error(id, code, message, details) {
  const frame = { type: 'error', id, code, message }
  if (details !== undefined) frame.details = details
  return frame
}

/**
 * Build a server event frame.
 *
 * @param {string} event - One of `EVENT_NAMES`.
 * @param {unknown} data - Event payload.
 * @returns {{type: 'event', event: string, data: unknown}} Event frame.
 */
export function event(event, data) {
  return { type: 'event', event, data }
}

/**
 * Build the post-handshake baseline event that wholly replaces App state.
 *
 * @param {object} input - Baseline payload.
 * @param {Array<object>} input.sessions - Session summary mirrors.
 * @param {object} input.control - Session control frame (queue / jobs / projection).
 * @param {Array<object>} input.approvals - Pending approval mirrors.
 * @returns {{type: 'event', event: string, data: {sessions: Array<object>, control: object, approvals: Array<object>}}} Baseline event.
 */
export function baseline({ sessions, control, approvals }) {
  return event(EVENT_NAMES.BASELINE, { sessions, control, approvals })
}

/**
 * Build a session-list delta event. Absent groups are omitted.
 *
 * @param {object} input - Delta payload.
 * @param {Array<object>} [input.upsert] - Added or changed session summaries.
 * @param {string[]} [input.removed] - Removed session ids.
 * @returns {{type: 'event', event: string, data: {upsert?: Array<object>, removed?: string[]}}} Session delta event.
 */
export function sessionsChanged({ upsert, removed }) {
  const data = {}
  if (upsert !== undefined) data.upsert = upsert
  if (removed !== undefined) data.removed = removed
  return event(EVENT_NAMES.SESSIONS_CHANGED, data)
}

/**
 * Build a control-frame event, forwarded verbatim from `sessionController.control`.
 *
 * @param {object} frame - Session control frame.
 * @returns {{type: 'event', event: string, data: object}} Control event.
 */
export function controlFrame(frame) {
  return event(EVENT_NAMES.CONTROL_FRAME, frame)
}

/**
 * Build an activity event.
 *
 * @param {object} entry - Activity entry, see `validateActivity`.
 * @returns {{type: 'event', event: string, data: object}} Activity event.
 */
export function activity(entry) {
  return event(EVENT_NAMES.ACTIVITY, entry)
}

/**
 * Build an approval request event. Absent optional keys are omitted.
 *
 * @param {object} input - Approval fields.
 * @param {string} input.approvalId - Bridge-assigned approval id.
 * @param {string} input.sessionId - Session awaiting the approval.
 * @param {string} input.toolName - Tool requesting authorization.
 * @param {string} [input.callId] - Host call id; approvals without one cannot be answered.
 * @param {string} [input.reason] - Reason supplied by the tool.
 * @param {unknown} [input.args] - Tool arguments (already truncated by the bridge).
 * @param {number} input.deadlineAt - Epoch milliseconds after which the bridge delegates.
 * @returns {{type: 'event', event: string, data: object}} Approval request event.
 */
export function approvalRequest({ approvalId, sessionId, toolName, callId, reason, args, deadlineAt }) {
  const data = { approvalId, sessionId, toolName }
  if (callId !== undefined) data.callId = callId
  if (reason !== undefined) data.reason = reason
  if (args !== undefined) data.args = args
  data.deadlineAt = deadlineAt
  return event(EVENT_NAMES.APPROVAL_REQUEST, data)
}

/**
 * Build an approval settled event, broadcast so every App instance drops its card.
 *
 * @param {string} approvalId - Approval id being settled.
 * @param {string} outcome - One of `APPROVAL_OUTCOMES`.
 * @returns {{type: 'event', event: string, data: {approvalId: string, outcome: string}}} Approval settled event.
 */
export function approvalSettled(approvalId, outcome) {
  return event(EVENT_NAMES.APPROVAL_SETTLED, { approvalId, outcome })
}

/**
 * Build a bridge notice event.
 *
 * @param {string} level - `'info'` or `'warn'`.
 * @param {string} code - Stable machine-readable notice code.
 * @param {string} message - Human-readable message.
 * @returns {{type: 'event', event: string, data: {level: string, code: string, message: string}}} Bridge notice event.
 */
export function bridgeNotice(level, code, message) {
  if (!NOTICE_LEVELS.includes(level)) {
    throw new TypeError(`bridgeNotice: level must be one of ${NOTICE_LEVELS.join(', ')}, got ${JSON.stringify(level)}`)
  }
  return event(EVENT_NAMES.BRIDGE_NOTICE, { level, code, message })
}
