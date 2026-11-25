// Shared vectors (docs/protocol.md): one file, the Go tests read it too.
// Run: node --test src/features/pairing/crypto.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authMessage,
  answerCheck,
  comparisonCode,
  fingerprint,
  pinCheck,
  sdpFingerprint,
  verifyProof,
} from './crypto.ts'
import v from '../../../../gateway/internal/pairing/testdata/vectors.json' with { type: 'json' }

const raw = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const ecdsa = { name: 'ECDSA', hash: 'SHA-256' }

test('key fingerprint', async () => {
  assert.equal(await fingerprint(raw(v.spki).buffer), v.keyFp)
})

test('comparison code', async () => {
  assert.equal(
    await comparisonCode(v.gatewayFp, v.keyFp, v.codeNA, v.codeNB),
    v.code,
  )
})

test('auth signature: vector verifies, fresh signature from the same key verifies', async () => {
  const pub = await crypto.subtle.importKey(
    'spki',
    raw(v.spki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const msg = authMessage(v.gatewayFp, v.browserFp, v.n)
  assert.ok(await crypto.subtle.verify(ecdsa, pub, raw(v.sig), msg))
  const priv = await crypto.subtle.importKey(
    'pkcs8',
    raw(v.pkcs8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(ecdsa, priv, msg)
  assert.equal(sig.byteLength, 64) // P1363 r‖s — what Go's VerifyAuth expects
  assert.ok(await crypto.subtle.verify(ecdsa, pub, sig, msg))
})

test('sdp fingerprint is normalized', () => {
  assert.equal(
    sdpFingerprint('v=0\r\na=fingerprint:sha-256 ab:cd\r\n'),
    'sha-256 AB:CD',
  )
})

test('sdp fingerprint: exactly one distinct sha-256 fingerprint, else throws', () => {
  const s = (fp: string) => `a=fingerprint:${fp}\r\n`
  const m = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
  const a = 'sha-256 AB:CD'
  const b = 'sha-256 AB:CE'
  // the same one repeated (session + media level, any case) is one fingerprint
  assert.equal(
    sdpFingerprint('v=0\r\n' + s(a) + m + s('SHA-256 ab:cd') + m + s(a)),
    a,
  )
  assert.throws(() => sdpFingerprint('v=0\r\n' + s(a) + s(b) + m)) // session level
  assert.throws(() => sdpFingerprint('v=0\r\n' + m + s(a) + m + s(b))) // media level
  assert.throws(() => sdpFingerprint('v=0\r\n' + m + s(a) + s(b))) // one section
  assert.throws(() => sdpFingerprint('v=0\r\n' + s(a) + m + s(b))) // mixed
  assert.throws(() => sdpFingerprint('v=0\r\n' + s(a) + m + s('sha-1 AB:CD'))) // other hash beside it
  assert.throws(() => sdpFingerprint('v=0\r\n' + m)) // none
  assert.throws(() => sdpFingerprint('v=0\r\n' + s('sha-1 AB:CD') + m)) // not sha-256
  assert.throws(() => sdpFingerprint('v=0\r\n' + s('sha-512 AB:CD') + m))
})

test("gateway proof: Go's vector verifies, bound to this session", async () => {
  const proof = (gw: string, br: string, sig = v.proof, spki = v.spki) =>
    verifyProof(spki, sig, gw, br, v.n)
  assert.equal(await proof(v.gatewayFp, v.browserFp), v.keyFp)
  assert.equal(await proof(v.gatewayFp, v.gatewayFp), undefined) // a MITM's browser-side cert
  assert.equal(await proof(v.browserFp, v.browserFp), undefined) // a MITM's gateway-side cert
  assert.equal(await proof(v.gatewayFp, v.browserFp, v.sig), undefined) // the client's auth signature
  assert.equal(
    await proof(v.gatewayFp, v.browserFp, v.proof, 'AAAA'),
    undefined,
  ) // not a key
})

test('pin check: pinned key passes, changed key refused unless pairing', () => {
  assert.equal(pinCheck(v.gatewayFp, v.gatewayFp, false), 'pinned')
  assert.equal(pinCheck(v.gatewayFp, v.browserFp, false), 'refuse') // MITM / cert swapped
  assert.equal(pinCheck(v.gatewayFp, v.browserFp, true), 'unpinned') // re-pair: code must vouch
  assert.equal(pinCheck(undefined, v.gatewayFp, true), 'unpinned') // first pairing
  assert.equal(pinCheck(undefined, v.gatewayFp, false), 'unpinned') // gateway will say unpaired
})

test('answer check: the DTLS fingerprint, or why the answer is refused', () => {
  const sdp = 'v=0\r\na=fingerprint:sha-256 ab:cd\r\n'
  assert.deepEqual(answerCheck(sdp), { fp: 'sha-256 AB:CD' })
  assert.deepEqual(answerCheck('v=0\r\n'), {
    refused:
      'gateway answer refused: SDP with 0 distinct fingerprints, expected 1',
  })
})
