// Run: node --test src/features/library/items.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  audioTracks,
  clock,
  covers,
  folderUp,
  inProgress,
  pageItem,
  playable,
  playsAtOnce,
  progress,
  rangeHeader,
  runtime,
  subtitleTracks,
  TICKS_PER_SECOND,
  upNext,
  type Item,
} from './items.ts'

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

test('subtitleTracks: Off + text subtitles only', () => {
  const en = new Intl.DisplayNames(undefined, { type: 'language' }).of('eng')
  assert.deepEqual(
    subtitleTracks([
      { Index: 1, Type: 'Audio', Codec: 'aac', IsTextSubtitleStream: true }, // the flag alone isn't enough
      { Index: 2, Type: 'Subtitle', Codec: 'pgssub' }, // image: burn-in only
      {
        Index: 3,
        Type: 'Subtitle',
        Codec: 'subrip',
        Language: 'eng',
        IsTextSubtitleStream: true,
      },
      { Index: 4, Type: 'Subtitle', IsTextSubtitleStream: true },
    ]),
    [
      { value: '-1', label: 'Off' },
      { value: '3', label: en, hint: 'SRT' },
      { value: '4', label: 'Track 2', hint: '' },
    ],
  )
  assert.deepEqual(subtitleTracks(), [{ value: '-1', label: 'Off' }])
})

test('upNext: in progress, else first unwatched (specials last), else first', () => {
  const ep = (Id: string, season: number, ud?: Item['UserData']) =>
    ({
      Id,
      Name: Id,
      Type: 'Episode',
      ParentIndexNumber: season,
      UserData: ud,
    }) as Item
  const sp = ep('sp', 0)
  const a = ep('a', 1, { Played: true })
  const b = ep('b', 1)
  const c = ep('c', 2, { PlaybackPositionTicks: 5 })
  assert.equal(upNext([sp, a, b, c]).Id, 'c')
  assert.equal(upNext([sp, a, b]).Id, 'b')
  assert.equal(upNext([sp, a]).Id, 'sp')
  assert.equal(upNext([a]).Id, 'a')
  assert.equal(upNext([ep('sw', 0, { Played: true }), a]).Id, 'a')
})

test('playable / playsAtOnce: what a tile opens', () => {
  const at = (Type: string, IsFolder?: boolean) => {
    const i = { Id: '1', Name: 'n', Type, IsFolder }
    return [playable(i), playsAtOnce(i)]
  }
  assert.deepEqual(at('Episode'), [true, true])
  assert.deepEqual(at('Movie'), [true, false]) // its page first
  assert.deepEqual(at('Video'), [true, false]) // its page: Play on…
  assert.deepEqual(at('MusicVideo'), [true, false])
  assert.deepEqual(at('Series'), [false, false])
  assert.deepEqual(at('Season'), [false, false])
  assert.deepEqual(at('BoxSet', true), [false, false])
})

test('runtime, time left and an episode row state', () => {
  const min = 60 * TICKS_PER_SECOND
  const e = { Id: 'e', RunTimeTicks: 42 * min } as Item
  assert.equal(runtime({ Id: 'x' } as Item), '')
  assert.match(runtime(e), /42/)
  assert.equal(progress(e), '')
  const started = { ...e, UserData: { PlaybackPositionTicks: 41.9 * min } }
  assert.ok(inProgress(started))
  assert.match(progress(started), /1.*left/) // at least 1 minute
  const watched = { ...started, UserData: { Played: true } }
  assert.equal(inProgress(watched), false)
  assert.equal(progress(watched), 'Watched')
})

test('pageItem: a season shows its series on that tab', () => {
  const series = { Id: 's', Type: 'Series' } as Item
  const season = { Id: 'n', Type: 'Season', SeriesId: 's' } as Item
  assert.deepEqual(pageItem(series), { item: series })
  assert.equal(pageItem(season), null) // series still loading
  assert.deepEqual(pageItem(season, series), { item: series, season: 'n' })
  const orphan = { Id: 'o', Type: 'Season' } as Item
  assert.deepEqual(pageItem(orphan), { item: orphan })
})

test('folderUp: a library goes home, a folder inside it to its parent', () => {
  const f = (Type: string, ParentId?: string) =>
    folderUp({ Id: 'x', Name: 'x', Type, ParentId })
  assert.equal(f('CollectionFolder', 'root'), null)
  assert.equal(f('UserView', 'root'), null)
  assert.equal(f('Folder', 'lib'), 'lib')
  assert.equal(f('Folder'), null)
})
