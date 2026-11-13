import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AppError,
  brokerClosed,
  brokerError,
  describe,
  httpError,
  toAppError,
  type Kind,
} from './errors.ts'

test('broker socket: closed before open is unreachable, after is a drop', () => {
  assert.equal(brokerClosed(false).kind, 'broker-unreachable')
  assert.equal(brokerClosed(true).kind, 'broker-lost')
})

test('broker error text', () => {
  assert.equal(
    brokerError('gateway offline or unknown').kind,
    'gateway-offline',
  )
  assert.equal(brokerError('something new').kind, 'unknown')
})

test('HTTP status → kind, by who answered', () => {
  const k = (via: 'api' | 'tunnel', s: number) => httpError(via, s, '/x').kind
  assert.equal(k('api', 401), 'unauthorized')
  assert.equal(k('api', 500), 'http')
  assert.equal(k('tunnel', 401), 'http')
  assert.equal(k('tunnel', 502), 'media-server-down')
  assert.equal(k('tunnel', 503), 'media-server-down')
  const e = httpError('tunnel', 404, '/streamiq/status')
  assert.equal(e.context.status, 404)
  assert.equal(e.message, '/streamiq/status → HTTP 404')
})

test('toAppError keeps AppErrors and wraps the rest as unknown', () => {
  const a = new AppError('not-paired', 'x')
  assert.equal(toAppError(a), a)
  assert.equal(toAppError(new Error('boom')).kind, 'unknown')
  assert.equal(toAppError(new Error('boom')).message, 'boom')
  assert.equal(toAppError('str').message, 'str')
})

test('every kind has a message', () => {
  const kinds: Kind[] = [
    'broker-unreachable',
    'broker-lost',
    'gateway-offline',
    'ice-failed',
    'not-paired',
    'pin-mismatch',
    'gateway-refused',
    'tunnel-lost',
    'invite-invalid',
    'media-server-down',
    'unauthorized',
    'http',
    'network',
    'playback',
    'unknown',
  ]
  for (const k of kinds) assert.ok(describe(new AppError(k, 'd')).message, k)
})
