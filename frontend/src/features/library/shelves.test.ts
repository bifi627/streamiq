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

test('homeLists waits for every cached row, and Resume + Next up unless warm', () => {
  const all = { favorites: [], recent: [], views: [] }
  const live = { resume: [], next: [] }
  assert.equal(homeLists({ ...all, favorites: undefined }, live, false), null)
  assert.equal(homeLists({ ...all, recent: undefined }, live, false), null)
  assert.equal(homeLists({ ...all, views: undefined }, live, false), null)
  assert.equal(homeLists(all, { ...live, resume: null }, false), null)
  assert.equal(homeLists(all, { ...live, next: null }, false), null)
  assert.ok(homeLists(all, live, false))
  const none = { resume: null, next: null }
  assert.deepEqual(homeLists({ ...all, recent: [a] }, none, true), {
    resume: [],
    next: [],
    favorites: [],
    recent: [a],
    views: [],
  })
})

test('homeView: spot, the rest, empty only without items and errors', () => {
  const none = { resume: [], next: [], favorites: [], recent: [], views: [] }
  const v = homeView({ ...none, resume: [a, b] })
  assert.equal(v.spot, a)
  assert.deepEqual(v.more, [b])
  assert.equal(v.empty, false)
  assert.equal(homeView(none).empty, true)
  assert.equal(homeView({ ...none, favorites: [a] }).empty, false)
  assert.equal(homeView({ ...none, resume: err }).empty, false)
  assert.equal(homeView({ ...none, next: [a] }).empty, false)
})

test('homeView: first focus goes to the top row with items', () => {
  const none = { resume: [], next: [], favorites: [], recent: [], views: [] }
  assert.equal(homeView(none).first, undefined)
  assert.equal(homeView({ ...none, views: [a], recent: [b] }).first, 'recent')
  assert.equal(homeView({ ...none, favorites: [a], next: [b] }).first, 'next')
  assert.equal(homeView({ ...none, next: [a], resume: [b] }).first, 'resume')
  // Warm: Resume and Next up answer late, focus stays on the cached rows.
  const late = { ...none, resume: [a], next: [b], recent: [a] }
  assert.equal(homeView(late, true).first, 'recent')
  assert.equal(homeView({ ...none, next: [a] }, true).first, undefined)
  assert.equal(homeView({ ...none, next: [a] }, true).empty, false)
})

test('homeView: a failed Next up is its own error, the other rows stay', () => {
  const v = homeView({
    resume: [a],
    next: err,
    favorites: [b],
    recent: [],
    views: [],
  })
  assert.equal(v.spot, a)
  assert.equal(v.first, 'resume')
  assert.equal(v.empty, false)
  const only = { resume: [], favorites: [], recent: [], views: [] }
  assert.equal(homeView({ ...only, next: err }).empty, false)
})
