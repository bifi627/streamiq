import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STALL_EVENTS, stalls } from './stall.ts'

test('the spinner: on when waiting, off on every other event it listens to', () => {
  assert.equal(stalls('waiting'), true)
  for (const e of STALL_EVENTS.filter((e) => e !== 'waiting'))
    assert.equal(stalls(e), false, e)
  // Each one ends a wait; a paused seek never fires `playing`: seeked does.
  assert.deepEqual([...STALL_EVENTS].sort(), [
    'canplay',
    'ended',
    'error',
    'pause',
    'playing',
    'seeked',
    'waiting',
  ])
})
