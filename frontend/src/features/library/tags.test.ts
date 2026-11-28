import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addTag,
  customTags,
  itemTagsUrl,
  removeTag,
  suggestions,
  type Tag,
} from './tags.ts'

const all: Tag[] = [
  { name: 'Cozy', itemIds: ['b'] },
  { name: 'funny', itemIds: ['a', 'b'] },
]

test('customTags: the item’s tags by name', () => {
  assert.deepEqual(customTags(all, 'a'), ['funny'])
  assert.deepEqual(customTags(all, 'b'), ['Cozy', 'funny'])
  assert.deepEqual(customTags(all, 'c'), [])
})

test('customTags: a gateway too old to keep tags (404) shows no chips, not an error', () => {
  // useTunnelQuery's 404 (an old gateway) or still loading: no data
  assert.equal(customTags(undefined, 'a'), null)
})

test('suggestions: the gateway’s tags the item lacks, case-insensitively', () => {
  assert.deepEqual(suggestions(all, ['FUNNY']), ['Cozy'])
})

test('addTag: trimmed, an existing spelling wins, a duplicate or blank changes nothing', () => {
  assert.deepEqual(addTag([], '  cozy ', ['Cozy']), { tags: ['Cozy'] })
  assert.deepEqual(addTag(['x'], ' new ', []), { tags: ['x', 'new'] })
  assert.deepEqual(addTag(['Funny'], 'funny', []), { tags: ['Funny'] })
  assert.deepEqual(addTag(['x'], '   ', []), { tags: ['x'] })
})

test('addTag: the gateway’s limits say why', () => {
  assert.ok('error' in addTag([], 'x'.repeat(33), []))
  assert.deepEqual(addTag([], 'é'.repeat(32), []), { tags: ['é'.repeat(32)] })
  const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`)
  assert.ok('error' in addTag(twenty, 'one more', []))
})

test('removeTag and the PUT URL', () => {
  assert.deepEqual(removeTag(['a', 'b'], 'a'), ['b'])
  assert.equal(itemTagsUrl('a b'), '/streamiq/tags/a%20b')
})
