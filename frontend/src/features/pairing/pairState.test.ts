import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeLine, showPair, type State } from './pairState.ts'

const failed = (kind: string) =>
  ({ step: 'failed', err: { kind } }) as unknown as State

test('show pair: no usable pin, or a pairing run in progress', () => {
  const idle: State = { step: 'idle' }
  assert.equal(showPair(idle, true), false)
  assert.equal(showPair(idle, null), false) // pin not read yet
  assert.equal(showPair(idle, true, true), true) // caller knows the pin is bad
  assert.equal(showPair(idle, false), true)
  assert.equal(showPair(failed('not-paired'), true), true)
  assert.equal(showPair(failed('pin-mismatch'), true), true)
  assert.equal(showPair(failed('ice-failed'), true), false)
  assert.equal(showPair({ step: 'connecting', pair: true }, true), true)
  assert.equal(showPair({ step: 'connecting', pair: false }, true), false)
  assert.equal(showPair({ step: 'code', code: '123456' }, true), true)
})

test('route line', () => {
  assert.equal(routeLine(null), 'unknown')
  assert.equal(routeLine({ relay: false, ipv6: false }), 'direct')
  assert.equal(
    routeLine({ relay: true, ipv6: false, rttMs: 12 }),
    `relayed (TURN) · ${(12).toLocaleString()} ms round trip`,
  )
})
