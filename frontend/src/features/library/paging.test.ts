import { test } from 'node:test'
import assert from 'node:assert/strict'
import { children } from './jellyfin.ts'
import { folderView, nextStart, PAGE, type Page } from './paging.ts'
import type { Item } from './items.ts'

const items = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => ({ Id: `i${from + k}` }) as Item)
const page = (from: number, n: number, total: number): Page => ({
  Items: items(from, n),
  TotalRecordCount: total,
})

test('children asks for one page at a time', () => {
  assert.equal(
    children('f', 100),
    '/Items?parentId=f&sortBy=SortName&startIndex=100&limit=50',
  )
})

test('nextStart: after each full page until the total, none after the last', () => {
  assert.equal(nextStart([]), undefined)
  assert.equal(nextStart([page(0, PAGE, 120)]), 50)
  assert.equal(nextStart([page(0, PAGE, 120), page(50, PAGE, 120)]), 100)
  assert.equal(
    nextStart([page(0, PAGE, 120), page(50, PAGE, 120), page(100, 20, 120)]),
    undefined,
  )
  assert.equal(nextStart([page(0, PAGE, 100), page(50, PAGE, 100)]), undefined)
  assert.equal(nextStart([page(0, 7, 7)]), undefined)
})

test('nextStart: without a total, a short page is the last', () => {
  assert.equal(nextStart([{ Items: items(0, PAGE) }]), 50)
  assert.equal(nextStart([{ Items: items(0, 3) }]), undefined)
})

test('folderView: loading, then every item once in order', () => {
  assert.equal(
    folderView({ pages: undefined, hasNext: false, nextFailed: false }),
    undefined,
  )
  const v = folderView({
    pages: [page(0, PAGE, 120), page(49, PAGE, 120)], // the folder shifted by one
    hasNext: true,
    nextFailed: false,
  })
  assert.deepEqual(
    v?.items.map((i) => i.Id),
    items(0, 99).map((i) => i.Id),
  )
  assert.equal(v?.tail, 'more')
})

test('folderView: a failed later page keeps the items and offers Retry', () => {
  const v = folderView({
    pages: [page(0, PAGE, 120)],
    hasNext: true,
    nextFailed: true,
  })
  assert.equal(v?.items.length, PAGE)
  assert.equal(v?.tail, 'retry')
  assert.equal(
    folderView({ pages: [page(0, 7, 7)], hasNext: false, nextFailed: false })
      ?.tail,
    'end',
  )
})
