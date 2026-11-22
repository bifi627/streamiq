// Run: node --test src/features/player/bar.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seekTarget, storedVolume, summary, tap } from './bar.ts'

test('stored volume: 50 % when unset, invalid or 0; muted only on "1"', () => {
  assert.deepEqual(storedVolume(null, null), { volume: 0.5, muted: false })
  assert.deepEqual(storedVolume('0.3', '1'), { volume: 0.3, muted: true })
  assert.deepEqual(storedVolume('0', '1'), { volume: 0.5, muted: true })
  assert.deepEqual(storedVolume('2', '0'), { volume: 0.5, muted: false })
  assert.deepEqual(storedVolume('x', null), { volume: 0.5, muted: false })
  assert.deepEqual(storedVolume('1', null), { volume: 1, muted: false })
})

test('seek target stays inside [0, duration]', () => {
  assert.equal(seekTarget(5, -10, 100), 0)
  assert.equal(seekTarget(95, 10, 100), 100)
  assert.equal(seekTarget(50, 10, 100), 60)
  assert.equal(seekTarget(50, 10, 0), 0) // no duration yet
})

test('a touch on the picture toggles the bar; anything else shows it', () => {
  assert.equal(tap(false, true, true), 'hide')
  assert.equal(tap(false, true, false), 'poke')
  assert.equal(tap(false, false, true), 'poke') // touch on the bar
  assert.equal(tap(true, true, true), 'poke') // mouse
})

test('a setting row names the current option and what is in effect', () => {
  const s = {
    value: 'Auto',
    options: [
      { value: 'Auto', label: 'Auto' },
      { value: '720p', label: '720p' },
    ],
  }
  assert.equal(summary(s), 'Auto ›')
  assert.equal(summary({ ...s, status: 'Original 4K' }), 'Auto · Original 4K ›')
})
