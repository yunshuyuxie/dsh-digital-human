#!/usr/bin/env node
/**
 * Cross-check the app's token-proof implementation against the bridge's.
 *
 * The app cannot import the bridge package (an installed app has no access to
 * it), so the scheme is implemented twice. This check fails if the two ever
 * disagree — the alternative is a handshake that silently stops working after a
 * change on one side.
 *
 * Usage: node tools/cross-check-handshake.mjs
 */
import { serverProof as appProof, randomNonce as appNonce, verifyProof as appVerify } from '../main/handshake.js';
import {
  serverProof as bridgeProof,
  verifyProof as bridgeVerify,
  randomNonce as bridgeNonce,
} from '../../bridge/src/handshake.js';

const failures = [];

/** Record one comparison. */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

const token = 'JBSWY3DPEHPK3PXP'; // base32-looking, opaque to both sides
const clientNonce = appNonce();
const serverNonce = bridgeNonce();

const app = appProof({ token, clientNonce, serverNonce });
const bridge = bridgeProof({ token, clientNonce, serverNonce });

check('both implementations produce the same proof', app === bridge, app === bridge ? app.slice(0, 12) : `${app.slice(0, 12)} vs ${bridge.slice(0, 12)}`);
check('each verifies the other', appVerify({ token, clientNonce, serverNonce, proof: bridge }) && bridgeVerify({ token, clientNonce, serverNonce, proof: app }));
check('a wrong token is rejected', !appVerify({ token: 'WRONG', clientNonce, serverNonce, proof: bridge }) && !bridgeVerify({ token: 'WRONG', clientNonce, serverNonce, proof: app }));
check('swapped nonces are rejected', !appVerify({ token, clientNonce: serverNonce, serverNonce: clientNonce, proof: bridge }));
check('an empty proof is rejected', !appVerify({ token, clientNonce, serverNonce, proof: '' }));

console.log(failures.length === 0 ? 'cross-check: OK' : `cross-check: ${String(failures.length)} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
