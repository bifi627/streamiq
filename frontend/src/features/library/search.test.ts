import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resultLine, searchTerm } from './search.ts'
import type { Item } from './items.ts'

test('searchTerm: trimmed, null under 2 characters', () => {
  assert.equal(searchTerm(undefined), null)
  assert.equal(searchTerm(' a '), null)
  assert.equal(searchTerm(' ab '), 'ab')
})

test('resultLine: an episode names its series, a movie its year', () => {
  const ep = {
    Id: '1',
    Name: 'Pilot',
    Type: 'Episode',
    SeriesName: 'Show',
    ParentIndexNumber: 1,
    IndexNumber: 2,
  } as Item
  assert.equal(resultLine(ep), 'Show · S1 · E2')
  assert.equal(resultLine({ ...ep, IndexNumber: undefined }), 'Show')
  const movie = {
    Id: '2',
    Name: 'M',
    Type: 'Movie',
    ProductionYear: 2001,
  } as Item
  assert.equal(resultLine(movie), '2001')
})
