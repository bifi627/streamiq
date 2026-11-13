// Shared vectors (docs/protocol.md) — the Go tests assert the same values.
// Run: node --test src/features/pairing/crypto.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authMessage,
  comparisonCode,
  fingerprint,
  pinCheck,
  sdpFingerprint,
} from './crypto.ts'

const v = {
  pkcs8:
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNfSxgTmdmEdSnpZREJ8zENfSXNkksKt+maxxPfmM/0OhRANCAASZO24jDJAtjsPMwyNMixSTFrNaCBNOcl++jKq1UlDMtdhrPnx+TVcO+RDzLnEwFciaW/hHW06pJCe99d4wkcc3',
  spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmTtuIwyQLY7DzMMjTIsUkxazWggTTnJfvoyqtVJQzLXYaz58fk1XDvkQ8y5xMBXImlv4R1tOqSQnvfXeMJHHNw==',
  keyFp:
    'sha-256 40:F0:B4:7F:13:E4:C0:9B:73:86:7F:7A:77:E1:16:71:A2:AF:84:61:A0:8F:9F:15:25:CB:FE:7F:82:8A:C6:10',
  gatewayFp:
    'sha-256 D4:F0:BC:5A:29:DE:06:B5:10:F9:AA:42:8F:1E:ED:BA:92:60:12:B5:91:FE:F7:A5:18:E7:76:A7:C9:BD:18:24',
  browserFp:
    'sha-256 D4:C3:E8:A1:12:56:AB:82:A4:FC:72:56:0E:B4:A2:B0:E8:7B:AD:82:0C:29:0D:D9:B0:36:16:DE:24:0A:A6:DB',
  n: '0'.repeat(63) + '1',
  sig: 'jXq2DxskrRUJ2/lPhsID2biFys0vK47f+Z9XNWopW2mdfxatIsNm8/UtQV6feHlf/U42r5ERviRotv6W8GE0GQ==',
}
const raw = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const ecdsa = { name: 'ECDSA', hash: 'SHA-256' }

test('key fingerprint', async () => {
  assert.equal(await fingerprint(raw(v.spki).buffer), v.keyFp)
})

test('comparison code', async () => {
  assert.equal(
    await comparisonCode(
      v.gatewayFp,
      v.keyFp,
      '11'.repeat(32),
      '22'.repeat(32),
    ),
    '138781',
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

test('pin check: pinned cert passes, changed cert refused unless pairing', () => {
  assert.equal(pinCheck(v.gatewayFp, v.gatewayFp, false), 'pinned')
  assert.equal(pinCheck(v.gatewayFp, v.browserFp, false), 'refuse') // MITM / cert swapped
  assert.equal(pinCheck(v.gatewayFp, v.browserFp, true), 'unpinned') // re-pair: code must vouch
  assert.equal(pinCheck(undefined, v.gatewayFp, true), 'unpinned') // first pairing
  assert.equal(pinCheck(undefined, v.gatewayFp, false), 'unpinned') // gateway will say unpaired
})
