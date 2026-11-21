import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  start,
  step,
  type Effect,
  type Event,
  type Init,
  type State,
} from './handshake.ts'

const FP = 'sha-256 AB:CD' // the normalized form of the SDP line below
const sdp = { type: 'answer', sdp: `v=0\r\na=fingerprint:sha-256 ab:cd\r\n` }
const TURN = [{ urls: 'turn:relay.example:3478' }]
const STUN = [{ urls: 'stun:stun.example:3478' }]

const init = (over: Partial<Init> = {}): State =>
  start({
    gatewayId: 'g1',
    pin: FP,
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

const answered = (over: Partial<Init> = {}) =>
  run(
    init(over),
    { on: 'open' },
    broker({ type: 'ready', iceServers: TURN }),
    broker({ type: 'answer', tunnel: 't1', sdp }),
  ).s

test('the happy path: auth, offer, answer, challenge, ok → resolve', () => {
  const { s, fx } = run(
    init(),
    { on: 'open' },
    broker({ type: 'ready', iceServers: TURN }),
    broker({ type: 'answer', tunnel: 't1', sdp }),
    gateway({ type: 'challenge', n: 'n1' }),
    gateway({ type: 'ok' }),
  )
  assert.deepEqual(kinds(fx), [
    'auth',
    'relayLine',
    'offer',
    'answer',
    'challenge',
    'resolve',
  ])
  assert.deepEqual(fx[4], { do: 'challenge', n: 'n1', fp: FP, pair: false })
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
    { do: 'answer', tunnel: undefined, sdp },
    { do: 'addIce', candidate: c1 },
    { do: 'addIce', candidate: c2 },
  ])
  assert.deepEqual(r.s.early, [])
})

test('a brief connection failed that recovers does not fail', () => {
  const r = run(
    answered(),
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
    answered(),
    { on: 'connection', state: 'failed' },
    { on: 'graceOver' },
  )
  assert.equal(failure(r.fx)?.kind, 'ice-failed')
})

test('a connection failed after connected fails at once (a lost tunnel)', () => {
  const r = run(
    answered(),
    { on: 'connection', state: 'connected' },
    gateway({ type: 'challenge', n: 'n1' }),
    gateway({ type: 'ok' }),
    { on: 'connection', state: 'failed' },
  )
  assert.equal(failure(r.fx)?.kind, 'ice-failed')
})

test('the broker socket closing', async (t) => {
  await t.test('during pairing: broker-lost', () => {
    const r = run(
      answered({ pin: undefined, pairing: true }),
      gateway({ type: 'challenge', n: 'n1' }),
      gateway({ type: 'unpaired' }),
      { on: 'close', reason: '' },
    )
    assert.deepEqual(kinds(r.fx), ['challenge', 'commit', 'fail'])
    assert.equal(failure(r.fx)?.kind, 'broker-lost')
  })
  await t.test('before it opened: broker-unreachable', () => {
    const r = run(init(), { on: 'close', reason: '' })
    assert.equal(failure(r.fx)?.kind, 'broker-unreachable')
  })
  await t.test('because the gateway went: gateway-offline', () => {
    const r = run(answered(), { on: 'close', reason: 'gateway gone' })
    assert.equal(failure(r.fx)?.kind, 'gateway-offline')
  })
})

test('ok for an unpinned certificate is refused', () => {
  const s = answered({ pin: undefined, pairing: true })
  const r = run(
    s,
    gateway({ type: 'challenge', n: 'n1' }),
    gateway({ type: 'ok' }),
  )
  assert.equal(r.fx[0].do === 'challenge' && r.fx[0].pair, true)
  assert.equal(failure(r.fx)?.kind, 'pin-mismatch')
})

test('a changed certificate outside pairing is refused before the answer is set', () => {
  const r = run(init({ pin: 'ff:ff' }), broker({ type: 'answer', sdp }))
  assert.deepEqual(kinds(r.fx), ['fail'])
  assert.equal(failure(r.fx)?.kind, 'pin-mismatch')
})

test('rejected', () => {
  const r = run(
    answered({ pairing: true }),
    gateway({ type: 'rejected', reason: 'denied on the gateway' }),
  )
  assert.equal(failure(r.fx)?.kind, 'gateway-refused')
  assert.equal(failure(r.fx)?.message, 'gateway refused: denied on the gateway')
})

test('pairing: commit, reveal, approved → pin and resolve', () => {
  const r = run(
    answered({ pin: undefined, pairing: true }),
    gateway({ type: 'unpaired' }),
    gateway({ type: 'nonce', n: 'gn' }),
    gateway({ type: 'approved' }),
  )
  assert.deepEqual(r.fx, [
    { do: 'commit' },
    { do: 'reveal', n: 'gn', fp: FP },
    { do: 'approved', fp: FP },
  ])
  assert.equal(r.s.phase, 'up')
})

test('unpaired without pairing: not-paired', () => {
  const r = run(answered(), gateway({ type: 'unpaired' }))
  assert.equal(failure(r.fx)?.kind, 'not-paired')
})

test('a challenge without a nonce is refused', () => {
  const r = run(answered(), gateway({ type: 'challenge' }))
  assert.equal(failure(r.fx)?.kind, 'gateway-refused')
})

test('the data channel closing', async (t) => {
  await t.test('after resolve: no reject', () => {
    const r = run(answered(), gateway({ type: 'ok' }), { on: 'channelClose' })
    assert.deepEqual(kinds(r.fx), ['resolve'])
  })
  await t.test('before resolve: gateway-refused', () => {
    const r = run(answered(), { on: 'channelClose' })
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
    answered(),
    { on: 'channelClose' },
    { on: 'close', reason: '' },
    gateway({ type: 'ok' }),
  )
  assert.deepEqual(kinds(r.fx), ['fail'])
})

test('a broker error and broken JSON fail', () => {
  assert.equal(
    failure(run(init(), broker({ type: 'error', error: 'gateway offline' })).fx)
      ?.kind,
    'gateway-offline',
  )
  assert.equal(
    failure(run(init(), { on: 'broker', data: '{' }).fx)?.kind,
    'unknown',
  )
})
