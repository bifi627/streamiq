import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldText, qSearch, resultLine, searchTerm } from './search.ts'
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
  assert.equal(resultLine(ep), 'Show · Season 1')
  assert.equal(resultLine({ ...ep, ParentIndexNumber: undefined }), 'Show')
  const movie = {
    Id: '2',
    Name: 'M',
    Type: 'Movie',
    ProductionYear: 2001,
  } as Item
  assert.equal(resultLine(movie), '2001')
})

test('fieldText: its own push keeps a letter typed meanwhile, an outside change wins', () => {
  assert.equal(fieldText('abc', 'ab', 'ab'), 'abc') // pushed "ab", "c" typed before q arrived
  assert.equal(fieldText('ab', '', 'ab'), '') // the nav's Library link cleared it
  assert.equal(fieldText('xy', 'old', 'xy'), 'old') // Back to an older term
})

test('qSearch: empty text drops q', () => {
  assert.deepEqual(qSearch(''), {})
  assert.deepEqual(qSearch('ab'), { q: 'ab' })
})
