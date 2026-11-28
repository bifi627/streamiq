import { test } from 'node:test'
import assert from 'node:assert/strict'
import { favorable, flipFavorite } from './heart.ts'
import type { Item } from './items.ts'

test('flipFavorite: shows the new value at once and keeps it once saved', async () => {
  const shown: boolean[] = []
  const saved: boolean[] = []
  const msg = await flipFavorite(
    false,
    (on) => shown.push(on),
    async (on) => saved.push(on),
  )
  assert.equal(msg, '')
  assert.deepEqual(shown, [true])
  assert.deepEqual(saved, [true])
})

test('flipFavorite: a failed save puts the old value back with its message', async () => {
  const shown: boolean[] = []
  const msg = await flipFavorite(
    true,
    (on) => shown.push(on),
    () => Promise.reject(new Error('boom')),
  )
  assert.deepEqual(shown, [false, true])
  assert.ok(msg.length > 0)
})

test('favorable: movies, series and photos only', () => {
  const t = (Type: string) => favorable({ Id: 'x', Name: 'x', Type } as Item)
  assert.equal(t('Movie'), true)
  assert.equal(t('Series'), true)
  assert.equal(t('Photo'), true)
  assert.equal(t('Episode'), false)
  assert.equal(t('Folder'), false)
})
