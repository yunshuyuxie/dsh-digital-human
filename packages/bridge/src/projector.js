/**
 * Projector: turns host session state into protocol frames.
 *
 * Three independent feeds:
 *   * the cold session list (`sessionController.list`), refreshed on demand and
 *     on session lifecycle events;
 *   * the host-wide live control stream (`sessionController.control`) carrying
 *     queues, background jobs and projections — forwarded verbatim;
 *   * per-session activity, projected from `sessionController.follow` to the
 *     handful of event kinds a desktop avatar reacts to.
 *
 * It also indexes `tool/call` events by `callId`, because the host approval
 * request carries only that id and the permission card wants the arguments.
 */
import {
  EVENT_NAMES,
  activity as activityFrame,
  bridgeNotice,
  controlFrame as controlFrameMessage,
  sessionsChanged,
  truncateText,
} from './vendor/protocol/index.js';

/** Event kinds the avatar consumes. Anything else is dropped. */
const FORWARDED_EVENT_KINDS = new Set([
  'turn/start',
  'turn/end',
  'tool/call',
  'tool/result',
  'assistant/message',
]);

/**
 * Create the projector.
 *
 * @param options - projector wiring.
 * @param options.ctx - scoped host context carrying `sessionController`.
 * @param options.config - parsed bridge config.
 * @param options.emit - `(message) => void` broadcast sink (host-wide frames).
 * @param options.emitActivity - `(sessionId, message) => void` sink for activity
 *   frames, so a caller can deliver them only to the clients that subscribed;
 *   defaults to `emit`.
 * @param options.getApprovals - returns the pending approval mirrors for a baseline.
 * @param options.log - `(level, message)` sink.
 * @returns the projector handle.
 */
export function createProjector(options) {
  const { ctx, config, emit, getApprovals, log } = options;
  const emitActivity = typeof options.emitActivity === 'function' ? options.emitActivity : (_sessionId, message) => emit(message);
  const controller = () => ctx.get('sessionController');
  const follows = new Map();
  const toolCalls = new Map();
  const errors = new Map();
  /** Per-session projection values, keyed by projection key. */
  const projections = new Map();
  let controlBaseline;
  let controlAbort;

  /** Merge one session's projection values (a later frame carries only one key). */
  function rememberProjections(sessionId, values) {
    if (typeof sessionId !== 'string' || values === undefined || values === null) return;
    projections.set(sessionId, { ...(projections.get(sessionId) ?? {}), ...values });
  }

  /** The `provider/model` a session will use next, when the host published it. */
  function modelOf(sessionId) {
    const selection = projections.get(sessionId)?.modelSelection;
    const chosen = selection?.next ?? selection?.lastUsed;
    if (chosen === null || chosen === undefined) return undefined;
    if (typeof chosen.provider !== 'string' || typeof chosen.model !== 'string') return undefined;
    return `${chosen.provider}/${chosen.model}`;
  }

  /** Title fallback chain: durable title, projection hint, directory name, id. */
  function deriveTitle(row) {
    const projections = row?.projections;
    const candidates = [
      row?.title,
      projections?.title,
      projections?.sessionTitle,
      projections?.values?.title,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
    if (typeof row?.cwd === 'string' && row.cwd !== '') {
      const parts = row.cwd.split(/[\\/]/u).filter((part) => part !== '');
      if (parts.length > 0) return parts[parts.length - 1];
    }
    return typeof row?.sessionId === 'string' ? row.sessionId.slice(0, 8) : 'session';
  }

  /** Project one host session summary into the wire mirror. */
  function toMirror(row) {
    return {
      id: String(row.sessionId),
      displayTitle: deriveTitle(row),
      running: row.running === true,
      blank: row.blank === true,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
      ...(typeof row.cwd === 'string' && row.cwd !== '' ? { cwd: row.cwd } : {}),
      // Subagent children are listed by the host like any other session; the
      // parent id is what lets a client fold them instead of showing them as
      // sessions the user started.
      ...(typeof row.parentSessionId === 'string' && row.parentSessionId !== '' ? { parentId: row.parentSessionId } : {}),
      ...(typeof row.origin === 'string' && row.origin !== '' ? { origin: row.origin } : {}),
      ...(modelOf(String(row.sessionId)) === undefined ? {} : { model: modelOf(String(row.sessionId)) }),
      ...(errors.has(String(row.sessionId)) ? { lastAgentError: errors.get(String(row.sessionId)) } : {}),
    };
  }

  /** Read every visible session row without activating an agent. */
  async function listSessions() {
    const sessions = controller();
    if (sessions === undefined) return [];
    const signal = AbortSignal.timeout(10_000);
    const value = await sessions.list({}, signal);
    const items = Array.isArray(value?.items) ? value.items : [];
    return items.map(toMirror);
  }

  /** Parse the raw tool-call argument string, tolerating malformed model output. */
  function parseArguments(raw) {
    if (typeof raw !== 'string') return raw === undefined ? undefined : raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /** Keep the per-session tool-call index bounded. */
  function rememberToolCall(sessionId, callId, entry) {
    let index = toolCalls.get(sessionId);
    if (index === undefined) {
      index = new Map();
      toolCalls.set(sessionId, index);
    }
    index.set(callId, entry);
    while (index.size > config.activityBufferPerSession) {
      const oldest = index.keys().next();
      if (oldest.done === true) break;
      index.delete(oldest.value);
    }
  }

  /** Look up the tool call a pending approval refers to. */
  function findToolCall(sessionId, callId) {
    return toolCalls.get(sessionId)?.get(callId);
  }

  /** Extract a short text summary from an assistant message payload. */
  function assistantText(message) {
    const content = message?.content;
    if (!Array.isArray(content)) return undefined;
    const parts = [];
    for (const block of content) {
      if (typeof block?.text === 'string') parts.push(block.text);
    }
    if (parts.length === 0) return undefined;
    return truncateText(parts.join(' '), config.activityMaxTextBytes);
  }

  /** Extract a short summary from a tool result payload. */
  function resultText(data) {
    const content = data?.message?.content;
    if (!Array.isArray(content) || content.length === 0) return undefined;
    const first = content[0];
    const blocks = Array.isArray(first?.content) ? first.content : [];
    const parts = [];
    for (const block of blocks) {
      const text = block?.text ?? block?.content;
      if (typeof text === 'string') parts.push(text);
    }
    if (parts.length === 0) return undefined;
    return truncateText(parts.join(' '), config.activityMaxTextBytes);
  }

  /** Project one durable session event, or `undefined` when it is not forwarded. */
  function projectEvent(sessionId, event) {
    const type = typeof event?.type === 'string' ? event.type : undefined;
    if (type === undefined || !FORWARDED_EVENT_KINDS.has(type)) return undefined;
    const data = event.data ?? {};
    const base = { sessionId, seq: typeof event.seq === 'number' ? event.seq : 0, kind: type };
    switch (type) {
      case 'turn/start':
        return { ...base, status: 'running' };
      case 'turn/end':
        return { ...base, status: typeof data.reason === 'string' ? data.reason : 'ended' };
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : undefined;
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const args = parseArguments(data.arguments);
        if (callId !== undefined) rememberToolCall(sessionId, callId, { name, args });
        return { ...base, tool: name, status: 'in_progress' };
      }
      case 'tool/result': {
        const callId = typeof data.message?.content?.[0]?.toolCallId === 'string'
          ? data.message.content[0].toolCallId
          : undefined;
        const failed = data.error !== undefined || data.message?.content?.[0]?.isError === true;
        const text = resultText(data);
        return {
          ...base,
          ...(callId === undefined ? {} : { tool: findToolCall(sessionId, callId)?.name ?? 'tool' }),
          status: failed ? 'failed' : 'completed',
          ...(text === undefined ? {} : { text }),
        };
      }
      case 'assistant/message': {
        const text = assistantText(data.message);
        return { ...base, status: 'completed', ...(text === undefined ? {} : { text }) };
      }
      /* v8 ignore next 2 -- the set above is exhaustive */
      default:
        return undefined;
    }
  }

  /** Forward one follow frame from a subscribed session. */
  function handleFollowFrame(sessionId, frame) {
    if (frame?.type === 'event') {
      const entry = projectEvent(sessionId, frame.event);
      if (entry !== undefined) emitActivity(sessionId, activityFrame(entry));
      return;
    }
    if (frame?.type === 'snapshot') {
      // The opening window is history; only its newest projected events matter
      // for a live avatar, and the control stream already carries job state.
      const records = Array.isArray(frame.records) ? frame.records.slice(-config.activityBufferPerSession) : [];
      for (const record of records) {
        if (record?.type !== 'event') continue;
        const entry = projectEvent(sessionId, record.event);
        if (entry !== undefined) emitActivity(sessionId, activityFrame(entry));
      }
    }
  }

  /** Start (or restart) the follow pump for one session. */
  function subscribeSession(sessionId) {
    if (follows.has(sessionId)) return;
    const sessions = controller();
    if (sessions === undefined) return;
    const abort = new AbortController();
    const record = { abort };
    follows.set(sessionId, record);
    const pump = async () => {
      try {
        const stream = sessions.follow({ address: { kind: 'session', sessionId } }, abort.signal);
        for await (const frame of stream) handleFollowFrame(sessionId, frame);
      } catch (error) {
        if (abort.signal.aborted) return;
        log('warn', `activity stream for ${sessionId} ended: ${error.message}`);
        emit(bridgeNotice('warn', 'activity-stream-ended', `session ${sessionId} activity stream ended: ${error.message}`));
      } finally {
        follows.delete(sessionId);
      }
    };
    void pump();
  }

  /** Stop the follow pump for one session. */
  function unsubscribeSession(sessionId) {
    const record = follows.get(sessionId);
    projections.delete(sessionId);
    if (record === undefined) return;
    follows.delete(sessionId);
    record.abort.abort();
    toolCalls.delete(sessionId);
  }

  /** Pump the host-wide control stream into `control.frame` messages. */
  function startControl() {
    const sessions = controller();
    if (sessions === undefined || controlAbort !== undefined) return;
    controlAbort = new AbortController();
    const signal = controlAbort.signal;
    const pump = async () => {
      try {
        for await (const frame of sessions.control(signal)) {
          if (frame?.type === 'baseline') {
            controlBaseline = frame.value;
            for (const [sessionId, baseline] of Object.entries(frame.value?.projections ?? {})) {
              rememberProjections(sessionId, baseline?.values);
            }
          }
          if (frame?.type === 'projection') rememberProjections(frame.sessionId, { [frame.key]: frame.value });
          emit(controlFrameMessage(frame));
        }
      } catch (error) {
        if (signal.aborted) return;
        log('warn', `control stream ended: ${error.message}`);
        emit(bridgeNotice('warn', 'control-stream-ended', `control stream ended: ${error.message}`));
      }
    };
    void pump();
  }

  /** Build the baseline a freshly authenticated client receives. */
  async function baseline() {
    return {
      sessions: await listSessions(),
      control: controlBaseline ?? { queues: {}, jobs: {}, projections: {} },
      approvals: typeof getApprovals === 'function' ? getApprovals() : [],
    };
  }

  /** Record an agent failure and tell clients about it. */
  function noteAgentError(agent, error) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string') return;
    const message = error?.message ?? (typeof error === 'string' ? error : 'agent error');
    errors.set(sessionId, message);
    emit(sessionsChanged({ upsert: [{ id: sessionId, displayTitle: sessionId.slice(0, 8), running: false, blank: false, updatedAt: Date.now(), lastAgentError: message }] }));
    emitActivity(sessionId, activityFrame({ sessionId, seq: 0, kind: 'agent/error', status: 'failed', text: truncateText(message, config.activityMaxTextBytes) }));
  }

  /** Clear a recorded agent failure. */
  function clearAgentError(sessionId) {
    if (!errors.delete(sessionId)) return;
    emit(sessionsChanged({ upsert: [{ id: sessionId, displayTitle: sessionId.slice(0, 8), running: false, blank: false, updatedAt: Date.now() }] }));
  }

  /** Stop every pump this projector owns. */
  function stopAll() {
    for (const sessionId of [...follows.keys()]) unsubscribeSession(sessionId);
    controlAbort?.abort();
    controlAbort = undefined;
  }

  return {
    listSessions,
    baseline,
    subscribeSession,
    unsubscribeSession,
    startControl,
    stopAll,
    findToolCall,
    noteAgentError,
    clearAgentError,
    get errors() {
      return errors;
    },
  };
}

/** Re-exported so the entry point can name the event it subscribes to. */
export const AGENT_ERROR_EVENT = 'agent/error';
/** Re-exported so the entry point can name the session event it follows. */
export const SESSION_EVENT = 'session/event';
/** Event name carried by an activity frame, for callers building filters. */
export const ACTIVITY_EVENT_NAME = EVENT_NAMES.ACTIVITY;
