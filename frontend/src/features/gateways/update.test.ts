import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updated } from './update.ts'

test('a remote update is done once online on another version (#312)', () => {
  const u = { to: '1.5.0', from: '1.4.0' }
  assert.equal(updated(u, { online: false, version: '1.4.0' }), false) // going down
  assert.equal(updated(u, { online: true, version: '1.4.0' }), false) // not swapped (yet)
  assert.equal(updated(u, { online: false, version: '1.5.0' }), false) // offline on the new one
  assert.equal(updated(u, { online: true, version: '1.5.0' }), true)
  assert.equal(updated(u, { online: true, version: '1.6.0' }), true) // a newer release than named
})
