/**
 * Append-only JSONL audit log for approval traffic (design.md §5.2.1, §5.2.4 rule 5).
 *
 * Writes are serialized through an internal promise chain so concurrent appends never interleave,
 * and `append` never throws or rejects into the caller: a full disk or a locked file must not take
 * the dsh host down. Failures are reported through `onError`, deduplicated by message so a broken
 * path cannot flood the log.
 *
 * @module dsh-digital-human-bridge/audit
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Default failure sink: one `console.warn` per distinct message.
 *
 * @type {(info: { file: string, error: unknown }) => void}
 */
function defaultOnError({ file, error }) {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`digital-human-bridge: audit log "${file}" write failed: ${message}`)
}

/**
 * Describe an error for deduplication and reporting.
 *
 * @param {unknown} error - Thrown value.
 * @returns {string} Stable message text.
 */
function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/**
 * Create an audit log bound to one file.
 *
 * @param {object} input - Log options.
 * @param {string} input.file - Append-only JSONL path. Its directory is created when needed.
 * @param {(info: { file: string, error: unknown }) => void} [input.onError] - Failure sink; defaults
 *   to a deduplicated `console.warn`.
 * @returns {{ append: (record: object) => Promise<boolean>, flush: () => Promise<void>, close: () => Promise<void>, file: string }} Audit log.
 * @throws {TypeError} When `file` is not a non-empty string.
 */
export function createAuditLog({ file, onError } = /** @type {any} */ ({})) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('createAuditLog: file must be a non-empty string')
  }
  const report = typeof onError === 'function' ? onError : defaultOnError
  /** @type {Set<string>} */
  const warned = new Set()
  /** @type {Promise<void>} */
  let queue = Promise.resolve()
  let prepared = false
  let closed = false

  /**
   * Report a failure without letting the sink's own throw escape.
   *
   * @param {unknown} error - Thrown value.
   * @returns {void}
   */
  function warn(error) {
    const message = messageOf(error)
    if (warned.has(message)) return
    warned.add(message)
    try {
      report({ file, error })
    } catch {
      // A throwing sink must not break the append chain.
    }
  }

  /**
   * Create the containing directory once, tolerating an already-existing one.
   *
   * @returns {Promise<void>} Resolves when the directory exists.
   */
  async function prepare() {
    if (prepared) return
    await mkdir(dirname(file), { recursive: true })
    prepared = true
  }

  /**
   * Append one record, stamping `ts` when the caller did not supply one.
   *
   * @param {object} record - Audit record, e.g. `{ profile, sessionId, toolName, decision }`.
   * @returns {Promise<boolean>} `true` when the line was written, `false` when it was dropped.
   */
  function append(record) {
    if (closed) return Promise.resolve(false)
    const write = async () => {
      try {
        await prepare()
        const entry = { ts: new Date().toISOString(), ...(record ?? {}) }
        await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' })
        return true
      } catch (error) {
        warn(error)
        return false
      }
    }
    const result = queue.then(write, write)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Wait until every append queued so far has been written.
   *
   * @returns {Promise<void>} Resolves when the queue drains.
   */
  function flush() {
    return queue.then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Flush, then make further `append` calls no-ops.
   *
   * @returns {Promise<void>} Resolves once drained.
   */
  async function close() {
    closed = true
    await flush()
  }

  return { append, flush, close, file }
}
