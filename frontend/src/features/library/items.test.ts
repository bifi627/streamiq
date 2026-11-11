// Run: node --test src/features/library/items.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audioTracks, clock, covers, rangeHeader } from './items.ts'

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

test('audioTracks: audio streams only, language + title, codec + layout', () => {
  const name = (c: string) =>
    new Intl.DisplayNames(undefined, { type: 'language' }).of(c)
  assert.deepEqual(
    audioTracks([
      { Index: 0, Type: 'Video', Codec: 'h264' },
      { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng' },
      {
        Index: 2,
        Type: 'Audio',
        Codec: 'aac',
        Channels: 2,
        Language: 'deu',
        Title: 'Commentary',
      },
      { Index: 3, Type: 'Audio', Codec: 'aac', Channels: 1, Language: 'und' },
      { Index: 4, Type: 'Subtitle', Language: 'eng' },
    ]),
    [
      { value: '1', label: name('eng'), hint: 'AC3 5.1' },
      { value: '2', label: `${name('deu')} · Commentary`, hint: 'AAC stereo' },
      { value: '3', label: 'Track 3', hint: 'AAC mono' },
    ],
  )
  assert.deepEqual(audioTracks(), [])
})
