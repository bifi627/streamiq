// Run: node --test src/features/library/profile.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decision, deviceProfile, type Probe } from './profile.ts'

const webos: Probe = {
  h264: { profiles: ['high', 'main'], level: 51 },
  hevc: null,
  av1: null,
  audio: ['aac', 'ac3', 'opus'],
  surround: true,
}
const tp = (p: ReturnType<typeof deviceProfile>) => p.TranscodingProfiles[0]

test('H.264-only client: .ts, ts-safe audio, 5.1 when probed', () => {
  const t = tp(deviceProfile(webos))
  assert.equal(t.Container, 'ts')
  assert.equal(t.VideoCodec, 'h264')
  assert.equal(t.AudioCodec, 'aac,ac3') // no opus in .ts
  assert.equal(t.MaxAudioChannels, '6')
})

test('HEVC client: fMP4, hevc first, all probed audio', () => {
  const p = deviceProfile({ ...webos, hevc: { level: 153, main10: true } })
  assert.equal(tp(p).Container, 'mp4')
  assert.equal(tp(p).VideoCodec, 'hevc,h264')
  assert.equal(tp(p).AudioCodec, 'aac,ac3,opus')
  const hevc = p.CodecProfiles.find((c) => c.Codec === 'hevc')!
  assert.deepEqual(
    hevc.Conditions.map((c) => `${c.Property} ${c.Value}`),
    ['VideoRangeType SDR', 'VideoBitDepth 10', 'VideoLevel 153'],
  )
})

test('audio fallback: stereo AAC only', () => {
  const t = tp(deviceProfile(webos, true))
  assert.equal(t.AudioCodec, 'aac')
  assert.equal(t.MaxAudioChannels, '2')
})

test('compatible mode: H.264 + stereo AAC in .ts, 1080p / 8 Mbps caps', () => {
  const p = deviceProfile(
    { ...webos, hevc: { level: 153, main10: true }, av1: { main10: true } },
    false,
    true,
  )
  assert.equal(tp(p).Container, 'ts')
  assert.equal(tp(p).VideoCodec, 'h264')
  assert.equal(tp(p).AudioCodec, 'aac')
  assert.equal(tp(p).MaxAudioChannels, '2')
  assert.equal(p.MaxStreamingBitrate, 8_000_000)
  assert.deepEqual(
    p.CodecProfiles.map((c) => c.Codec),
    ['h264'],
  )
  assert.deepEqual(
    p.CodecProfiles[0].Conditions.slice(-2).map(
      (c) => `${c.Property} ${c.Condition} ${c.Value}`,
    ),
    ['Width LessThanEqual 1920', 'Height LessThanEqual 1080'],
  )
})

test('no H.264: clear error', () => {
  assert.throws(
    () => deviceProfile({ ...webos, h264: null }),
    /can't play H\.264/,
  )
})

// TranscodingUrls as Jellyfin 12.4 returns them (dev-media fixtures).
const url = (q: string) => `/videos/x/master.m3u8?${q}`
const h264aac = [
  { Index: 0, Type: 'Video', Codec: 'h264' },
  { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 1 },
]
const hevcac3 = [
  { Index: 0, Type: 'Video', Codec: 'hevc' },
  { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6 },
]

test('decision: remux + audio copy', () => {
  const d = decision(
    url(
      'VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=1&TranscodingMaxAudioChannels=2&TranscodeReasons=DirectPlayError',
    ),
    h264aac,
  )
  assert.deepEqual([d.videoCopy, d.audioCopy], [true, true])
  assert.equal(d.reasons, 'DirectPlayError')
})

test('decision: HEVC to an H.264 client transcodes; 5.1 over the cap transcodes audio', () => {
  const d = decision(
    url(
      'VideoCodec=h264&AudioCodec=aac,ac3&AudioStreamIndex=1&TranscodingMaxAudioChannels=2&TranscodeReasons=VideoCodecNotSupported,AudioChannelsNotSupported',
    ),
    hevcac3,
  )
  assert.deepEqual([d.videoCopy, d.audioCopy], [false, false])
})

test('decision: HEVC client remuxes; fallback flags force transcode', () => {
  const q =
    'VideoCodec=hevc,h264&AudioCodec=aac,ac3&AudioStreamIndex=1&TranscodingMaxAudioChannels=6&TranscodeReasons=DirectPlayError'
  assert.deepEqual(Object.values(decision(url(q), hevcac3)).slice(0, 2), [
    true,
    true,
  ])
  const f = decision(
    url(`${q}&allowVideoStreamCopy=false&allowAudioStreamCopy=false`),
    hevcac3,
  )
  assert.deepEqual([f.videoCopy, f.audioCopy], [false, false])
})

test('decision: level/bit depth reasons mean video transcode', () => {
  const d = decision(
    url(
      'VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=1&TranscodeReasons=VideoLevelNotSupported',
    ),
    h264aac,
  )
  assert.equal(d.videoCopy, false)
})
