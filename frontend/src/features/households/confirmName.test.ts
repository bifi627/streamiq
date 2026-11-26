import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmed, confirmName } from './confirmName.ts'

const named = { id: '0190aaaa-bbbb-7ccc-8ddd-eeeeee1a2b3c', name: 'The Smiths' }
const unnamed = { ...named, name: null }

test('a named household is confirmed by its name, trimmed', () => {
  assert.equal(confirmName(named), 'The Smiths')
  assert.ok(confirmed('  The Smiths ', named))
  assert.ok(!confirmed('the smiths', named))
  assert.ok(!confirmed('', named))
})

test('an unnamed household is confirmed by the id tag its label shows', () => {
  assert.equal(confirmName(unnamed), '1a2b3c')
  assert.ok(confirmed('1a2b3c', unnamed))
  assert.ok(!confirmed('Household …1a2b3c', unnamed))
})
