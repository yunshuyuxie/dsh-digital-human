import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVITY_KINDS,
  APPROVAL_DECISIONS,
  APPROVAL_OUTCOMES,
  CAPABILITIES,
  EVENT_NAMES,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES_DEFAULT,
  METHODS,
  ProtocolError,
  activity,
  approvalRequest,
  approvalSettled,
  assertOk,
  baseline,
  bridgeNotice,
  controlFrame,
  createFrameDecoder,
  encodeFrame,
  error,
  event,
  hello,
  isJsonValue,
  ready,
  result,
  rpc,
  sessionsChanged,
  truncateText,
  validateActivity,
  validateDecision,
  validateError,
  validateEvent,
  validateFrame,
  validateHello,
  validateReady,
  validateResult,
  validateRpc,
  validateSessionSummary,
  validateWelcome,
  welcome,
} from '../src/index.js'

/** @returns {object} A valid `hello` payload. */
const helloInput = () => ({
  protocol: 1,
  clientId: 'app-1',
  clientName: 'DESKTOP-01',
  token: 'TOKEN',
  clientNonce: 'bm9uY2U=',
})

/** @returns {object} A valid `welcome` payload. */
const welcomeInput = () => ({
  protocol: 1,
  host: 'DESKTOP-01',
  profile: 'web',
  pid: 12345,
  bridgeVersion: '0.1.0',
  dshVersion: '0.1.5-rc.1',
  capabilities: [...CAPABILITIES],
  serverNonce: 'bm9uY2U=',
  proof: 'cHJvb2Y=',
})

/** @returns {object} A valid session summary payload. */
const summary = () => ({ id: 's1', displayTitle: 't', running: true, blank: false, updatedAt: 1 })

/** @returns {object} A valid activity payload. */
const entry = () => ({ sessionId: 's1', seq: 1, kind: 'tool/call', tool: 'bash' })

test('constants match the protocol contract', () => {
  assert.equal(MAX_FRAME_BYTES_DEFAULT, 262144)
  assert.equal(HANDSHAKE_TIMEOUT_MS, 5000)
  assert.deepEqual(METHODS, {
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
  assert.deepEqual(EVENT_NAMES, {
    BASELINE: 'baseline',
    SESSIONS_CHANGED: 'sessions.changed',
    CONTROL_FRAME: 'control.frame',
    ACTIVITY: 'activity',
    APPROVAL_REQUEST: 'approval.request',
    APPROVAL_SETTLED: 'approval.settled',
    BRIDGE_NOTICE: 'bridge.notice',
  })
  assert.deepEqual(ACTIVITY_KINDS, [
    'turn/start', 'turn/end', 'tool/call', 'tool/result', 'assistant/message', 'agent/error',
  ])
  assert.deepEqual(APPROVAL_DECISIONS, ['allow-once', 'reject'])
  assert.deepEqual(APPROVAL_OUTCOMES, ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
  assert.deepEqual(CAPABILITIES, [
    'control', 'activity', 'approvals', 'prompt', 'cancel', 'create', 'selectModel',
  ])
  assert.ok(Object.isFrozen(METHODS) && Object.isFrozen(EVENT_NAMES))
  assert.ok(Object.isFrozen(ACTIVITY_KINDS) && Object.isFrozen(CAPABILITIES))
})

test('validateHello accepts a valid frame and rejects bad shapes', () => {
  assert.equal(validateHello(hello(helloInput())), undefined)
  for (const key of ['clientId', 'clientName', 'token', 'clientNonce']) {
    const frame = hello(helloInput())
    delete frame[key]
    assert.match(validateHello(frame), new RegExp(key))
  }
  assert.match(validateHello(hello({ ...helloInput(), token: 7 })), /token/)
  assert.match(validateHello(hello({ ...helloInput(), protocol: 2 })), /protocol/)
  assert.match(validateHello({ type: 'hello' }), /clientId/)
})

test('validateWelcome accepts a valid frame and rejects bad shapes', () => {
  assert.equal(validateWelcome(welcome(welcomeInput())), undefined)
  assert.match(validateWelcome(welcome({ ...welcomeInput(), pid: Number.NaN })), /pid/)
  assert.match(validateWelcome(welcome({ ...welcomeInput(), capabilities: 'control' })), /capabilities/)
  assert.match(validateWelcome(welcome({ ...welcomeInput(), capabilities: [1] })), /capabilities/)
  assert.match(validateWelcome(welcome({ ...welcomeInput(), proof: undefined })), /proof/)
  assert.match(validateWelcome({ ...welcome(welcomeInput()), extra: 1 }), /extra/)
})

test('validateReady accepts only the bare ready frame', () => {
  assert.equal(validateReady(ready()), undefined)
  assert.match(validateReady({ type: 'ready', id: 'x' }), /unknown field/)
  assert.match(validateReady({ type: 'welcom' }), /type/)
})

test('validateRpc accepts a valid frame and rejects bad shapes', () => {
  assert.equal(validateRpc(rpc('c1', METHODS.SESSIONS_LIST)), undefined)
  assert.equal(validateRpc(rpc('c1', METHODS.PING, {})), undefined)
  assert.match(validateRpc(rpc(1, METHODS.PING)), /id/)
  assert.match(validateRpc({ type: 'rpc', id: 'c1' }), /method/)
  assert.match(validateRpc({ type: 'rpc', id: 'c1', method: 'ping', params: undefined }), /params/)
  assert.match(validateRpc(rpc('c1', 'ping', { at: Infinity })), /params/)
})

test('validateResult accepts a valid frame and rejects bad shapes', () => {
  assert.equal(validateResult(result('c1', { sessions: [] })), undefined)
  assert.equal(validateResult(result('c1', null)), undefined)
  assert.match(validateResult(result(1, null)), /id/)
  assert.match(validateResult({ type: 'result', id: 'c1' }), /value/)
  assert.match(validateResult(result('c1', { bad: undefined })), /value/)
})

test('validateError accepts a valid frame and rejects bad shapes', () => {
  assert.equal(validateError(error('c1', 'session-not-found', 'gone')), undefined)
  assert.equal(validateError(error('c1', 'x', 'y', { hint: 1 })), undefined)
  assert.match(validateError(error('c1', 1, 'y')), /code/)
  assert.match(validateError({ type: 'error', id: 'c1', code: 'x' }), /message/)
  assert.match(validateError(error('c1', 'x', 'y', () => {})), /details/)
})

test('validateEvent accepts a valid frame and rejects bad shapes', () => {
  assert.equal(validateEvent(event(EVENT_NAMES.BRIDGE_NOTICE, { level: 'info' })), undefined)
  assert.match(validateEvent({ type: 'event', data: {} }), /event/)
  assert.match(validateEvent({ type: 'event', event: 'x' }), /data/)
  assert.match(validateEvent(event('x', { fn: () => {} })), /data/)
})

test('validateActivity checks required fields, enums and optional flags', () => {
  assert.equal(validateActivity(entry()), undefined)
  assert.equal(validateActivity({ ...entry(), truncated: true, text: 'x', status: 'ok' }), undefined)
  assert.equal(validateActivity({ ...entry(), args: { cmd: 'ls' } }), undefined)
  assert.match(validateActivity({ seq: 1, kind: 'turn/start' }), /sessionId/)
  assert.match(validateActivity({ ...entry(), seq: '1' }), /seq/)
  assert.match(validateActivity({ ...entry(), seq: Number.POSITIVE_INFINITY }), /seq/)
  assert.match(validateActivity({ ...entry(), kind: 'tool/error' }), /kind/)
  assert.match(validateActivity({ ...entry(), truncated: 'yes' }), /truncated/)
  assert.match(validateActivity({ ...entry(), tool: 1 }), /tool/)
  assert.match(validateActivity({ ...entry(), nope: 1 }), /nope/)
})

test('validateSessionSummary checks required fields and optional strings', () => {
  assert.equal(validateSessionSummary(summary()), undefined)
  assert.equal(validateSessionSummary({ ...summary(), cwd: 'D:\\x', lastAgentError: 'boom' }), undefined)
  // A child session carries its parent so a client can fold subagent work away.
  assert.equal(validateSessionSummary({ ...summary(), parentId: 'root-1', origin: 'subagent', model: 'qwen/Qwen3' }), undefined)
  assert.match(validateSessionSummary({ ...summary(), parentId: 1 }), /parentId/)
  assert.match(validateSessionSummary({ ...summary(), origin: null }), /origin/)
  assert.match(validateSessionSummary({ ...summary(), model: {} }), /model/)
  assert.match(validateSessionSummary({ running: true, blank: false, updatedAt: 1 }), /id/)
  assert.match(validateSessionSummary({ ...summary(), displayTitle: 1 }), /displayTitle/)
  assert.match(validateSessionSummary({ ...summary(), running: 'true' }), /running/)
  assert.match(validateSessionSummary({ ...summary(), blank: 0 }), /blank/)
  assert.match(validateSessionSummary({ ...summary(), updatedAt: Number.NaN }), /updatedAt/)
  assert.match(validateSessionSummary({ ...summary(), cwd: null }), /cwd/)
})

test('validateDecision accepts the closed decision set only', () => {
  assert.equal(validateDecision('allow-once'), undefined)
  assert.equal(validateDecision('reject'), undefined)
  assert.match(validateDecision('allow'), /decision/)
  assert.match(validateDecision(undefined), /decision/)
})

test('validateFrame rejects unknown types and round-trips every constructor', () => {
  assert.match(validateFrame({ type: 'nope' }), /unknown message type/)
  assert.match(validateFrame({}), /unknown message type/)
  assert.match(validateFrame(null), /expected an object/)
  assert.match(validateFrame('hello'), /expected an object/)

  const frames = [
    hello(helloInput()),
    welcome(welcomeInput()),
    ready(),
    rpc('c1', METHODS.APPROVAL_DECIDE, { approvalId: 'a1', decision: 'allow-once' }),
    result('c1', { pong: true, serverTime: 1 }),
    error('c1', 'session-not-found', '会话不存在或已删除'),
    error('c1', 'x', 'y', { hint: 1 }),
    baseline({ sessions: [summary()], control: { queue: [] }, approvals: [] }),
    sessionsChanged({ upsert: [summary()] }),
    sessionsChanged({ removed: ['s1'] }),
    sessionsChanged({}),
    controlFrame({ jobs: [] }),
    activity(entry()),
    activity({ ...entry(), kind: 'turn/end', text: 'done', truncated: true }),
    approvalRequest({
      approvalId: 'a1',
      sessionId: 's1',
      toolName: 'bash',
      callId: 'call-1',
      reason: 'needs network',
      args: { cmd: 'ls' },
      deadlineAt: 1,
    }),
    approvalSettled('a1', 'allowed-once'),
    bridgeNotice('info', 'token-missing', 'temporary token generated'),
    bridgeNotice('warn', 'pipe-busy', 'pipe name already in use'),
  ]
  for (const frame of frames) {
    assert.equal(validateFrame(frame), undefined, JSON.stringify(frame))
  }
})

test('validateFrame checks the payload of known events', () => {
  assert.match(validateFrame(activity({ sessionId: 's1', seq: 1, kind: 'nope' })), /kind/)
  assert.match(validateFrame(approvalSettled('a1', 'maybe')), /outcome/)
  assert.match(
    validateFrame({ type: 'event', event: 'bridge.notice', data: { level: 'debug', code: 'c', message: 'm' } }),
    /level/,
  )
  assert.match(
    validateFrame({ type: 'event', event: 'approval.request', data: { approvalId: 'a', sessionId: 's' } }),
    /toolName/,
  )
  assert.match(
    validateFrame({ type: 'event', event: 'sessions.changed', data: { removed: 's1' } }),
    /removed/,
  )
  assert.equal(validateFrame(bridgeNotice('info', 'c', 'm')), undefined)
  assert.equal(validateFrame(event('some.other.event', { anything: 1 })), undefined)
})

test('constructors omit optional keys when undefined', () => {
  const request = approvalRequest({ approvalId: 'a1', sessionId: 's1', toolName: 'bash', deadlineAt: 5 })
  assert.equal('callId' in request.data, false)
  assert.equal('reason' in request.data, false)
  assert.equal('args' in request.data, false)
  assert.deepEqual(request.data, { approvalId: 'a1', sessionId: 's1', toolName: 'bash', deadlineAt: 5 })

  const withOptionals = approvalRequest({
    approvalId: 'a1', sessionId: 's1', toolName: 'bash', callId: 'c', reason: 'r', args: {}, deadlineAt: 5,
  })
  assert.equal(withOptionals.data.callId, 'c')

  const err = error('c1', 'x', 'y')
  assert.equal('details' in err, false)
  assert.equal('details' in error('c1', 'x', 'y', null), true)

  assert.equal('upsert' in sessionsChanged({}).data, false)
  assert.equal('removed' in sessionsChanged({}).data, false)
  assert.deepEqual(Object.keys(sessionsChanged({ removed: ['s1'] }).data), ['removed'])
})

test('bridgeNotice rejects an unknown level', () => {
  assert.throws(() => bridgeNotice('error', 'c', 'm'), TypeError)
})

test('encodeFrame ends with exactly one newline and enforces the ceiling', () => {
  const encoded = encodeFrame(ready())
  assert.equal(encoded, '{"type":"ready"}\n')
  assert.ok(encoded.endsWith('\n'))
  assert.equal(encoded.endsWith('\n\n'), false)
  assert.equal(encodeFrame(result('c1', { text: '数字人' })).split('\n').length, 2)

  const frame = { type: 'result', id: 'c1', value: 'x'.repeat(64) }
  assert.equal(encodeFrame(frame, 1024).endsWith('\n'), true)
  assert.throws(() => encodeFrame(frame, 32), ProtocolError)
  assert.throws(() => encodeFrame(frame, 32), /exceeds maxBytes/)
  assert.throws(() => encodeFrame({ type: 'result', id: 'c1', value: undefined }), ProtocolError)
  assert.throws(() => encodeFrame({ type: 'result', id: 'c1', value: 1n }), ProtocolError)
})

test('createFrameDecoder handles split chunks, batches, CRLF and flush', () => {
  const frames = []
  const decoder = createFrameDecoder({ onFrame: (frame) => frames.push(frame) })
  decoder('{"type":"re')
  decoder('ady"}\n{"type":"rpc","id":"c1","method":"ping","params":{}}\n')
  assert.deepEqual(frames, [
    { type: 'ready' },
    { type: 'rpc', id: 'c1', method: 'ping', params: {} },
  ])

  decoder('{"type":"ready"}\r\n')
  assert.equal(frames.length, 3)

  decoder('{"type":"partial"')
  assert.equal(frames.length, 3)
  assert.equal(decoder.flush(), '{"type":"partial"')
  assert.equal(decoder.flush(), '')
})

test('createFrameDecoder reports invalid JSON, resets and keeps delivering', () => {
  const frames = []
  const errors = []
  const decoder = createFrameDecoder({ onFrame: (f) => frames.push(f), onError: (e) => errors.push(e) })
  decoder('not json\n{"type":"ready"}\n')
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof ProtocolError)
  assert.equal(errors[0].code, 'protocol-invalid-frame')
  assert.deepEqual(frames, [{ type: 'ready' }])

  decoder('{"torn":\n{"type":"ready"}\n')
  assert.equal(errors.length, 2)
  assert.equal(frames.length, 2)
})

test('createFrameDecoder reports oversize lines and resumes', () => {
  const frames = []
  const errors = []
  const decoder = createFrameDecoder({
    maxBytes: 32,
    onFrame: (f) => frames.push(f),
    onError: (e) => errors.push(e),
  })
  decoder(`{"v":"${'x'.repeat(64)}"}\n`)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'protocol-frame-too-large')
  assert.deepEqual(frames, [])
  assert.equal(decoder.flush(), '')

  decoder('{"type":"ready"}\n')
  assert.deepEqual(frames, [{ type: 'ready' }])

  // An overlong line is swallowed up to its terminator and reported exactly once.
  decoder(`{"v":"${'y'.repeat(64)}`)
  assert.equal(errors.length, 2)
  decoder('y'.repeat(64))
  assert.equal(errors.length, 2, 'an unterminated oversize line is reported once')
  assert.equal(decoder.flush(), '')
  decoder('\n')
  assert.equal(errors.length, 2, 'the swallowed terminator is not reported')

  // The decoder resynchronizes on the next complete frame.
  decoder('{"type":"ready"}\n')
  assert.deepEqual(frames, [{ type: 'ready' }, { type: 'ready' }])
  assert.equal(errors.length, 2)

  // Oversize with the terminator inside the same chunk.
  decoder(`{"v":"${'z'.repeat(64)}"}\n{"type":"ready"}\n`)
  assert.equal(errors.length, 3)
  assert.equal(frames.length, 3)
})

test('createFrameDecoder accepts Buffers and a silent decoder stays inert', () => {
  const frames = []
  const decoder = createFrameDecoder({ onFrame: (f) => frames.push(f) })
  decoder(Buffer.from('{"type":"ready"}\n'))
  decoder(Buffer.from('{"type":"ready"}\n'))
  assert.equal(frames.length, 2)

  const silent = createFrameDecoder({})
  silent('garbage\n')
  assert.equal(silent.flush(), '')
})

test('isJsonValue accepts plain JSON and rejects everything else', () => {
  assert.equal(isJsonValue(null), true)
  assert.equal(isJsonValue(true), true)
  assert.equal(isJsonValue(0), true)
  assert.equal(isJsonValue('x'), true)
  assert.equal(isJsonValue({ a: [1, 'two', null, { b: false }] }), true)
  assert.equal(isJsonValue(Object.create(null)), true)

  assert.equal(isJsonValue(undefined), false)
  assert.equal(isJsonValue(() => {}), false)
  assert.equal(isJsonValue(Symbol('s')), false)
  assert.equal(isJsonValue(1n), false)
  assert.equal(isJsonValue(Number.NaN), false)
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false)
  assert.equal(isJsonValue(Number.NEGATIVE_INFINITY), false)
  assert.equal(isJsonValue(new Date()), false)
  assert.equal(isJsonValue(new Map()), false)
  assert.equal(isJsonValue(/re/), false)
  assert.equal(isJsonValue({ a: undefined }), false)
  assert.equal(isJsonValue([undefined]), false)
  assert.equal(isJsonValue({ a: () => {} }), false)

  const cycle = { a: 1 }
  cycle.self = cycle
  assert.equal(isJsonValue(cycle), false)
  const arrayCycle = []
  arrayCycle.push(arrayCycle)
  assert.equal(isJsonValue(arrayCycle), false)
  const shared = { v: 1 }
  assert.equal(isJsonValue({ a: shared, b: shared }), true, 'a DAG is not a cycle')
})

test('truncateText never splits a multi-byte character', () => {
  const text = '数字人'
  /**
   * Largest prefix of complete characters whose UTF-8 encoding fits in `limit` bytes.
   *
   * @param {string} value - Source text.
   * @param {number} limit - Byte budget.
   * @returns {string} Expected truncation.
   */
  const boundary = (value, limit) => {
    let kept = ''
    let used = 0
    for (const character of value) {
      const size = Buffer.byteLength(character, 'utf8')
      if (used + size > limit) break
      kept += character
      used += size
    }
    return kept
  }

  assert.equal(Buffer.byteLength(text, 'utf8'), 9)
  assert.equal(truncateText(text, 9), text)
  assert.equal(truncateText(text, 100), text)
  assert.equal(truncateText(text, 1), '', 'no whole character fits in one byte')
  assert.equal(truncateText(text, 2), '', 'no whole character fits in two bytes')
  assert.equal(truncateText(text, 4), text.slice(0, 1))

  for (let limit = 0; limit <= 12; limit += 1) {
    const clipped = truncateText(text, limit)
    assert.equal(clipped, boundary(text, limit), `limit ${limit}`)
    assert.ok(Buffer.byteLength(clipped, 'utf8') <= limit, `limit ${limit}`)
    assert.equal(Buffer.from(clipped, 'utf8').toString('utf8'), clipped)
    assert.equal(clipped.includes('\ufffd'), false)
  }

  assert.equal(truncateText(text, 5), text.slice(0, 1), 'a 5-byte prefix splits the second character')
  assert.equal(truncateText(text, 0), '')
  assert.equal(truncateText('abc', 0), '')
  assert.equal(truncateText('abc', Number.NaN), '')
  assert.equal(truncateText('abc', 2), 'ab')
  assert.equal(truncateText('abc', 2.9), 'ab')
  const emoji = `a\u{1f600}b`
  for (let limit = 0; limit <= 7; limit += 1) {
    assert.equal(truncateText(emoji, limit), boundary(emoji, limit), `emoji limit ${limit}`)
  }
  assert.equal(truncateText(emoji, 5), 'a\u{1f600}', 'a 5-byte budget holds the letter and the emoji')
  assert.equal(truncateText(emoji, 4), 'a', 'the 4-byte emoji does not fit after the letter')
  assert.equal(truncateText('', 10), '')
})

test('assertOk throws ProtocolError and returns undefined on success', () => {
  assert.equal(assertOk(undefined, 'frame'), undefined)
  assert.throws(() => assertOk('bad', 'welcome'), ProtocolError)
  try {
    assertOk('bad', 'welcome')
    assert.fail('expected a throw')
  } catch (thrown) {
    assert.equal(thrown.code, 'protocol-invalid-frame')
    assert.equal(thrown.name, 'ProtocolError')
    assert.equal(thrown.message, 'welcome: bad')
    assert.ok(thrown instanceof Error)
  }
})
