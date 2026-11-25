import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayOffline } from '../../generated/protocol.ts'
import {
  start,
  step,
  type Effect,
  type Event,
  type Init,
  type State,
} from './handshake.ts'

const FP = 'sha-256 AB:CD' // the normalized form of the SDP line below: the tunnel's DTLS cert
const KEY = 'sha-256 4B:45:59' // the gateway's identity key: the pin
const sdp = { type: 'answer', sdp: `v=0\r\na=fingerprint:sha-256 ab:cd\r\n` }
const TURN = [{ urls: 'turn:relay.example:3478' }]
const STUN = [{ urls: 'stun:stun.example:3478' }]

const init = (over: Partial<Init> = {}): State =>
  start({
    gatewayId: 'g1',
    pin: KEY,
    pairing: false,
    forceRelay: false,
    relayTls: false,
    ...over,
  })

const broker = (m: object): Event => ({ on: 'broker', data: JSON.stringify(m) })
const gateway = (m: object): Event => ({
  on: 'gateway',
  data: JSON.stringify(m),
})

/** Feeds the events in order; the effects of all of them. */
function run(s: State, ...events: Event[]) {
  const fx: Effect[] = []
  for (const ev of events) {
    const r = step(s, ev)
    s = r.state
    fx.push(...r.fx)
  }
  return { s, fx }
}

const kinds = (fx: Effect[]) => fx.map((f) => f.do)
const failure = (fx: Effect[]) => {
  const f = fx.find((x) => x.do === 'fail')
  return f && f.do === 'fail' ? f.error : undefined
}

const challenge = gateway({ type: 'challenge', n: 'n1', spki: 'S', sig: 'G' })
const proof = (keyFp = KEY): Event => ({
  on: 'proof',
  n: 'n1',
  keyFp,
})

const answered = (over: Partial<Init> = {}) =>
  run(
    init(over),
    { on: 'open' },
    broker({ type: 'ready', iceServers: TURN }),
    broker({ type: 'answer', tunnel: 't1', sdp }),
  ).s

/** Answered, and the challenge's proof checked out as KEY. */
const proven = (over: Partial<Init> = {}) =>
  run(answered(over), challenge, proof()).s

test('the happy path: auth, offer, answer, challenge, ok → resolve', () => {
  const { s, fx } = run(
    init(),
    { on: 'open' },
    broker({ type: 'ready', iceServers: TURN }),
    broker({ type: 'answer', tunnel: 't1', sdp }),
    challenge,
    proof(),
    gateway({ type: 'ok' }),
  )
  assert.deepEqual(kinds(fx), [
    'auth',
    'relayLine',
    'offer',
    'answer',
    'verify',
    'sign',
    'resolve',
  ])
  assert.deepEqual(fx[4], {
    do: 'verify',
    n: 'n1',
    spki: 'S',
    sig: 'G',
    dtlsFp: FP,
  })
  assert.deepEqual(fx[5], { do: 'sign', n: 'n1', dtlsFp: FP, pair: false })
  assert.equal(s.gatewayFp, KEY)
  assert.equal(s.phase, 'up')
})

test('an ICE candidate before the answer waits for it', () => {
  const c1 = { candidate: 'candidate:1' }
  const c2 = { candidate: 'candidate:2' }
  let r = run(
    init(),
    { on: 'open' },
    broker({ type: 'ready', iceServers: TURN }),
    broker({ type: 'ice', candidate: c1 }),
  )
  assert.deepEqual(kinds(r.fx), ['auth', 'relayLine', 'offer'])
  r = run(
    r.s,
    broker({ type: 'answer', sdp }),
    broker({ type: 'ice', candidate: c2 }),
  )
  assert.deepEqual(r.fx, [
    { do: 'answer', sdp },
    { do: 'addIce', candidate: c1 },
    { do: 'addIce', candidate: c2 },
  ])
  assert.deepEqual(r.s.early, [])
})

test('a brief connection failed that recovers does not fail', () => {
  const r = run(
    proven(),
    { on: 'connection', state: 'connecting' },
    { on: 'connection', state: 'failed' },
    { on: 'connection', state: 'failed' }, // a repeat doesn't rearm
    { on: 'connection', state: 'connecting' }, // the gateway's next candidate
    { on: 'graceOver' }, // a timer that fired as it was cancelled
    { on: 'connection', state: 'connected' },
  )
  assert.deepEqual(r.fx, [
    { do: 'grace', arm: true },
    { do: 'grace', arm: false },
  ])
  assert.equal(r.s.phase, 'connecting')
})

test('a connection failed that lasts the grace period fails', () => {
  const r = run(
    proven(),
    { on: 'connection', state: 'failed' },
    { on: 'graceOver' },
  )
  assert.equal(failure(r.fx)?.kind, 'ice-failed')
})

test('a connection failed after connected fails at once (a lost tunnel)', () => {
  const r = run(
    proven(),
    { on: 'connection', state: 'connected' },
    gateway({ type: 'ok' }),
    { on: 'connection', state: 'failed' },
  )
  assert.equal(failure(r.fx)?.kind, 'ice-failed')
})

test('the broker socket closing', async (t) => {
  await t.test('during pairing: broker-lost', () => {
    const r = run(
      proven({ pin: undefined, pairing: true }),
      gateway({ type: 'unpaired' }),
      { on: 'close', reason: '' },
    )
    assert.deepEqual(kinds(r.fx), ['commit', 'fail'])
    assert.equal(failure(r.fx)?.kind, 'broker-lost')
  })
  await t.test('before it opened: broker-unreachable', () => {
    const r = run(init(), { on: 'close', reason: '' })
    assert.equal(failure(r.fx)?.kind, 'broker-unreachable')
  })
  await t.test('because the gateway went: gateway-offline', () => {
    const r = run(proven(), { on: 'close', reason: 'gateway gone' })
    assert.equal(failure(r.fx)?.kind, 'gateway-offline')
  })
})

test('ok for an unpinned identity is refused', () => {
  const r = run(
    answered({ pin: undefined, pairing: true }),
    challenge,
    proof(),
    gateway({ type: 'ok' }),
  )
  assert.deepEqual(r.fx[1], { do: 'sign', n: 'n1', dtlsFp: FP, pair: true })
  assert.equal(failure(r.fx)?.kind, 'pin-mismatch')
})

test('the identity proof: our key goes out only for a verified, pinned (or pairing) key', async (t) => {
  await t.test('a changed key outside pairing is refused', () => {
    const r = run(answered(), challenge, proof('sha-256 FF'))
    assert.deepEqual(kinds(r.fx), ['verify', 'fail'])
    assert.equal(failure(r.fx)?.kind, 'pin-mismatch')
  })
  await t.test(
    'a proof that does not verify is refused, even when pairing',
    () => {
      const r = run(answered({ pairing: true }), challenge, {
        on: 'proof',
        n: 'n1',
        keyFp: undefined, // proof()'s default would fill in KEY
      })
      assert.deepEqual(kinds(r.fx), ['verify', 'fail'])
      assert.equal(failure(r.fx)?.kind, 'pin-mismatch')
    },
  )
  await t.test('pairing again with a changed key: the code must vouch', () => {
    const r = run(answered({ pairing: true }), challenge, proof('sha-256 FF'))
    assert.deepEqual(r.fx[1], { do: 'sign', n: 'n1', dtlsFp: FP, pair: true })
    assert.equal(r.s.gatewayFp, 'sha-256 FF')
  })
  await t.test(
    'an old certificate pin is just a changed key: pair again',
    () => {
      const r = run(answered({ pin: FP, pairing: true }), challenge, proof())
      assert.deepEqual(r.fx[1], { do: 'sign', n: 'n1', dtlsFp: FP, pair: true })
    },
  )
  await t.test('an answer without one fingerprint is refused', () => {
    const bad = { type: 'answer', sdp: 'v=0\r\n' }
    const r = run(init(), broker({ type: 'answer', sdp: bad }))
    assert.deepEqual(kinds(r.fx), ['fail'])
    assert.equal(failure(r.fx)?.kind, 'pin-mismatch')
  })
})

test('rejected', () => {
  const r = run(
    proven({ pairing: true }),
    gateway({ type: 'rejected', reason: 'denied on the gateway' }),
  )
  assert.equal(failure(r.fx)?.kind, 'gateway-refused')
  assert.equal(failure(r.fx)?.message, 'gateway refused: denied on the gateway')
  for (const reason of [
    'too many pending pairing requests',
    'this user is already pairing a browser',
  ]) {
    const full = run(
      proven({ pairing: true }),
      gateway({ type: 'rejected', reason }),
    )
    assert.equal(failure(full.fx)?.kind, 'gateway-busy', reason)
  }
  // By equality: a reworded reason is a refusal, not busy.
  const reworded = run(
    proven({ pairing: true }),
    gateway({ type: 'rejected', reason: 'too many pending pairing requests!' }),
  )
  assert.equal(failure(reworded.fx)?.kind, 'gateway-refused')
})

test('pairing: commit, reveal, approved → pin and resolve', () => {
  const r = run(
    proven({ pin: undefined, pairing: true }),
    gateway({ type: 'unpaired' }),
    gateway({ type: 'nonce', n: 'gn' }),
    gateway({ type: 'approved' }),
  )
  assert.deepEqual(r.fx, [
    { do: 'commit' },
    { do: 'reveal', n: 'gn', fp: KEY },
    { do: 'approved', fp: KEY },
  ])
  assert.equal(r.s.phase, 'up')
})

test('unpaired without pairing: not-paired', () => {
  const r = run(proven(), gateway({ type: 'unpaired' }))
  assert.equal(failure(r.fx)?.kind, 'not-paired')
})

test('a challenge without a nonce is refused', () => {
  const r = run(answered(), gateway({ type: 'challenge' }))
  assert.equal(failure(r.fx)?.kind, 'gateway-refused')
})

test('the data channel closing', async (t) => {
  await t.test('after resolve: no reject', () => {
    const r = run(proven(), gateway({ type: 'ok' }), { on: 'channelClose' })
    assert.deepEqual(kinds(r.fx), ['resolve'])
  })
  await t.test('before resolve: gateway-refused', () => {
    const r = run(proven(), { on: 'channelClose' })
    assert.equal(failure(r.fx)?.kind, 'gateway-refused')
  })
})

test('forced relay', async (t) => {
  await t.test('with no TURN fails at ready, saying why', () => {
    const r = run(
      init({ forceRelay: true }),
      { on: 'open' },
      broker({ type: 'ready', iceServers: STUN }),
    )
    assert.deepEqual(kinds(r.fx), ['auth', 'relayLine', 'fail'])
    assert.equal(failure(r.fx)?.kind, 'ice-failed')
    assert.match(
      failure(r.fx)?.message ?? '',
      /relay forced, but relay unavailable/,
    )
  })
  await t.test('with TURN offers', () => {
    const r = run(
      init({ forceRelay: true }),
      broker({ type: 'ready', iceServers: TURN }),
    )
    assert.deepEqual(kinds(r.fx), ['relayLine', 'offer'])
  })
  await t.test(
    'not forced, no TURN: offers; a lasting ICE failure names it',
    () => {
      const r = run(
        init(),
        broker({ type: 'ready', iceServers: STUN }),
        { on: 'connection', state: 'failed' },
        { on: 'graceOver' },
      )
      assert.deepEqual(kinds(r.fx), ['relayLine', 'offer', 'grace', 'fail'])
      assert.match(
        failure(r.fx)?.message ?? '',
        /relay unavailable: no TURN server/,
      )
    },
  )
})

test('after a failure every event is ignored', () => {
  const r = run(
    proven(),
    { on: 'channelClose' },
    { on: 'close', reason: '' },
    gateway({ type: 'ok' }),
  )
  assert.deepEqual(kinds(r.fx), ['fail'])
})

test('a broker error and broken JSON fail', () => {
  assert.equal(
    failure(run(init(), broker({ type: 'error', error: GatewayOffline })).fx)
      ?.kind,
    'gateway-offline',
  )
  assert.equal(
    failure(run(init(), { on: 'broker', data: '{' }).fx)?.kind,
    'unknown',
  )
})

test('pairing messages out of order are refused', async (t) => {
  const refused = (over: Partial<Init>, ...events: Event[]) => {
    const r = run(proven(over), ...events)
    assert.equal(failure(r.fx)?.kind, 'gateway-refused')
    assert.equal(failure(r.fx)?.message.endsWith('out of order'), true)
    assert.equal(kinds(r.fx).includes('approved'), false)
    return kinds(r.fx)
  }
  const pairing = { pin: undefined, pairing: true }
  await t.test('approved without pairing (no code was compared)', () => {
    refused({ pin: undefined }, gateway({ type: 'approved' }))
  })
  await t.test('approved before the reveal', () => {
    refused(
      pairing,
      gateway({ type: 'unpaired' }),
      gateway({ type: 'approved' }),
    )
  })
  await t.test('a nonce before the commit', () => {
    assert.deepEqual(refused(pairing, gateway({ type: 'nonce', n: 'gn' })), [
      'fail',
    ])
  })
  await t.test('a second nonce', () => {
    refused(
      pairing,
      gateway({ type: 'unpaired' }),
      gateway({ type: 'nonce', n: 'a' }),
      gateway({ type: 'nonce', n: 'b' }),
    )
  })
  await t.test('a second unpaired', () => {
    refused(
      pairing,
      gateway({ type: 'unpaired' }),
      gateway({ type: 'unpaired' }),
    )
  })
})

test('relay off on the gateway (#785)', async (t) => {
  await t.test('a lasting ICE failure says direct only', () => {
    const r = run(
      init(),
      broker({ type: 'ready', iceServers: STUN, relayOff: true }),
      { on: 'connection', state: 'failed' },
      { on: 'graceOver' },
    )
    assert.equal(failure(r.fx)?.kind, 'direct-only')
  })
  await t.test('a forced relay fails at ready, direct only', () => {
    const r = run(
      init({ forceRelay: true }),
      broker({ type: 'ready', iceServers: STUN, relayOff: true }),
    )
    assert.deepEqual(kinds(r.fx), ['relayLine', 'fail'])
    assert.equal(failure(r.fx)?.kind, 'direct-only')
  })
})
