/**
 * Command layer: the small set of host operations a desktop client may invoke.
 *
 * Every method is a thin wrapper over `ctx.sessionController` so the semantics
 * stay identical to the Web GUI's; only validation and error codes live here.
 * Text prompts are the only admitted content shape in v1.
 */
import { randomUUID } from 'node:crypto';

/** How long a command may wait for the host to admit it. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Build an Error carrying a protocol error code. */
function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Require a non-empty string field. */
function requireString(params, name) {
  const value = params?.[name];
  if (typeof value !== 'string' || value === '') {
    throw commandError('invalid-params', `${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Create the command layer.
 *
 * @param options - command wiring.
 * @param options.ctx - scoped host context carrying `sessionController`.
 * @returns the command handle.
 */
export function createCommands(options) {
  const { ctx } = options;

  /** Resolve the controller or fail loudly. */
  function controller() {
    const sessions = ctx.get('sessionController');
    if (sessions === undefined) throw commandError('bridge-unavailable', 'sessionController is not mounted');
    return sessions;
  }

  /** Admit one text prompt into a live agent. */
  async function prompt(params) {
    const sessionId = requireString(params, 'sessionId');
    const content = Array.isArray(params?.content) ? params.content : undefined;
    if (content === undefined || content.length === 0) {
      throw commandError('invalid-params', 'content must be a non-empty array');
    }
    const parts = [];
    for (const part of content) {
      if (part?.type !== 'text' || typeof part.text !== 'string') {
        throw commandError('unsupported-content', 'only { type: "text", text } parts are supported');
      }
      parts.push({ type: 'text', text: part.text });
    }
    if (!parts.some((part) => part.text.trim() !== '')) {
      throw commandError('invalid-params', 'content must contain non-whitespace text');
    }
    const requestId = typeof params?.requestId === 'string' && params.requestId !== ''
      ? params.requestId
      : randomUUID();
    const value = await controller().prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: parts,
    }, AbortSignal.timeout(COMMAND_TIMEOUT_MS));
    return { accepted: value?.accepted === true };
  }

  /** Create one session in a workspace directory. */
  async function create(params) {
    const cwd = requireString(params, 'cwd');
    const value = await controller().create({ cwd });
    return { sessionId: String(value?.sessionId ?? '') };
  }

  /** Cancel the active turn of one session. */
  async function cancel(params) {
    const sessionId = requireString(params, 'sessionId');
    const value = await controller().cancel({ sessionId });
    return { cancelled: value?.accepted === true };
  }

  /** Select the model one session should use from its next turn on. */
  async function selectModel(params) {
    const sessionId = requireString(params, 'sessionId');
    const provider = requireString(params, 'provider');
    const model = requireString(params, 'model');
    const value = await controller().selectModel({ sessionId, provider, model });
    const selected = value?.selected ?? { provider, model };
    return { provider: String(selected.provider ?? provider), model: String(selected.model ?? model) };
  }

  /**
   * Read the deployment's model catalog.
   *
   * Returned as the host produces it: provider groups, the default selection, and
   * per-provider failures (a provider whose catalog could not be read is shown to
   * the user rather than hidden).
   */
  async function models() {
    const catalog = await controller().modelCatalog();
    return {
      default: catalog?.default ?? null,
      groups: Array.isArray(catalog?.groups) ? catalog.groups : [],
      failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
    };
  }

  /** Rename one session. */
  async function rename(params) {
    const sessionId = requireString(params, 'sessionId');
    const title = requireString(params, 'title');
    const value = await controller().rename({ sessionId, title });
    return { title: String(value?.title ?? title), seq: typeof value?.seq === 'number' ? value.seq : 0 };
  }

  return { prompt, create, cancel, selectModel, models, rename };
}
