import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpError } from '../../shared/errors.ts'
import type { Item } from './items.ts'
import {
  entries,
  idChunks,
  itemViews,
  viewCount,
  viewLine,
  viewsMessage,
} from './views.ts'

const at = '2026-11-27T13:00:00Z'
const v = (itemId: string) => ({ itemId, at })

test('each view is an entry, a removed item none; a rewatch fetches its item once', () => {
  const views = [v('a'), v('b'), v('a')]
  assert.deepEqual(idChunks(views), [['a', 'b']])
  assert.deepEqual(idChunks([v('a'), v('b'), v('c')], 2), [['a', 'b'], ['c']])
  const a = { Id: 'a', Name: 'A' } as Item
  assert.deepEqual(
    entries(views, [a]).map((e) => e.item),
    [a, a],
  )
})

test('an episode leads with its series and S·E', () => {
  const when = new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const ep = {
    Id: 'e',
    Name: 'Pilot',
    Type: 'Episode',
    SeriesName: 'Show',
    ParentIndexNumber: 1,
    IndexNumber: 2,
  } as Item
  assert.equal(viewLine(ep, at), `Show · S1E2 · ${when}`)
  assert.equal(
    viewLine({ Id: 'm', Name: 'M', Type: 'Movie' } as Item, at),
    when,
  )
})

test('a gateway without the watch history says to update it', () => {
  assert.match(
    viewsMessage(httpError('tunnel', 404, '/streamiq/views')),
    /too old to keep a watch history/,
  )
  assert.doesNotMatch(
    viewsMessage(httpError('tunnel', 500, '/streamiq/views')),
    /too old/,
  )
})

test("the view count: only this item's views, nothing at none or without an answer", () => {
  assert.equal(itemViews('a b'), '/streamiq/views?itemId=a%20b')
  assert.equal(viewCount(undefined, 'a'), '')
  assert.equal(viewCount([v('b')], 'a'), '')
  assert.equal(viewCount([v('a'), v('b')], 'a'), 'Watched once')
  assert.equal(
    viewCount([v('a'), v('b'), v('a'), v('a')], 'a'),
    'Watched 3 times',
  )
  assert.equal(
    viewCount(Array(1200).fill(v('a')), 'a'),
    `Watched ${(1200).toLocaleString()} times`,
  )
})
