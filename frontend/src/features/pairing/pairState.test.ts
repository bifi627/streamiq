import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinUnusable, routeLine, showPair, type State } from './pairState.ts'
import type { AppError } from '../../shared/errors.ts'

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
  assert.equal(
    showPair({ step: 'code', code: '123456', matched: false }, true),
    true,
  )
})

const path = { relay: false, ipv6: false, bytesReceived: 0, bytesSent: 0 }

test('route line', () => {
  assert.equal(routeLine(null), 'unknown')
  assert.equal(routeLine({ ...path, relay: false }), 'direct')
  assert.equal(
    routeLine({ ...path, relay: true, rttMs: 12 }),
    `relayed (TURN) · ${(12).toLocaleString()} ms round trip`,
  )
})

test('pinUnusable: only a refused pin', () => {
  const e = (kind: string) => ({ kind }) as unknown as AppError
  assert.equal(pinUnusable(e('not-paired')), true)
  assert.equal(pinUnusable(e('pin-mismatch')), true)
  assert.equal(pinUnusable(e('gateway-offline')), false)
})
