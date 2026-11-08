// Run: node --test src/features/library/items.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, covers, rangeHeader } from './items.ts'

test('hls.js exclusive range end → inclusive HTTP Range', () => {
  assert.equal(rangeHeader(), undefined)
  assert.equal(rangeHeader(0, 100), 'bytes=0-99')
  assert.equal(rangeHeader(500), 'bytes=500-')
  assert.equal(rangeHeader(undefined, 10), 'bytes=0-9')
})

test('clock formats seconds as m:ss', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(65.9), '1:05')
})

test('covers: video buffered at the playhead (1 s slack)', () => {
  const r = (...p: [number, number][]) => ({
    length: p.length,
    start: (i: number) => p[i][0],
    end: (i: number) => p[i][1],
  })
  assert.equal(covers(undefined, 5), false)
  assert.equal(covers(r(), 5), false) // the webOS stuck state: "video none"
  assert.equal(covers(r([0, 12]), 5), true)
  assert.equal(covers(r([300.4, 312]), 300), true) // first frame just after
  assert.equal(covers(r([0, 12], [300, 312]), 150), false) // seeked into a gap
})
