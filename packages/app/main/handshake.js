/**
 * Token-proof primitives for the client half.
 *
 * The bridge already owns a copy of this scheme (`packages/bridge/src/handshake.js`).
 * The app cannot import it — an installed app has no access to the bridge
 * package — so the implementation is repeated here and the two are cross-checked
 * by `tools/cross-check-handshake.mjs`, which fails if they ever disagree.
 *
 * Proof definition (protocol v1): base64(HMAC-SHA256(token, `${clientNonce}\0${serverNonce}`)).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Separator between the two nonces; NUL cannot appear in either. */
const SEPARATOR = '\u0000';

/**
 * Mint one nonce.
 * @returns base64 of 16 random bytes.
 */
export function randomNonce() {
  return randomBytes(16).toString('base64');
}

/**
 * Compute the proof one side sends to the other.
 * @param options - token and both nonces.
 * @returns base64 HMAC-SHA256.
 */
export function serverProof({ token, clientNonce, serverNonce }) {
  return createHmac('sha256', String(token)).update(`${clientNonce}${SEPARATOR}${serverNonce}`).digest('base64');
}

/**
 * Compare two strings without leaking length-independent timing.
 * @param left - candidate.
 * @param right - expected.
 * @returns true when both are strings of equal bytes and content.
 */
export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a proof received from the other side.
 * @param options - token, both nonces, and the received proof.
 * @returns true when the proof matches.
 */
export function verifyProof({ token, clientNonce, serverNonce, proof }) {
  if (typeof proof !== 'string' || proof === '') return false;
  return constantTimeEqual(proof, serverProof({ token, clientNonce, serverNonce }));
}
