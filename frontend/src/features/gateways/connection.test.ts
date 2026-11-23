import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connPart, routeOf } from './connection.ts'

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
})
