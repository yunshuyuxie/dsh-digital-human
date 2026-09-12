/**
 * NDJSON framing for the digital-human local IPC protocol (design.md §5.1).
 *
 * One JSON object per line, terminated by `\n`. Frames are bounded by a byte ceiling; decoding
 * never throws — malformed input is reported through `onError` and the decoder resynchronizes on
 * the next line break.
 *
 * @module dsh-digital-human-protocol/codec
 */

import { Buffer } from 'node:buffer'

import { ProtocolError, isJsonValue } from './guards.js'
import { MAX_FRAME_BYTES_DEFAULT } from './messages.js'

/** Buffer marker meaning "the current oversized line was already reported". @type {string} */
const OVERSIZE = '\u0000oversize'

/**
 * Count the UTF-8 byte length of a string.
 *
 * @param {string} text - Text to measure.
 * @returns {number} Byte length.
 */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Normalize a chunk to text.
 *
 * @param {string | Buffer | Uint8Array} chunk - Chunk handed to the decoder.
 * @returns {string} Chunk as text.
 */
function toText(chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

/**
 * Invoke a caller-supplied callback without letting its throw escape the decoder.
 *
 * @param {((argument: any) => void) | undefined} callback - Callback to invoke.
 * @param {any} argument - Argument to pass.
 * @returns {void}
 */
function safeCall(callback, argument) {
  if (typeof callback !== 'function') return
  try {
    callback(argument)
  } catch {
    // A throwing sink must not corrupt the framing state machine.
  }
}

/**
 * Serialize one frame as an NDJSON line.
 *
 * @param {unknown} value - JSON value to encode.
 * @param {number} [maxBytes] - Single-frame byte ceiling, excluding the terminator.
 * @returns {string} The serialized line, terminated by exactly one `\n`.
 * @throws {ProtocolError} When `value` is not a JSON value, or the line exceeds `maxBytes`.
 */
export function encodeFrame(value, maxBytes = MAX_FRAME_BYTES_DEFAULT) {
  if (!isJsonValue(value)) {
    throw new ProtocolError('encodeFrame: value is not JSON-serializable', {
      code: 'protocol-invalid-frame',
    })
  }
  const line = JSON.stringify(value)
  const size = byteLength(line)
  if (size > maxBytes) {
    throw new ProtocolError(`encodeFrame: frame of ${size} bytes exceeds maxBytes ${maxBytes}`, {
      code: 'protocol-frame-too-large',
      details: { size, maxBytes },
    })
  }
  return `${line}\n`
}

/**
 * Truncate text to at most `maxBytes` UTF-8 bytes without splitting a code point.
 *
 * Nothing is appended: the caller decides how to flag the truncation (`truncated: true`).
 *
 * @param {string} text - Text to truncate.
 * @param {number} maxBytes - Maximum number of UTF-8 bytes to keep.
 * @returns {string} Prefix of `text` whose UTF-8 encoding is at most `maxBytes` bytes.
 */
export function truncateText(text, maxBytes) {
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ''
  const budget = Math.floor(maxBytes)
  if (byteLength(text) <= budget) return text
  // Walk code points, keeping each only while it still fits, so the cut always lands between
  // characters even when the budget ends mid-sequence.
  let used = 0
  let index = 0
  for (const character of text) {
    const size = byteLength(character)
    if (used + size > budget) break
    used += size
    index += character.length
  }
  return text.slice(0, index)
}

/**
 * Create an NDJSON frame decoder.
 *
 * The returned function accepts string or `Buffer` chunks, buffers partial lines, and calls
 * `onFrame(parsedObject)` once per complete line. On an invalid JSON line or a line longer than
 * `maxBytes` it calls `onError(error)`, resets the buffer and resumes at the next line break, so a
 * single bad producer line never poisons the stream. `\r\n` is accepted as a terminator.
 *
 * @param {object} [options] - Decoder options.
 * @param {number} [options.maxBytes] - Single-frame byte ceiling.
 * @param {(frame: object) => void} [options.onFrame] - Called with each parsed frame.
 * @param {(error: ProtocolError) => void} [options.onError] - Called on invalid JSON or oversize lines.
 * @returns {((chunk: string | Buffer) => void) & { flush: () => string }} Decoder, with `flush()`.
 */
export function createFrameDecoder({ maxBytes = MAX_FRAME_BYTES_DEFAULT, onFrame, onError } = {}) {
  /** @type {string} */
  let pending = ''

  /**
   * Report a framing failure to the sink.
   *
   * @param {string} code - Machine-readable error code.
   * @param {string} message - Failure description.
   * @param {object} [details] - JSON-serializable details.
   * @param {Error} [cause] - Underlying error.
   * @returns {void}
   */
  function fail(code, message, details, cause) {
    safeCall(onError, new ProtocolError(message, { code, details, cause }))
  }

  /**
   * Decode one complete line and hand the parsed frame to the sink.
   *
   * @param {string} line - Line without its terminator.
   * @returns {void}
   */
  function emitLine(line) {
    if (line === '') return // Blank line, e.g. the terminator of a line already swallowed as oversize.
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (cause) {
      fail('protocol-invalid-frame', 'decoder: invalid JSON frame', { line: truncateText(line, 256) }, cause)
      return
    }
    safeCall(onFrame, parsed)
  }

  /**
   * Feed one chunk into the decoder.
   *
   * @param {string | Buffer} chunk - Incoming bytes or text.
   * @returns {void}
   */
  function decoder(chunk) {
    const text = toText(chunk)
    if (pending === OVERSIZE) {
      // Still discarding an overlong line: drop everything up to and including its terminator.
      const end = text.indexOf('\n')
      if (end === -1) return
      pending = ''
      decodeBuffer(text.slice(end + 1))
      return
    }
    decodeBuffer(text)
  }

  /**
   * Frame every complete line of `text` and buffer the trailing partial line.
   *
   * @param {string} text - Text to consume.
   * @returns {void}
   */
  function decodeBuffer(text) {
    let buffer = pending + text
    let start = 0
    let index = buffer.indexOf('\n', start)
    while (index !== -1) {
      let line = buffer.slice(start, index)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const size = byteLength(line)
      if (size > maxBytes) {
        fail('protocol-frame-too-large', `decoder: frame of ${size} bytes exceeds maxBytes ${maxBytes}`, { size, maxBytes })
      } else {
        emitLine(line)
      }
      start = index + 1
      index = buffer.indexOf('\n', start)
    }
    pending = buffer.slice(start)
    if (byteLength(pending) > maxBytes) {
      // No terminator yet and already over the ceiling: report once, then swallow to the next `\n`.
      fail('protocol-frame-too-large', `decoder: frame exceeds maxBytes ${maxBytes} before its terminator`, { maxBytes })
      pending = OVERSIZE
    }
  }

  /**
   * Return and clear the trailing partial line, if any.
   *
   * @returns {string} Remaining buffered text, or `''`.
   */
  decoder.flush = () => {
    if (pending === OVERSIZE) {
      pending = ''
      return ''
    }
    const trailing = pending
    pending = ''
    return trailing
  }

  return decoder
}
