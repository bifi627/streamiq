// Run: node --test src/features/gateways/transcodeReport.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  episodesLine,
  profiled,
  report,
  reportNote,
} from './transcodeReport.ts'
import type { Item } from '../library/items.ts'
import type { Client, Probe } from '../../generated/pairing.ts'

const chrome: Probe = {
  h264: { profiles: ['high', 'main', 'constrained baseline'], level: 52 },
  hevc: { level: 153, main10: true },
  av1: null,
  audio: ['aac', 'opus', 'flac'],
  surround: false,
}
const tv: Probe = {
  h264: { profiles: ['high', 'main'], level: 51, hd: true },
  hevc: null,
  av1: null,
  audio: ['aac', 'ac3', 'eac3'],
  surround: true,
}
const client = (
  name: string,
  probe: Probe | null,
  compatible = false,
): Client => ({
  keyFp: name,
  name,
  addedAt: '2026-11-01T00:00:00Z',
  self: false,
  profile: probe && { probe, compatible, probedAt: '2026-11-20T00:00:00Z' },
})
const video = (Codec: string, more: object = {}) => ({
  Index: 0,
  Type: 'Video',
  Codec,
  Width: 1920,
  Height: 1080,
  BitDepth: 8,
  VideoRangeType: 'SDR',
  ...more,
})
const audio = (
  Index: number,
  Codec: string,
  Channels = 2,
  Language = 'eng',
) => ({
  Index,
  Type: 'Audio',
  Codec,
  Channels,
  Language,
})
const movie = (Id: string, streams: Item['MediaStreams'], def = 1): Item => ({
  Id,
  Name: Id,
  Type: 'Movie',
  MediaSources: [
    { DefaultAudioStreamIndex: def, Bitrate: 5_000_000, MediaStreams: streams },
  ],
})
const rows = (items: Item[], ...cs: Client[]) =>
  report(items, profiled(cs).clients)

test('H.264 + AAC plays everywhere: not listed', () => {
  const r = rows(
    [
      movie('Plain', [
        video('h264', { Profile: 'High', Level: 41 }),
        audio(1, 'aac'),
      ]),
    ],
    client('Laptop', chrome),
    client('TV', tv),
  )
  assert.deepEqual(r, [])
})

test('HEVC 10-bit: the TV transcodes video, the laptop plays it', () => {
  const r = rows(
    [
      movie('Hevc', [
        video('hevc', { BitDepth: 10, Level: 150 }),
        audio(1, 'aac'),
      ]),
    ],
    client('Laptop', chrome),
    client('TV', tv),
  )
  assert.deepEqual(r, [
    {
      id: 'Hevc',
      name: 'Hevc',
      reasons: [{ text: 'video: HEVC', clients: ['TV'] }],
    },
  ])
})

test('video reasons name the failed condition', () => {
  const r = rows(
    [
      movie('Hdr', [
        video('h264', { VideoRangeType: 'HDR10' }),
        audio(1, 'aac'),
      ]),
      movie('Uhd', [
        video('h264', { Width: 3840, Height: 2160 }),
        audio(1, 'aac'),
      ]),
      movie('Level', [video('h264', { Level: 52 }), audio(1, 'aac')]),
      movie('Profile', [
        video('h264', { Profile: 'High 10' }),
        audio(1, 'aac'),
      ]),
    ],
    client('TV', tv),
  )
  assert.deepEqual(
    r.map((x) => x.reasons[0].text),
    [
      'video: H264 HDR10',
      'video: H264 level 52',
      'video: H264 High 10',
      'video: H264 3840×2160',
    ],
  )
})

test('audio: the default track, unless autoAudio finds one that decodes', () => {
  const r = rows(
    [
      movie('Dts', [video('h264'), audio(1, 'dts', 6)]),
      movie('DtsAndAac', [
        video('h264'),
        audio(1, 'dts', 6),
        audio(2, 'aac', 2),
      ]),
      movie('DtsAndAacDe', [
        video('h264'),
        audio(1, 'dts', 6),
        audio(2, 'aac', 2, 'deu'),
      ]),
      movie('Ac3', [video('h264'), audio(1, 'ac3', 6)]),
    ],
    client('Laptop', chrome),
    client('TV', tv),
  )
  assert.deepEqual(r, [
    {
      id: 'Ac3',
      name: 'Ac3',
      reasons: [{ text: 'audio: AC3 5.1', clients: ['Laptop'] }],
    },
    {
      id: 'Dts',
      name: 'Dts',
      reasons: [{ text: 'audio: DTS 5.1', clients: ['Laptop', 'TV'] }],
    },
    {
      // the TV outputs 5.1: a stereo track isn't eligible for it
      id: 'DtsAndAac',
      name: 'DtsAndAac',
      reasons: [{ text: 'audio: DTS 5.1', clients: ['TV'] }],
    },
    {
      id: 'DtsAndAacDe',
      name: 'DtsAndAacDe',
      reasons: [{ text: 'audio: DTS 5.1', clients: ['Laptop', 'TV'] }],
    },
  ])
})

test("autoAudio's pick must fit the client's channels too", () => {
  // a stereo laptop: the AAC 5.1 alternative is downmixed, a transcode
  const r = rows(
    [movie('Dts', [video('h264'), audio(1, 'dts', 6), audio(2, 'aac', 6)])],
    client('Laptop', chrome),
    client('TV', tv),
  )
  assert.deepEqual(r[0].reasons, [
    { text: 'audio: DTS 5.1', clients: ['Laptop'] },
  ])
})

test('Compatible mode plays the default track: no autoAudio fallback', () => {
  const r = rows(
    [movie('Dts', [video('h264'), audio(1, 'dts', 6), audio(2, 'aac', 2)])],
    client('Old TV', tv, true),
    client('Laptop', chrome),
  )
  assert.deepEqual(r[0].reasons, [
    { text: 'audio: DTS 5.1', clients: ['Old TV'] },
  ])
})

test('Compatible mode: stereo AAC, H.264 only, at most 1080p / 8 Mbps', () => {
  const big: Item = {
    ...movie('Big', [video('h264'), audio(1, 'aac')]),
    MediaSources: [
      {
        DefaultAudioStreamIndex: 1,
        Bitrate: 20_000_000,
        MediaStreams: [video('h264'), audio(1, 'aac')],
      },
    ],
  }
  const r = rows(
    [movie('Ac3', [video('h264'), audio(1, 'ac3', 2)]), big],
    client('Old TV', tv, true),
    client('TV', tv),
  )
  assert.deepEqual(r, [
    {
      id: 'Big',
      name: 'Big',
      reasons: [{ text: 'video: H264 over 8 Mbps', clients: ['Old TV'] }],
    },
    {
      id: 'Ac3',
      name: 'Ac3',
      reasons: [{ text: 'audio: AC3 stereo', clients: ['Old TV'] }],
    },
  ])
})

test('episodes roll up per series; video rows first, then by name', () => {
  const ep = (Id: string, codec: string): Item => ({
    ...movie(Id, [video(codec), audio(1, 'aac')]),
    Type: 'Episode',
    SeriesId: 'S',
    SeriesName: 'Show',
  })
  const r = rows(
    [
      movie('A audio', [video('h264'), audio(1, 'dts', 6)]),
      ep('e1', 'hevc'),
      ep('e2', 'h264'),
      ep('e3', 'hevc'),
    ],
    client('TV', tv),
  )
  assert.deepEqual(
    r.map((x) => [x.name, x.episodes]),
    [
      ['Show', { n: 2, of: 3 }],
      ['A audio', undefined],
    ],
  )
  assert.equal(episodesLine({ n: 2, of: 3 }), '2 of 3 episodes')
})

test('clients: never probed are named, a probe without H.264 is left out', () => {
  const p = profiled([
    client('New', null),
    client('Odd', { ...chrome, h264: null }),
    client('TV', tv),
  ])
  assert.deepEqual(p.notProbed, ['New'])
  assert.deepEqual(
    p.clients.map((c) => c.name),
    ['TV'],
  )
})

test('the note: members, errors, loading, nobody probed', () => {
  const ok = { admin: true, probed: 1, error: null, loaded: true }
  assert.equal(reportNote({ ...ok, admin: undefined }), 'loading…') // no role yet
  assert.equal(reportNote({ ...ok, admin: false }), 'Only admins can see this.')
  assert.equal(reportNote({ ...ok, error: 'down' }), 'down')
  assert.equal(reportNote({ ...ok, loaded: false }), 'loading…')
  assert.match(reportNote({ ...ok, probed: 0 }) ?? '', /^No paired client/)
  assert.equal(reportNote(ok), null)
})
