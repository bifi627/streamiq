import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guestNotice } from './guest.ts'

test('guest banner only while the session plays as the shared viewer', () => {
  assert.equal(guestNotice(null, false), null)
  assert.equal(guestNotice({}, true), null) // older gateway
  assert.equal(guestNotice({ viewer: { shared: false } }, false), null)
  const member = guestNotice(
    { viewer: { shared: true, reason: 'nope' } },
    false,
  )
  assert.match(member!, /guest mode.*\(nope\)|\(nope\).*guest mode/)
  assert.match(member!, /Ask a household admin/)
  assert.doesNotMatch(member!, /local page/)
  assert.match(guestNotice({ viewer: { shared: true } }, true)!, /local page/)
})
