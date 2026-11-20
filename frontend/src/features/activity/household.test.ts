import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byMember, memberLabel, shownTunnels } from './household.ts'
import type { TunnelRow } from './tunnels.ts'

test('member names: listed, former member, deleted account, loading', () => {
  const names = new Map([['u1', 'Alice']])
  assert.equal(memberLabel('u1', names), 'Alice')
  assert.equal(memberLabel('u2', names), 'Former member')
  assert.equal(memberLabel(null, names), 'Deleted account')
  assert.equal(memberLabel(undefined, names), 'Deleted account')
  assert.equal(memberLabel('u1', undefined), '…')
})

test('the summary count drops the hidden tunnels unless the box is ticked', () => {
  const s = { userId: 'u1', tunnels: 7, hidden: 3, failed: 1, relayedBytes: 0 }
  assert.equal(shownTunnels(s, false), 4)
  assert.equal(shownTunnels(s, true), 7)
})

test('the member filter: one user, or everyone', () => {
  const rows = [{ userId: 'u1' }, { userId: 'u2' }, {}] as TunnelRow[]
  assert.equal(byMember(rows, '').length, 3)
  assert.deepEqual(byMember(rows, 'u2'), [rows[1]])
})
