// Run: node --test src/features/library/keys.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp, keyAction, SKIP, type KeyAt } from './keys.ts'

const at = (x: Partial<KeyAt>): KeyAt => ({
  back: false,
  key: '',
  page: null,
  inPopover: false,
  inBar: false,
  shown: false,
  seek: false,
  volume: false,
  lastRow: false,
  dock: false,
  ...x,
})
const k = (key: string, x: Partial<KeyAt> = {}) => keyAction(at({ key, ...x }))

test('Back: popover main closes, an options page goes up, then hide, then exit', () => {
  assert.deepEqual(keyAction(at({ back: true, page: 'main' })), { do: 'close' })
  assert.deepEqual(keyAction(at({ back: true, page: 'options' })), { do: 'up' })
  // the popover sits in the bar: its page wins over hiding the bar
  const bar = { back: true, inBar: true, shown: true, inPopover: true }
  assert.deepEqual(keyAction(at({ ...bar, page: 'main' })), { do: 'close' })
  assert.deepEqual(keyAction(at({ ...bar, page: 'options' })), { do: 'up' })
  assert.deepEqual(keyAction(at({ back: true, inBar: true })), { do: 'hide' })
  assert.deepEqual(keyAction(at({ back: true, shown: true })), { do: 'hide' })
  assert.deepEqual(keyAction(at({ back: true })), { do: 'exit' })
})

test('F, M, K work anywhere, even in the popover', () => {
  assert.deepEqual(k('f', { inPopover: true }), { do: 'fullscreen' })
  assert.deepEqual(k('m', { inBar: true }), { do: 'mute' })
  assert.deepEqual(k('k', { inPopover: true, inBar: true }), { do: 'toggle' })
  assert.deepEqual(k('k'), { do: 'toggle' })
})

test('popover: ↑/↓ move through options, ←/→ are swallowed, Enter is native', () => {
  const p = { inPopover: true, inBar: true, page: 'main' as const }
  assert.deepEqual(k('arrowup', p), { do: 'option', by: -1 })
  assert.deepEqual(k('arrowdown', p), { do: 'option', by: 1 })
  assert.deepEqual(k('arrowleft', p), { do: 'stay' })
  assert.deepEqual(k('arrowright', p), { do: 'stay' })
  assert.equal(k('enter', p), null)
})

test('outside the bar: ←/→ seek, Enter/Space play-pause, ↑/↓ focus Play', () => {
  assert.deepEqual(k('arrowleft'), { do: 'seek', by: -SKIP })
  assert.deepEqual(k('arrowright'), { do: 'seek', by: SKIP })
  assert.deepEqual(k('enter'), { do: 'toggle' })
  assert.deepEqual(k(' '), { do: 'toggle' })
  assert.deepEqual(k('arrowdown'), { do: 'focusPlay' })
  assert.deepEqual(k('arrowup', { shown: true }), { do: 'focusPlay' })
  assert.equal(k('a'), null)
})

test('in the bar: ←/→ move in the row, or seek on the seek bar', () => {
  assert.deepEqual(k('arrowleft', { inBar: true }), { do: 'item', by: -1 })
  assert.deepEqual(k('arrowright', { inBar: true, seek: true }), {
    do: 'seek',
    by: SKIP,
  })
  assert.equal(k('enter', { inBar: true }), null) // activates the button
})

test('in the bar: ↑/↓ switch rows, change volume, or go down to the dock', () => {
  assert.deepEqual(k('arrowup', { inBar: true }), { do: 'row', by: -1 })
  assert.deepEqual(k('arrowup', { inBar: true, volume: true }), {
    do: 'volume',
    by: 0.1,
  })
  assert.deepEqual(k('arrowdown', { inBar: true, volume: true }), {
    do: 'volume',
    by: -0.1,
  })
  const last = { inBar: true, lastRow: true }
  assert.deepEqual(k('arrowdown', { ...last, dock: true }), { do: 'dock' })
  assert.deepEqual(k('arrowdown', last), { do: 'row', by: 1 }) // no dock: wraps
  assert.deepEqual(k('arrowup', { ...last, dock: true }), { do: 'row', by: -1 })
})

test('clamp keeps an index inside the list', () => {
  assert.equal(clamp(-1, 3), 0)
  assert.equal(clamp(1, 3), 1)
  assert.equal(clamp(3, 3), 2)
})
