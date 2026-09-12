/**
 * Shared protocol layer for the dsh digital-human desktop App and the local IPC bridge
 * (design.md §5.1). Zero dependencies, plain ESM, no build step.
 *
 * @module dsh-digital-human-protocol
 */

export {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES_DEFAULT,
  HANDSHAKE_TIMEOUT_MS,
  METHODS,
  EVENT_NAMES,
  ACTIVITY_KINDS,
  APPROVAL_DECISIONS,
  APPROVAL_OUTCOMES,
  CAPABILITIES,
  NOTICE_LEVELS,
  hello,
  welcome,
  ready,
  rpc,
  result,
  error,
  event,
  baseline,
  sessionsChanged,
  controlFrame,
  activity,
  approvalRequest,
  approvalSettled,
  bridgeNotice,
} from './messages.js'

export {
  ProtocolError,
  isJsonValue,
  validateHello,
  validateWelcome,
  validateReady,
  validateRpc,
  validateResult,
  validateError,
  validateEvent,
  validateFrame,
  validateActivity,
  validateSessionSummary,
  validateDecision,
  validateApprovalOutcome,
  validateNoticeLevel,
  assertOk,
} from './guards.js'

export { encodeFrame, createFrameDecoder, truncateText } from './codec.js'
