/**
 * Mutual proof-of-token for the bridge handshake (design.md §5.1, §5.2.5).
 *
 * The token is a shared secret stored in `<stateDir>/secrets.json`; the proof binds it to both
 * nonces so a replayed `welcome` cannot be reused against another connection. This is defence in
 * depth on top of the OS user account, not a security boundary of its own.
 *
 * @module dsh-digital-human-bridge/handshake
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { Buffer } from 'node:buffer'

/**
 * Number of random bytes in a handshake nonce.
 *
 * @type {number}
 */
const NONCE_BYTES = 16

/**
 * Generate a fresh handshake nonce.
 *
 * @returns {string} Base64 of 16 cryptographically random bytes (24 characters).
 */
export function randomNonce() {
  return randomBytes(NONCE_BYTES).toString('base64')
}

/**
 * Build the canonical proof message: `clientNonce NUL serverNonce`.
 *
 * @param {string} clientNonce - Client nonce, treated as an opaque string.
 * @param {string} serverNonce - Server nonce, treated as an opaque string.
 * @returns {string} Message to HMAC.
 */
function proofMessage(clientNonce, serverNonce) {
  return `${clientNonce}\u0000${serverNonce}`
}

/**
 * Compute the shared proof.
 *
 * @param {object} input - Proof inputs.
 * @param {string} input.token - Shared token (base64 or base32), used verbatim as the HMAC key.
 * @param {string} input.clientNonce - Nonce supplied by the client.
 * @param {string} input.serverNonce - Nonce supplied by the server.
 * @returns {string} Base64 HMAC-SHA256 over `${clientNonce}\u0000${serverNonce}`.
 */
export function serverProof({ token, clientNonce, serverNonce }) {
  return createHmac('sha256', Buffer.from(String(token), 'utf8'))
    .update(proofMessage(clientNonce, serverNonce), 'utf8')
    .digest('base64')
}

/**
 * Compare two strings without leaking their contents through timing.
 *
 * @param {unknown} a - First value.
 * @param {unknown} b - Second value.
 * @returns {boolean} `true` only for two strings with identical UTF-8 bytes; `false` for
 *   non-strings or a length mismatch (reported without comparing contents).
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  if (left.length === 0) return true // timingSafeEqual rejects zero-length buffers
  return timingSafeEqual(left, right)
}

/**
 * Verify a proof the peer claims to have derived from the shared token.
 *
 * @param {object} input - Verification inputs.
 * @param {string} input.token - Shared token.
 * @param {string} input.clientNonce - Nonce supplied by the client.
 * @param {string} input.serverNonce - Nonce supplied by the server.
 * @param {unknown} input.proof - Candidate proof, base64 as sent on the wire.
 * @returns {boolean} `true` when the proof matches; `false` for a mismatch or malformed input.
 */
export function verifyProof({ token, clientNonce, serverNonce, proof }) {
  if (typeof proof !== 'string' || proof.length === 0) return false
  let presented
  try {
    presented = Buffer.from(proof, 'base64')
  } catch {
    return false
  }
  if (presented.length === 0) return false
  const expected = Buffer.from(serverProof({ token, clientNonce, serverNonce }), 'base64')
  if (presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}
