/**
 * One answerable presentation of a forwarded Host approval request.
 *
 * Mirrors the shipped approval panel's contract: the request is held until the
 * digital human answers it, delegates it down the waterfall, or its lifetime
 * ends by abort. The outcome vocabulary is the Host's closed set —
 * `allowed-once` is the only grant.
 */

/** The only granting outcome. */
const ALLOW_ONCE = 'allowed-once';
/** The explicit refusal outcome. */
const REJECTED = 'rejected';

/**
 * Cross-domain pending-interaction precedence. `dsh-client-ui-approval` uses 0
 * and `dsh-client-ui-user-questions` uses 1 (2 for plan review), so the digital
 * human outranks the approval panel it replaces while a question still wins.
 */
const APPROVAL_PRECEDENCE = 0.5;

let nextKey = 0;

/** One decision the digital human is holding open. */
class PendingApproval {
  /**
   * @param sessionId - the session whose agent asked for the decision.
   * @param request - Host approval request projected through the Remote Event.
   */
  constructor(sessionId, request) {
    this.sessionId = sessionId;
    this.kind = 'approval';
    nextKey += 1;
    this.key = `digital-human:approval:${String(nextKey)}`;
    this.toolName = request.toolName;
    this.callId = request.callId;
    this.reason = request.reason;
    this.outcome = undefined;

    let settle;
    let fail;
    this.result = new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.#resolve = settle;
    this.#reject = fail;
    this.#delegated = Symbol('digital-human:approval delegated');
    this.#settled = false;

    const signal = request.signal;
    if (signal === undefined) return;
    const onAbort = () => {
      this.abort(signal.reason ?? new Error('approval request was aborted'));
    };
    this.#signal = signal;
    this.#onAbort = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  #resolve;

  #reject;

  #signal;

  #onAbort;

  #delegated;

  #settled;

  /**
   * Answer the waiting Host waterfall.
   * @param outcome - `allowed-once` or `rejected`.
   * @returns whether this call settled the request.
   */
  answer(outcome) {
    if (this.#settled) return false;
    this.outcome = outcome;
    this.#finish(() => {
      this.#resolve(outcome);
    });
    return true;
  }

  /** Allow this one operation. */
  allow() {
    return this.answer(ALLOW_ONCE);
  }

  /** Refuse this operation. */
  reject() {
    return this.answer(REJECTED);
  }

  /** Hand the request to the next waterfall listener. */
  delegate() {
    if (this.#settled) return;
    this.#finish(() => {
      this.#reject(this.#delegated);
    });
  }

  /**
   * Whether a rejection is this request's own delegation signal.
   * @param error - the rejection received from {@link PendingApproval.result}.
   */
  isDelegation(error) {
    return error === this.#delegated;
  }

  /**
   * End an unanswered request when its transport or plugin lifetime ends.
   * @param reason - rejection exposed to the waiting listener.
   */
  abort(reason) {
    if (this.#settled) return;
    this.#finish(() => {
      this.#reject(reason);
    });
  }

  /** Whether this request still waits for a decision. */
  get settled() {
    return this.#settled;
  }

  #finish(settle) {
    this.#settled = true;
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort);
    }
    settle();
  }
}

module.exports = { ALLOW_ONCE, APPROVAL_PRECEDENCE, PendingApproval, REJECTED };
