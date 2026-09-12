/**
 * Approval broker: the answerer that lets the desktop avatar decide host
 * permission requests.
 *
 * Non-negotiable behaviours (design doc sections 5.2.4 and 7):
 *   * no connected app -> `next()`, so the Web GUI keeps answering exactly as
 *     before the bridge existed;
 *   * a request without a `callId` -> `next()`: the host cannot address a
 *     decision for it, so it cannot be granted from here;
 *   * timeouts, disconnects and plugin disposal all DELEGATE rather than
 *     deciding — a bridge must never swallow a permission request;
 *   * only `allowed-once` / `rejected` / `cancelled` are ever returned, and the
 *     tool allowlist gates grants only;
 *   * every request and decision is appended to the audit log.
 */
import { APPROVAL_DECISIONS, approvalRequest as approvalRequestMessage, approvalSettled, truncateText } from './vendor/protocol/index.js';

/** Hard cap on simultaneously held requests. */
const MAX_PENDING = 16;

/** The only granting outcome in the host's closed set. */
const ALLOW_ONCE = 'allowed-once';
/** The explicit refusal outcome. */
const REJECTED = 'rejected';
/** The withdrawn-request outcome. */
const CANCELLED = 'cancelled';
/** The fail-closed outcome reported when a held card disappears. */
const UNAVAILABLE = 'unavailable';

/**
 * Create the approval broker.
 *
 * @param options - broker wiring.
 * @param options.config - parsed bridge config.
 * @param options.ipc - IPC server handle (for client counts and broadcasts).
 * @param options.audit - audit log handle.
 * @param options.lookupToolCall - `(sessionId, callId) => { name, args } | undefined`.
 * @param options.log - `(level, message)` sink.
 * @returns the broker handle.
 */
export function createApprovalBroker(options) {
  const { config, ipc, audit, lookupToolCall, log } = options;
  const pending = new Map();
  let nextId = 0;

  /** Whether the allowlist permits granting this tool from the desktop. */
  function mayGrant(toolName) {
    if (!Array.isArray(config.approvalToolAllowlist) || config.approvalToolAllowlist.length === 0) return true;
    return config.approvalToolAllowlist.includes(toolName);
  }

  /** Remove a record and run its settlement exactly once. */
  function finish(record, settle) {
    if (record.settled) return false;
    record.settled = true;
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.timer = undefined;
    pending.delete(record.id);
    settle();
    return true;
  }

  /** Answer a held request with a closed outcome. */
  function answer(record, outcome, reason) {
    const settled = finish(record, () => {
      record.resolve(outcome);
    });
    if (!settled) return false;
    ipc.broadcast(approvalSettled(record.id, outcome));
    audit.append({
      event: 'approval.decided',
      approvalId: record.id,
      sessionId: record.sessionId,
      toolName: record.toolName,
      callId: record.callId,
      outcome,
      reason,
      clientId: record.clientId,
      latencyMs: Date.now() - record.createdAt,
    });
    log('info', `approval ${record.id} (${record.toolName}) -> ${outcome} via ${reason}`);
    return true;
  }

  /** Give a held request back to the host waterfall. */
  function delegate(record, reason) {
    const settled = finish(record, () => {
      record.reject(record.delegated);
    });
    if (!settled) return false;
    ipc.broadcast(approvalSettled(record.id, UNAVAILABLE));
    audit.append({
      event: 'approval.delegated',
      approvalId: record.id,
      sessionId: record.sessionId,
      toolName: record.toolName,
      callId: record.callId,
      reason,
      latencyMs: Date.now() - record.createdAt,
    });
    log('debug', `approval ${record.id} delegated to the host chain (${reason})`);
    return true;
  }

  /** Serialize the arguments of the tool call a request refers to. */
  function argsFor(sessionId, callId) {
    const call = typeof lookupToolCall === 'function' ? lookupToolCall(sessionId, callId) : undefined;
    if (call?.args === undefined) return undefined;
    if (typeof call.args === 'string') return truncateText(call.args, config.activityMaxTextBytes);
    try {
      const text = JSON.stringify(call.args);
      if (text === undefined) return undefined;
      return text.length <= config.activityMaxTextBytes ? call.args : truncateText(text, config.activityMaxTextBytes);
    } catch {
      return undefined;
    }
  }

  /**
   * Handle one `approval/request` waterfall invocation.
   * @param request - the host approval request.
   * @param next - the waterfall continuation.
   * @returns the outcome for the host, or whatever the next answerer returns.
   */
  function handler(request, next) {
    if (config.approvalRouting === 'off') return next();
    if (pending.size >= MAX_PENDING) return next();
    if (ipc.readyClientCount() === 0) return next();
    const callId = typeof request?.callId === 'string' ? request.callId : undefined;
    if (callId === undefined) {
      // The host cannot address a decision without a call id; the ACP transport
      // has the same limitation and delegates here too.
      log('debug', 'approval without a callId delegated to the host chain');
      return next();
    }
    const toolName = typeof request?.toolName === 'string' ? request.toolName : 'tool';
    if (!mayGrant(toolName)) {
      log('debug', `approval for ${toolName} is outside approvalToolAllowlist; delegated`);
      return next();
    }
    const sessionId = typeof request?.agent?.session?.id === 'string' ? request.agent.session.id : '';
    nextId += 1;
    const id = `a${String(nextId)}`;
    let resolve;
    let reject;
    const result = new Promise((settleResolve, settleReject) => {
      resolve = settleResolve;
      reject = settleReject;
    });
    const record = {
      id,
      sessionId,
      toolName,
      callId,
      reason: typeof request?.reason === 'string' ? request.reason : undefined,
      args: argsFor(sessionId, callId),
      createdAt: Date.now(),
      deadlineAt: Date.now() + config.approvalTimeoutMs,
      clientId: undefined,
      settled: false,
      delegated: Symbol(`bridge-delegated:${id}`),
      timer: undefined,
      resolve,
      reject,
    };
    pending.set(id, record);
    record.timer = setTimeout(() => {
      delegate(record, 'timeout');
    }, config.approvalTimeoutMs);
    record.timer.unref?.();
    if (request?.signal !== undefined && typeof request.signal.addEventListener === 'function') {
      const onAbort = () => {
        answer(record, CANCELLED, 'host-aborted');
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted === true) onAbort();
    }

    ipc.broadcast(approvalRequestMessage({
      approvalId: id,
      sessionId,
      toolName,
      callId,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.args === undefined ? {} : { args: record.args }),
      deadlineAt: record.deadlineAt,
    }));
    audit.append({
      event: 'approval.requested',
      approvalId: id,
      sessionId,
      toolName,
      callId,
      reason: record.reason,
      routing: config.approvalRouting,
    });
    log('info', `approval ${id} (${toolName}) offered to ${String(ipc.readyClientCount())} client(s)`);

    return result.then(
      (outcome) => outcome,
      (error) => {
        if (error === record.delegated) return next();
        throw error;
      },
    );
  }

  /**
   * Apply one decision from a connected client.
   * @param client - the deciding client (recorded in the audit log).
   * @param approvalId - the held request id.
   * @param decision - `allow-once` or `reject`.
   * @returns the closed outcome that was returned to the host.
   */
  function decide(client, approvalId, decision) {
    if (!APPROVAL_DECISIONS.includes(decision)) {
      const error = new Error(`unsupported decision ${JSON.stringify(decision)}`);
      error.code = 'approval-invalid-decision';
      throw error;
    }
    const record = pending.get(approvalId);
    if (record === undefined) {
      const error = new Error('that approval is no longer pending');
      error.code = 'approval-not-found';
      throw error;
    }
    record.clientId = client?.id;
    const outcome = decision === 'allow-once' ? ALLOW_ONCE : REJECTED;
    if (!answer(record, outcome, 'client-decision')) {
      const error = new Error('that approval was already settled');
      error.code = 'approval-already-settled';
      throw error;
    }
    return outcome;
  }

  /** The pending cards a fresh client needs for its baseline. */
  function pendingMirrors() {
    return [...pending.values()].map((record) => ({
      approvalId: record.id,
      sessionId: record.sessionId,
      toolName: record.toolName,
      ...(record.callId === undefined ? {} : { callId: record.callId }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.args === undefined ? {} : { args: record.args }),
      deadlineAt: record.deadlineAt,
    }));
  }

  /** Hand every held request back to the host; used on plugin disposal. */
  function dispose() {
    for (const record of [...pending.values()]) delegate(record, 'bridge-disposed');
  }

  return {
    handler,
    decide,
    pendingMirrors,
    dispose,
    get pendingCount() {
      return pending.size;
    },
    /** Outcome vocabulary, exposed for tests. */
    outcomes: Object.freeze({ ALLOW_ONCE, REJECTED, CANCELLED, UNAVAILABLE }),
  };
}
