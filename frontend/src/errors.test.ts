import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AppError,
  brokerClosed,
  brokerError,
  describe,
  httpError,
  isKind,
  renameMessage,
  toAppError,
  type Kind,
} from './errors.ts'

test('broker socket: closed before open is unreachable, after is a drop', () => {
  assert.equal(brokerClosed(false).kind, 'broker-unreachable')
  assert.equal(brokerClosed(true).kind, 'broker-lost')
  assert.equal(brokerClosed(true, {}, 'gateway gone').kind, 'gateway-offline')
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
  assert.equal(k('api', 403), 'admin-only')
  assert.equal(k('api', 500), 'http')
  assert.equal(k('tunnel', 403), 'http') // a refused Jellyfin path, not a role
  assert.equal(k('tunnel', 401), 'http')
  assert.equal(k('tunnel', 502), 'media-server-down')
  assert.equal(k('tunnel', 503), 'media-server-down')
  assert.equal(k('tunnel', 404), 'http')
  assert.equal(k('tunnel', 500), 'http') // the gateway's own failure
  assert.equal(k('api', 502), 'http') // only the gateway's 502 means Jellyfin
  const e = httpError('tunnel', 404, '/streamiq/status')
  assert.equal(e.context.status, 404)
  assert.equal(e.message, '/streamiq/status → HTTP 404')
})

test('rename form: a gateway 500 names the gateway, never the media server', () => {
  const m = (s: number) =>
    renameMessage(httpError('tunnel', s, '/streamiq/name'))
  assert.equal(m(500), "The gateway couldn't save the name; see its log.")
  assert.equal(m(404), 'This gateway is too old to rename: update it.')
  assert.equal(m(400), 'Use 1–100 characters, no control characters.')
  assert.equal(m(403), 'Request failed.')
})

test('toAppError keeps AppErrors and wraps the rest as unknown', () => {
  const a = new AppError('not-paired', 'x')
  assert.equal(toAppError(a), a)
  assert.equal(toAppError(new Error('boom')).kind, 'unknown')
  assert.equal(toAppError(new Error('boom')).message, 'boom')
  assert.equal(toAppError('str').message, 'str')
})

test('isKind: only an AppError of that kind', () => {
  assert.equal(isKind(new AppError('not-paired', 'x'), 'not-paired'), true)
  assert.equal(isKind(new AppError('http', 'x'), 'not-paired'), false)
  assert.equal(isKind(new Error('not-paired'), 'not-paired'), false)
  assert.equal(isKind(undefined, 'not-paired'), false)
})

test('every kind: a message and the buttons it shows', () => {
  const actions: Record<Kind, string[]> = {
    'broker-unreachable': ['retry'],
    'broker-lost': ['retry'],
    'gateway-offline': ['retry', 'gateways'],
    'ice-failed': ['retry'],
    'not-paired': ['pair'],
    'pin-mismatch': ['pair'],
    'gateway-refused': ['gateways'],
    'tunnel-lost': ['retry'],
    'invite-invalid': ['gateways'],
    'last-admin': [],
    'admin-only': [], // retry can't help a 403 (#211)
    'media-server-down': ['retry'],
    unauthorized: ['sign-in'],
    http: ['retry'],
    network: ['retry'],
    playback: [],
    unknown: ['retry'],
  }
  for (const [k, a] of Object.entries(actions) as [Kind, string[]][]) {
    const d = describe(new AppError(k, 'd'))
    assert.ok(d.message, k)
    assert.deepEqual(d.actions, a, k)
    // Only a possibly impersonated gateway is loud.
    assert.equal(d.loud, k === 'pin-mismatch' || undefined, k)
  }
  // playback: the player's own wording
  assert.equal(describe(new AppError('playback', 'decode')).message, 'decode')
})
