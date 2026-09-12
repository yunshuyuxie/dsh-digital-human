/**
 * Support-module tests for the digital-human bridge: config, endpoint/token, handshake, audit.
 *
 * Run in one process with `node test/run.mjs` so no child process with piped stdio is spawned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseConfig, defaultStateDir } from '../src/config.js'
import {
  createTokenStore,
  writeEndpoint,
  readEndpoint,
  removeEndpoint,
  encodeBase32,
} from '../src/endpoint.js'
import { randomNonce, serverProof, verifyProof, constantTimeEqual } from '../src/handshake.js'
import { createAuditLog } from '../src/audit.js'
import { MAX_FRAME_BYTES_DEFAULT, PROTOCOL_VERSION } from '../src/vendor/protocol/index.js'

/**
 * Create a throwaway directory and register its removal after the test.
 *
 * @param {import('node:test').TestContext} t - Test context.
 * @returns {Promise<string>} Temporary directory path.
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dh-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A representative plugin context. */
const CONTEXT = { profile: 'web', home: 'C:\\dsh-home' }

// ---------------------------------------------------------------------------- 1. config

test('parseConfig applies every documented default', () => {
  const config = parseConfig(undefined, CONTEXT)
  const stateDir = defaultStateDir(CONTEXT.home)

  assert.equal(config.enabled, true)
  assert.equal(config.pipeName, 'dsh-digital-human-web')
  assert.equal(config.approvalRouting, 'primary')
  assert.equal(config.approvalTimeoutMs, 120000)
  assert.deepEqual(config.approvalToolAllowlist, [])
  assert.equal(config.activityBufferPerSession, 200)
  assert.equal(config.activityMaxTextBytes, 2048)
  assert.equal(config.maxClients, 4)
  assert.equal(config.maxFrameBytes, MAX_FRAME_BYTES_DEFAULT)
  assert.equal(config.writeBufferLimitBytes, 4194304)
  assert.equal(config.auditFile, `${stateDir}/audit.jsonl`)
  assert.equal(config.profile, 'web')
  assert.equal(config.stateDir, stateDir)
  assert.equal(defaultStateDir('/home/me/.dsh'), '/home/me/.dsh/digital-human')
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.approvalToolAllowlist), true)
})

test('parseConfig builds the platform pipe path', () => {
  const config = parseConfig({}, CONTEXT)
  if (process.platform === 'win32') {
    assert.equal(config.pipePath, '\\\\.\\pipe\\dsh-digital-human-web')
  } else {
    assert.equal(config.pipePath, `${defaultStateDir(CONTEXT.home)}/dsh-digital-human-web.sock`)
  }
})

test('parseConfig accepts valid overrides and ignores unknown keys', () => {
  const allowlist = ['Bash', 'Write']
  const config = parseConfig(
    {
      enabled: false,
      pipeName: 'custom-pipe',
      approvalRouting: 'fallback',
      approvalTimeoutMs: 1000,
      approvalToolAllowlist: allowlist,
      activityBufferPerSession: 10000,
      activityMaxTextBytes: 64,
      maxClients: 64,
      maxFrameBytes: 1024,
      writeBufferLimitBytes: 65536,
      auditFile: 'D:\\logs\\audit.jsonl',
      futureOption: 'ignored',
    },
    CONTEXT,
  )
  assert.equal(config.enabled, false)
  assert.equal(config.pipeName, 'custom-pipe')
  assert.equal(config.approvalRouting, 'fallback')
  assert.equal(config.approvalTimeoutMs, 1000)
  assert.deepEqual(config.approvalToolAllowlist, ['Bash', 'Write'])
  assert.equal(config.activityBufferPerSession, 10000)
  assert.equal(config.activityMaxTextBytes, 64)
  assert.equal(config.maxClients, 64)
  assert.equal(config.maxFrameBytes, 1024)
  assert.equal(config.writeBufferLimitBytes, 65536)
  assert.equal(config.auditFile, 'D:\\logs\\audit.jsonl')
  allowlist.push('mutated')
  assert.deepEqual(config.approvalToolAllowlist, ['Bash', 'Write'])
})

test('parseConfig rejects each invalid field with a message naming it', () => {
  const cases = [
    ['enabled', 'no'],
    ['pipeName', ''],
    ['pipeName', 'a/b'],
    ['pipeName', 'a\\b'],
    ['pipeName', `a${String.fromCharCode(0)}b`],
    ['pipeName', 'p'.repeat(201)],
    ['approvalRouting', 'sometimes'],
    ['approvalTimeoutMs', 999],
    ['approvalTimeoutMs', 1.5],
    ['approvalTimeoutMs', 'soon'],
    ['approvalToolAllowlist', 'Bash'],
    ['approvalToolAllowlist', ['']],
    ['approvalToolAllowlist', [7]],
    ['activityBufferPerSession', 0],
    ['activityBufferPerSession', 10001],
    ['activityBufferPerSession', 2.5],
    ['activityMaxTextBytes', 63],
    ['activityMaxTextBytes', 1048577],
    ['maxClients', 0],
    ['maxClients', 65],
    ['maxFrameBytes', 1023],
    ['maxFrameBytes', 16777217],
    ['writeBufferLimitBytes', 65535],
    ['writeBufferLimitBytes', 268435457],
    ['auditFile', ''],
    ['auditFile', 42],
  ]
  for (const [field, value] of cases) {
    assert.throws(
      () => parseConfig({ [field]: value }, CONTEXT),
      (error) => {
        assert.ok(error instanceof Error, `${field}: expected an Error`)
        assert.match(error.message, new RegExp(field), `${field}: message must name the field`)
        return true
      },
      `expected rejection for ${field}=${JSON.stringify(value)}`,
    )
  }
  assert.throws(() => parseConfig([], CONTEXT), /config/)
  assert.throws(() => parseConfig('nope', CONTEXT), /config/)
})

// ---------------------------------------------------------------------------- 2. base32

test('encodeBase32 emits RFC 4648 alphabet without padding', () => {
  for (let round = 0; round < 32; round += 1) {
    const raw = randomBytes(32)
    const encoded = encodeBase32(raw)
    assert.equal(encoded.length, 52, '32 bytes must encode to 52 base32 characters')
    assert.match(encoded, /^[A-Z2-7]{52}$/, `unexpected alphabet in ${encoded}`)
  }
  assert.equal(encodeBase32(randomBytes(0)), '')
  assert.throws(() => encodeBase32('not bytes'), TypeError)
})

// ---------------------------------------------------------------------------- 3. token store

test('token store ensure creates, persists and re-reads one token per profile', async (t) => {
  const stateDir = await tempDir(t)
  const store = createTokenStore({ stateDir })
  assert.equal(store.path.replaceAll('\\', '/'), `${stateDir.replaceAll('\\', '/')}/secrets.json`)

  assert.equal(await store.read('web'), null)

  const first = await store.ensure('web')
  assert.equal(first.created, true)
  assert.match(first.token, /^[A-Z2-7]{52}$/)

  const second = await store.ensure('web')
  assert.equal(second.created, false)
  assert.equal(second.token, first.token)
  assert.equal(await store.read('web'), first.token)

  const other = await store.ensure('cli')
  assert.equal(other.created, true)
  assert.notEqual(other.token, first.token)
  assert.equal(await store.read('web'), first.token, 'second profile must not clobber the first')

  const text = await readFile(store.path, 'utf8')
  assert.equal(text.charCodeAt(0) === 0xfeff, false, 'secrets.json must not start with a BOM')
  assert.equal(text.endsWith('\n'), true)
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.profiles.web.token, first.token)
  assert.equal(parsed.profiles.cli.token, other.token)
  assert.equal(typeof parsed.profiles.web.createdAt, 'string')
  assert.equal(parsed.profiles.web.rotatedAt, null)

  await store.remove('web')
  assert.equal(await store.read('web'), null)
  assert.equal(await store.read('cli'), other.token, 'remove must drop only the named profile')

  await store.remove('web') // absent -> no-op
  assert.equal(await store.read('cli'), other.token)
})

test('token store serializes concurrent ensure calls without losing entries', async (t) => {
  const stateDir = await tempDir(t)
  const store = createTokenStore({ stateDir })
  const profiles = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const tokens = await Promise.all(profiles.map((profile) => store.ensure(profile)))

  const parsed = JSON.parse(await readFile(store.path, 'utf8'))
  for (const [index, profile] of profiles.entries()) {
    assert.equal(tokens[index].created, true)
    assert.equal(parsed.profiles[profile].token, tokens[index].token, `profile ${profile} was lost`)
  }
  assert.equal(Object.keys(parsed.profiles).length, profiles.length)
})

test('corrupt secrets.json throws and is never overwritten', async (t) => {
  const stateDir = await tempDir(t)
  const store = createTokenStore({ stateDir })
  await store.ensure('web') // directory now exists
  const corrupt = '{ this is not json'
  await writeFile(store.path, corrupt, 'utf8')

  await assert.rejects(() => store.read('web'), /corrupt/)
  await assert.rejects(() => store.ensure('cli'), /corrupt/)
  await assert.rejects(() => store.remove('web'), /corrupt/)
  assert.equal(await readFile(store.path, 'utf8'), corrupt, 'a corrupt file must be left untouched')
})

// ---------------------------------------------------------------------------- 4. endpoint

test('endpoint write/read/remove round-trips without a BOM', async (t) => {
  const stateDir = await tempDir(t)
  const info = {
    pid: 4242,
    host: 'DESKTOP-01',
    dshVersion: '0.1.5-rc.1',
    bridgeVersion: '0.1.0',
    startedAt: '2026-09-12T12:00:00.000Z',
    capabilities: ['control', 'activity', 'approvals', 'prompt', 'cancel', 'create', 'selectModel'],
  }

  assert.equal(await readEndpoint({ stateDir, profile: 'web' }), null)

  const file = await writeEndpoint({ stateDir, profile: 'web', info })
  assert.equal(file.replaceAll('\\', '/'), `${stateDir.replaceAll('\\', '/')}/endpoints/web.json`)

  const bytes = await readFile(file)
  assert.notEqual(bytes[0], 0xef, 'endpoint file must not start with a UTF-8 BOM')
  const text = bytes.toString('utf8')
  assert.equal(text.endsWith('\n'), true)

  const record = await readEndpoint({ stateDir, profile: 'web' })
  assert.equal(record.version, 1)
  assert.equal(record.protocol, PROTOCOL_VERSION)
  assert.equal(record.transport, 'pipe')
  assert.equal(record.profile, 'web')
  assert.equal(record.pid, 4242)
  assert.equal(record.host, 'DESKTOP-01')
  assert.equal(record.bridgeVersion, '0.1.0')
  assert.deepEqual(record.capabilities, info.capabilities)
  assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  if (process.platform === 'win32') {
    assert.equal(record.path, '\\\\.\\pipe\\dsh-digital-human-web')
  } else {
    assert.equal(record.path, `${stateDir}/dsh-digital-human-web.sock`)
  }

  await removeEndpoint({ stateDir, profile: 'web' })
  await assert.rejects(() => stat(file), { code: 'ENOENT' })
  assert.equal(await readEndpoint({ stateDir, profile: 'web' }), null)
  await removeEndpoint({ stateDir, profile: 'web' }) // absent -> no-op
})

// ---------------------------------------------------------------------------- 5. handshake

test('handshake proofs verify only for the matching token and nonces', () => {
  const token = encodeBase32(randomBytes(32))
  const other = encodeBase32(randomBytes(32))
  const clientNonce = randomNonce()
  const serverNonce = randomNonce()
  const proof = serverProof({ token, clientNonce, serverNonce })

  assert.match(clientNonce, /^[A-Za-z0-9+/]{22}==$/) // 16 bytes -> 24 base64 chars with padding
  assert.equal(Buffer.from(clientNonce, 'base64').length, 16)
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof }), true)
  assert.equal(verifyProof({ token: other, clientNonce, serverNonce, proof }), false)
  assert.equal(verifyProof({ token, clientNonce: randomNonce(), serverNonce, proof }), false)
  assert.equal(verifyProof({ token, clientNonce, serverNonce: randomNonce(), proof }), false)
  // A longer/shorter base64 string must be rejected; note that `proof + 'A'` decodes to the same
  // bytes because Node stops at the `=` padding, so the malformed cases below are the honest ones.
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof: `${proof.slice(0, 43)}A` }), false)
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof: proof.slice(0, 22) }), false)
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof: undefined }), false)
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof: '' }), false)
  // `Buffer.from('!!!', 'base64')` is empty rather than throwing; both shapes must be rejected.
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof: '!!!' }), false)
  assert.equal(verifyProof({ token, clientNonce, serverNonce, proof: 'AAAA' }), false)

  // A base64 token works exactly like a base32 one: the token is an opaque string.
  const base64Token = randomBytes(32).toString('base64')
  assert.equal(
    verifyProof({
      token: base64Token,
      clientNonce,
      serverNonce,
      proof: serverProof({ token: base64Token, clientNonce, serverNonce }),
    }),
    true,
  )
})

test('constantTimeEqual is false for unequal lengths and non-strings', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('abc', 'abd'), false)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
  assert.equal(constantTimeEqual('', ''), true)
  assert.equal(constantTimeEqual('', 'a'), false)
  assert.equal(constantTimeEqual(undefined, undefined), false)
  assert.equal(constantTimeEqual(undefined, 'a'), false)
  assert.equal(constantTimeEqual(null, null), false)
  assert.equal(constantTimeEqual(1, 1), false)
  assert.equal(constantTimeEqual(Buffer.from('a'), 'a'), false)
  assert.equal(constantTimeEqual('日本語', '日本語'), true)
})

// ---------------------------------------------------------------------------- 6. audit

test('audit appends valid JSONL lines in order and flush waits', async (t) => {
  const stateDir = await tempDir(t)
  const file = join(stateDir, 'nested', 'audit.jsonl')
  const audit = createAuditLog({ file })
  assert.equal(audit.file, file)

  const total = 25
  const writes = []
  for (let index = 0; index < total; index += 1) writes.push(audit.append({ seq: index, profile: 'web' }))
  assert.deepEqual(await Promise.all(writes), new Array(total).fill(true))

  await audit.flush()

  const text = await readFile(file, 'utf8')
  assert.equal(text.charCodeAt(0) === 0xfeff, false, 'audit file must not start with a BOM')
  assert.equal(text.endsWith('\n'), true)
  const lines = text.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, total)
  for (const [index, line] of lines.entries()) {
    const record = JSON.parse(line)
    assert.equal(record.seq, index, 'lines must be written in append order')
    assert.equal(record.profile, 'web')
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/)
  }

  await audit.close()
  assert.equal(await audit.append({ seq: 'after-close' }), false)
  await audit.flush()
  const afterClose = (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0)
  assert.equal(afterClose.length, total, 'append after close must be a no-op')
})

test('audit reports an unwritable path through onError exactly once and never rejects', async (t) => {
  const stateDir = await tempDir(t)
  const blocker = join(stateDir, 'blocker')
  await writeFile(blocker, 'not a directory', 'utf8')
  const file = join(blocker, 'audit.jsonl')

  const failures = []
  const audit = createAuditLog({ file, onError: (info) => failures.push(info) })

  assert.equal(await audit.append({ seq: 0 }), false)
  assert.equal(await audit.append({ seq: 1 }), false)
  await audit.flush()
  await audit.close()

  assert.equal(failures.length, 1, 'the same error must warn once, not once per append')
  assert.equal(failures[0].file, file)
  assert.ok(failures[0].error instanceof Error, 'onError receives the underlying error')
})

test('audit onError sink throws do not escape append', async (t) => {
  const stateDir = await tempDir(t)
  const blocker = join(stateDir, 'blocker')
  await writeFile(blocker, 'not a directory', 'utf8')
  const audit = createAuditLog({
    file: join(blocker, 'audit.jsonl'),
    onError: () => {
      throw new Error('sink exploded')
    },
  })
  assert.equal(await audit.append({ seq: 0 }), false)
  await audit.flush()
})
