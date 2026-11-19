import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ICE_FAILED_GRACE_MS, lastingFailure } from './iceFailed.ts'

test('a failed that recovers within the grace period does not fail', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const onFail = mock.fn()
  const feed = lastingFailure(onFail)
  feed('connecting')
  feed('failed')
  t.mock.timers.tick(30)
  feed('connecting') // the gateway's srflx candidate arrived
  feed('failed')
  t.mock.timers.tick(ICE_FAILED_GRACE_MS - 1)
  feed('connected')
  t.mock.timers.tick(ICE_FAILED_GRACE_MS * 2)
  assert.equal(onFail.mock.callCount(), 0)
})

test('a failed that lasts the grace period fails once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const onFail = mock.fn()
  const feed = lastingFailure(onFail)
  feed('failed')
  t.mock.timers.tick(ICE_FAILED_GRACE_MS - 1)
  feed('failed') // a repeat doesn't restart the clock
  assert.equal(onFail.mock.callCount(), 0)
  t.mock.timers.tick(1)
  assert.equal(onFail.mock.callCount(), 1)
})
