/**
 * View-model projection for the avatar.
 *
 * Reuses the retired Web plugin's state machine (its face priority order) with a
 * different input: the bridge's protocol frames instead of the browser's session
 * mirror. Everything here is pure data — the renderer only draws what it is
 * handed.
 */

/** How long a completion keeps the celebratory face. */
export const DONE_HOLD_MS = 6000;

/** Activity entries kept per session. */
const ACTIVITY_LIMIT = 40;

/** Job statuses whose work is still in flight. */
const LIVE_JOB_STATUSES = new Set(['running', 'stopping']);

/**
 * Create the state store.
 * @param options - `{ onChange, extras }`; `extras()` supplies runtime facts the
 *   renderer must display truthfully (window pinning, auto-start) rather than
 *   guessing from its own last action.
 * @returns the store handle.
 */
export function createStateStore(options = {}) {
  const onChange = options.onChange;
  const extras = typeof options.extras === 'function' ? options.extras : () => ({});
  const sessions = new Map();
  const jobs = new Map();
  const activity = new Map();
  const activeTools = new Map();
  const approvals = new Map();
  let status = { phase: 'searching', detail: undefined, endpoint: null, peer: null };
  let control = { queues: {}, jobs: {}, projections: {} };
  let lastDoneAt = 0;
  let notice;
  /** Model catalog reported by a bridge that supports it, else `null`. */
  let models = null;
  /** Whether the connected bridge answered `sessions.models`. */
  let modelsSupported = false;

  /** Notify the renderer. */
  function changed() {
    onChange?.();
  }

  /** Whether any session reported an agent failure. */
  function hasError() {
    for (const session of sessions.values()) if (session.lastAgentError) return true;
    for (const list of jobs.values()) {
      for (const job of list) if (job.status === 'failed') return true;
    }
    return false;
  }

  /** Count jobs still running across every session. */
  function liveJobCount() {
    let count = 0;
    for (const list of jobs.values()) {
      for (const job of list) if (LIVE_JOB_STATUSES.has(job.status)) count += 1;
    }
    return count;
  }

  /** Count tool calls currently in flight. */
  function activeToolCount() {
    let count = 0;
    for (const tools of activeTools.values()) count += toolNames(tools).length;
    return count;
  }

  /** Names of the in-flight tool calls of one session. */
  function toolNames(tools) {
    return [...tools.entries()].filter(([, state]) => state === 'in_progress').map(([name]) => name);
  }

  /** Running sessions. */
  function runningSessions() {
    return [...sessions.values()].filter((session) => session.running === true);
  }

  /** Apply the seven-face priority to the current data. */
  function face(now) {
    if (status.phase !== 'connected') return 'offline';
    if (approvals.size > 0) return 'waiting';
    if (hasError()) return 'error';
    if (liveJobCount() > 0 || activeToolCount() > 0) return 'working';
    if (runningSessions().length > 0) return 'thinking';
    if (lastDoneAt > 0 && now - lastDoneAt < DONE_HOLD_MS) return 'done';
    return 'idle';
  }

  /** Store one session list row. */
  function upsertSession(row) {
    if (typeof row?.id !== 'string') return;
    const previous = sessions.get(row.id) ?? { id: row.id, displayTitle: row.id.slice(0, 8) };
    sessions.set(row.id, {
      ...previous,
      ...row,
      // An explicit null clears a previously reported error.
      lastAgentError: row.lastAgentError === undefined ? previous.lastAgentError : row.lastAgentError,
    });
  }

  /** Apply one protocol event. */
  function applyEvent(frame) {
    const data = frame?.data ?? {};
    switch (frame?.event) {
      case 'baseline': {
        sessions.clear();
        jobs.clear();
        activity.clear();
        activeTools.clear();
        approvals.clear();
        for (const row of data.sessions ?? []) upsertSession(row);
        control = data.control ?? { queues: {}, jobs: {}, projections: {} };
        for (const [sessionId, list] of Object.entries(control.jobs ?? {})) jobs.set(sessionId, [...list]);
        for (const card of data.approvals ?? []) approvals.set(card.approvalId, card);
        break;
      }
      case 'sessions.changed': {
        for (const row of data.upsert ?? []) upsertSession(row);
        for (const id of data.removed ?? []) {
          sessions.delete(id);
          jobs.delete(id);
          activity.delete(id);
          activeTools.delete(id);
        }
        break;
      }
      case 'control.frame': {
        if (data.type === 'baseline') {
          control = data.value ?? control;
          for (const [sessionId, list] of Object.entries(control.jobs ?? {})) jobs.set(sessionId, [...list]);
        } else if (data.type === 'jobs' && typeof data.sessionId === 'string') {
          jobs.set(data.sessionId, [...(data.jobs ?? [])]);
          const live = (data.jobs ?? []).some((job) => LIVE_JOB_STATUSES.has(job.status));
          if (!live) lastDoneAt = Date.now();
        } else if (data.type === 'queue' || data.type === 'projection') {
          /* queue and projection state are not shown in v1 */
        }
        break;
      }
      case 'activity': {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
        if (sessionId === null) break;
        const ring = activity.get(sessionId) ?? [];
        ring.push({ ...data, time: Date.now() });
        while (ring.length > ACTIVITY_LIMIT) ring.shift();
        activity.set(sessionId, ring);
        if (data.kind === 'tool/call' && typeof data.tool === 'string') {
          const tools = activeTools.get(sessionId) ?? new Map();
          tools.set(data.tool, 'in_progress');
          activeTools.set(sessionId, tools);
        }
        if (data.kind === 'tool/result') {
          const tools = activeTools.get(sessionId) ?? new Map();
          if (typeof data.tool === 'string') tools.delete(data.tool);
          else tools.clear();
          activeTools.set(sessionId, tools);
          lastDoneAt = Date.now();
        }
        if (data.kind === 'turn/end') {
          activeTools.set(sessionId, new Map());
          const reason = String(data.status ?? '');
          if (reason === 'error' || reason === 'failed') lastDoneAt = 0;
          else lastDoneAt = Date.now();
        }
        if (data.kind === 'agent/error') lastDoneAt = 0;
        break;
      }
      case 'approval.request': {
        if (typeof data.approvalId === 'string') approvals.set(data.approvalId, data);
        break;
      }
      case 'approval.settled': {
        approvals.delete(data.approvalId);
        break;
      }
      case 'bridge.notice': {
        notice = { level: data.level ?? 'info', code: data.code ?? '', message: data.message ?? '', time: Date.now() };
        break;
      }
      default:
        break;
    }
    changed();
  }

  /** Apply one connection-status transition. */
  function applyStatus(next) {
    status = next;
    if (next.phase !== 'connected') {
      // A dropped connection invalidates every live value.
      jobs.clear();
      activeTools.clear();
      approvals.clear();
      // The catalog belongs to the bridge that reported it.
      models = null;
      modelsSupported = false;
      if (next.phase !== 'connecting') {
        sessions.clear();
        control = { queues: {}, jobs: {}, projections: {} };
      }
      lastDoneAt = 0;
    }
    changed();
  }

  /**
   * Record the model catalog, or the fact that this bridge does not serve one.
   * @param catalog - the catalog, or `null` when the method is unsupported.
   */
  function setModels(catalog) {
    models = catalog ?? null;
    modelsSupported = catalog !== null && catalog !== undefined;
    changed();
  }

  /** Build the renderer snapshot. */
  function snapshot(now = Date.now()) {
    const currentFace = face(now);
    const sessionRows = [...sessions.values()]
      .map((session) => ({
        id: session.id,
        displayTitle: session.displayTitle,
        running: session.running === true,
        cwd: session.cwd ?? null,
        lastAgentError: session.lastAgentError ?? null,
        // A child session names its parent so the list can fold subagent work.
        parentId: session.parentId ?? null,
        origin: session.origin ?? null,
        model: session.model ?? null,
        liveJobs: (jobs.get(session.id) ?? []).filter((job) => LIVE_JOB_STATUSES.has(job.status)).length,
        activeTools: toolNames(activeTools.get(session.id) ?? new Map()),
      }))
      .sort((left, right) => Number(right.running) - Number(left.running) || left.displayTitle.localeCompare(right.displayTitle));

    return {
      status: {
        phase: status.phase,
        detail: status.detail ?? null,
        host: status.peer?.host ?? null,
        profile: status.peer?.profile ?? null,
        dshVersion: status.peer?.dshVersion ?? null,
        bridgeVersion: status.peer?.bridgeVersion ?? null,
        capabilities: status.peer?.capabilities ?? [],
        pipePath: status.endpoint?.path ?? null,
      },
      runtime: { ...extras() },
      face: currentFace,
      notice: notice ?? null,
      models,
      modelsSupported,
      counts: {
        approvals: approvals.size,
        liveJobs: liveJobCount(),
        activeTools: activeToolCount(),
        sessions: sessionRows.filter((row) => row.parentId === null).length,
        children: sessionRows.filter((row) => row.parentId !== null).length,
        running: runningSessions().length,
      },
      sessions: sessionRows,
      approvals: [...approvals.values()].map((card) => ({
        ...card,
        remainingMs: typeof card.deadlineAt === 'number' ? Math.max(0, card.deadlineAt - now) : null,
      })),
      activity: Object.fromEntries([...activity.entries()].map(([id, ring]) => [id, ring.slice(-12).reverse()])),
    };
  }

  return { applyEvent, applyStatus, snapshot, setModels };
}
