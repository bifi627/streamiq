import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgeNames, connPart, isRoute, routeOf } from './connection.ts'

test('routeOf: relayed wins, then on your network, else direct', () => {
  assert.equal(routeOf(true, true), 'relay')
  assert.equal(routeOf(false, true), 'lan')
  assert.equal(routeOf(false, false), 'direct')
})

test('connPart: only an online gateway, checking until answered', () => {
  assert.equal(connPart('offline', { route: 'lan' }), null)
  assert.equal(connPart('loading'), null)
  assert.equal(connPart('failed'), null)
  assert.equal(connPart('online'), 'checking')
  assert.equal(connPart('online', { route: 'relay', mb: 2 }), 'relay')
  assert.equal(connPart('online', { route: 'failed' }), 'failed')
  assert.equal(connPart('online', { route: 'unpaired' }), 'unpaired')
  assert.equal(connPart('online', { route: 'reconnecting' }), 'reconnecting')
})

test('isRoute: a connection type, not a state', () => {
  for (const p of ['lan', 'direct', 'relay'] as const) assert.ok(isRoute(p))
  for (const p of ['checking', 'failed', 'unpaired', null] as const)
    assert.ok(!isRoute(p))
})

test('badgeNames: names only what tells things apart, the heading always', () => {
  assert.deepEqual(badgeNames('NAS', 1, 'Home', 1), {
    name: null,
    initial: null,
    heading: 'NAS in Home',
  })
  assert.equal(badgeNames('NAS', 2, 'Home', 1).name, 'NAS')
  assert.equal(badgeNames('NAS', 1, 'familie', 2).initial, 'F')
  assert.equal(badgeNames('NAS', 1, 'Household …a1b2c3', 3).initial, 'H')
  assert.equal(badgeNames('NAS', 1, '😀 Club', 2).initial, '😀') // not half a surrogate pair
  assert.equal(badgeNames('NAS', 1, '', 0).heading, 'NAS')
})
