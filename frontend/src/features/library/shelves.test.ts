import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../shared/errors.ts'
import { homeLists, homeView, shelf } from './shelves.ts'
import type { Item } from './items.ts'

const a = { Id: 'a' } as Item
const b = { Id: 'b' } as Item
const err = new AppError('gateway-offline', 'down')

test('shelf: items, error, or loading', () => {
  assert.deepEqual(shelf({ data: { Items: [a] }, error: null }), [a])
  assert.ok(shelf({ error: new Error('x') }) instanceof AppError)
  assert.equal(shelf({ error: null }), undefined)
})

test('homeLists waits for every cached row, and Resume unless warm', () => {
  const all = { favorites: [], recent: [], views: [] }
  assert.equal(homeLists({ ...all, favorites: undefined }, [], false), null)
  assert.equal(homeLists({ ...all, recent: undefined }, [], false), null)
  assert.equal(homeLists({ ...all, views: undefined }, [], false), null)
  assert.equal(homeLists(all, null, false), null)
  assert.deepEqual(homeLists({ ...all, recent: [a] }, null, true), {
    resume: [],
    favorites: [],
    recent: [a],
    views: [],
  })
})

test('homeView: spot, the rest, empty only without items and errors', () => {
  const none = { resume: [], favorites: [], recent: [], views: [] }
  const v = homeView({ ...none, resume: [a, b] })
  assert.equal(v.spot, a)
  assert.deepEqual(v.more, [b])
  assert.equal(v.empty, false)
  assert.equal(homeView(none).empty, true)
  assert.equal(homeView({ ...none, favorites: [a] }).empty, false)
  assert.equal(homeView({ ...none, resume: err }).empty, false)
})
