// Run: node --test src/features/screen/remote.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampSeek, playOnOptions, playingScreens, polled } from './remote.ts'
import type { Screen } from '../gateways/api.ts'

test('clampSeek keeps a seek in 0 … duration', () => {
  assert.equal(clampSeek(-5, 100), 0)
  assert.equal(clampSeek(40, 100), 40)
  assert.equal(clampSeek(120, 100), 100)
})

test('clampSeek has no upper bound while the duration is unknown', () => {
  assert.equal(clampSeek(500, 0), 500)
  assert.equal(clampSeek(-5, 0), 0)
})

const tv = { id: 's1', name: 'TV', state: null }

test('screen found: shown, keep polling', () => {
  assert.deepEqual(polled('s1', [{ ...tv, id: 's0' }, tv], ''), {
    screen: tv,
    again: true,
    recovered: false,
  })
})

test('screen gone: closed, stop polling', () => {
  assert.deepEqual(polled('s1', [], ''), {
    screen: null,
    again: false,
    recovered: false,
  })
})

test('no answer yet: nothing to show, keep polling', () => {
  const p = polled('s1', undefined, 'Gateway offline')
  assert.equal(p.screen, undefined)
  assert.equal(p.again, true)
})

test('error: the screen of the last answer stays, keep polling', () => {
  const p = polled('s1', [tv], 'Gateway offline')
  assert.equal(p.screen, tv)
  assert.equal(p.again, true)
})

test('the first good poll after an error: recovered (#553)', () => {
  assert.equal(polled('s1', [tv], '', 'Gateway offline').recovered, true)
  assert.equal(polled('s1', [tv], '', '').recovered, false)
  assert.equal(polled('s1', [tv], 'x', 'Gateway offline').recovered, false)
})

test('playOnOptions: every screen plays; a playing one also offers its remote', () => {
  const busy = { id: 's2', name: 'Bedroom', state: { itemId: 'i1' } }
  const labels = playOnOptions([tv, busy] as Screen[]).map((o) => o.label)
  assert.deepEqual(labels, ['TV', 'Bedroom', 'Remote: Bedroom'])
})

test('playingScreens: only the screens with an item', () => {
  const busy = { id: 's2', name: 'Bedroom', state: { itemId: 'i1' } }
  const idle = { id: 's3', name: 'Den', state: { itemId: '' } }
  assert.deepEqual(playingScreens([tv, busy, idle] as Screen[]), [busy])
})
