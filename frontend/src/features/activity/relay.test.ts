import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relayLabel } from './relay.ts'

test('relay usage rows: the name, unnamed, or removed', () => {
  const u = {
    gatewayId: 'g',
    name: 'nas',
    removed: false,
    thisMonth: 1,
    lastMonth: 0,
  }
  assert.equal(relayLabel(u), 'nas')
  assert.equal(relayLabel({ ...u, name: null }), 'Unnamed gateway')
  assert.equal(relayLabel({ ...u, removed: true }), 'Removed gateway')
})
