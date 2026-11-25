import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STALL_EVENTS, stalls } from './stall.ts'

test('the spinner: on when waiting, off on every other event it listens to', () => {
  assert.equal(stalls('waiting'), true)
  for (const e of STALL_EVENTS.filter((e) => e !== 'waiting'))
    assert.equal(stalls(e), false, e)
  // A paused seek never fires `playing`: seeked ends it.
  assert.ok(STALL_EVENTS.includes('seeked'))
})
