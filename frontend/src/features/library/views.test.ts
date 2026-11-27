import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpError } from '../../shared/errors.ts'
import type { Item } from './items.ts'
import { entries, idChunks, viewLine, viewsMessage } from './views.ts'

const at = '2026-11-27T13:00:00Z'
const v = (itemId: string) => ({ itemId, at })

test('each view is an entry; a rewatch fetches its item once', () => {
  const views = [v('a'), v('b'), v('a')]
  assert.deepEqual(idChunks(views), [['a', 'b']])
  assert.deepEqual(idChunks([v('a'), v('b'), v('c')], 2), [['a', 'b'], ['c']])
  const a = { Id: 'a', Name: 'A' } as Item
  assert.deepEqual(
    entries(views, [a]).map((e) => e.item),
    [a, undefined, a],
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
  assert.equal(viewLine(undefined, at), when)
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
