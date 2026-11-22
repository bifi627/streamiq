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

test('homeLists waits for both rows, and Resume unless warm', () => {
  assert.equal(homeLists(undefined, [], [], false), null)
  assert.equal(homeLists([], undefined, [], false), null)
  assert.equal(homeLists([], [], null, false), null)
  assert.deepEqual(homeLists([a], [], null, true), {
    resume: [],
    recent: [a],
    views: [],
  })
})

test('homeView: spot, the rest, empty only without items and errors', () => {
  const v = homeView({ resume: [a, b], recent: [], views: [] })
  assert.equal(v.spot, a)
  assert.deepEqual(v.more, [b])
  assert.equal(v.empty, false)
  assert.equal(homeView({ resume: [], recent: [], views: [] }).empty, true)
  assert.equal(homeView({ resume: err, recent: [], views: [] }).empty, false)
})
