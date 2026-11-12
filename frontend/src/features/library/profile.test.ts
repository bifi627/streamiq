// Run: node --test src/features/library/profile.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoCap,
  autoQuality,
  decision,
  deviceProfile,
  limit,
  median,
  nowPlaying,
  probe,
  qualities,
  rawStatus,
  sizeName,
  sourceHint,
  toQuality,
  type Probe,
} from './profile.ts'

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

const sizes = (p: ReturnType<typeof deviceProfile>) =>
  p.CodecProfiles.map((c) =>
    c.Conditions.filter((x) => /Width|Height/.test(x.Property))
      .map((x) => x.Value)
      .join('x'),
  )
const hevcAv1: Probe = {
  ...webos,
  hevc: { level: 153, main10: true },
  av1: { main10: true },
}

test('quality Auto / Source: no size limit, remux ceiling', () => {
  for (const q of ['Auto', 'Source'] as const) {
    const p = deviceProfile(hevcAv1, false, false, q)
    assert.equal(p.MaxStreamingBitrate, 120_000_000)
    assert.deepEqual(sizes(p), ['', '', ''])
  }
})

test('quality 720p: bitrate + size on every codec', () => {
  const p = deviceProfile(hevcAv1, false, false, '720p')
  assert.equal(p.MaxStreamingBitrate, 4_000_000)
  assert.deepEqual(sizes(p), ['1280x720', '1280x720', '1280x720'])
  assert.equal(
    deviceProfile(hevcAv1, false, false, '480p').MaxStreamingBitrate,
    1_500_000,
  )
})

test('compatible mode: at most 1080p, a lower quality still applies', () => {
  assert.equal(
    deviceProfile(webos, false, true, 'Auto').MaxStreamingBitrate,
    8_000_000,
  )
  assert.equal(
    deviceProfile(webos, false, true, 'Source').MaxStreamingBitrate,
    8_000_000,
  )
  const p = deviceProfile(webos, false, true, '480p')
  assert.equal(p.MaxStreamingBitrate, 1_500_000)
  assert.deepEqual(sizes(p), ['854x480'])
})

test('stored quality: invalid or missing = Auto', () => {
  assert.equal(toQuality('720p'), '720p')
  assert.equal(toQuality(null), 'Auto')
  assert.equal(toQuality('4K'), 'Auto')
  assert.equal(toQuality('toString'), 'Auto')
  assert.equal(toQuality('Source'), 'Source')
  assert.equal(toQuality('Raw'), 'Raw')
})

test('picker: only rungs that scale the source down', () => {
  const at = (width: number, height: number, q = 'Auto' as const) =>
    qualities({ width, height }, q).join(',')
  assert.equal(at(3840, 2160), 'Auto,Source,1080p,720p,480p')
  assert.equal(at(1920, 1080), 'Auto,Source,720p,480p')
  assert.equal(at(1920, 800), 'Auto,Source,720p,480p') // scope 1080p
  assert.equal(at(426, 240), 'Auto,Source')
  assert.equal(at(0, 0), 'Auto,Source,1080p,720p,480p') // unknown: all
  // Raw only with its setting on, next to Source
  assert.equal(
    qualities({ width: 3840, height: 2160 }, 'Auto', true).join(','),
    'Auto,Source,Raw,1080p,720p,480p',
  )
  // a stored rung stays visible (and selected) even when it changes nothing
  assert.equal(
    qualities({ width: 426, height: 240 }, '720p').join(','),
    'Auto,Source,720p',
  )
})

test('picker labels: size names and the Source hint', () => {
  assert.equal(sizeName({ width: 3840, height: 1600 }), '4K')
  assert.equal(sizeName({ width: 1916, height: 1076 }), '1080p')
  assert.equal(sizeName({ width: 1080, height: 1920 }), '1080p') // portrait
  assert.equal(sizeName({ width: 640, height: 360 }), '360p')
  assert.equal(
    sourceHint({ width: 3840, height: 2160 }, 40_000_000),
    '4K, 40 Mbps',
  )
  assert.equal(sourceHint({ width: 1280, height: 720 }), '720p')
  assert.equal(sourceHint({ width: 0, height: 0 }), '')
})

test('picker status: original, or the transcode size', () => {
  const uhd = { width: 3840, height: 2160 }
  const qs = (s: string) => new URLSearchParams(s)
  assert.equal(nowPlaying(true, qs(''), uhd), 'Original 4K')
  assert.equal(
    nowPlaying(false, qs('MaxWidth=1280&MaxHeight=720'), uhd),
    'Transcoded to 720p',
  )
  // never upscaled; aspect kept within both caps
  assert.equal(
    nowPlaying(false, qs('MaxWidth=1920&MaxHeight=1080'), {
      width: 640,
      height: 360,
    }),
    'Transcoded to 360p',
  )
  assert.equal(
    nowPlaying(false, qs('MaxWidth=1280&MaxHeight=720'), {
      width: 3840,
      height: 1600,
    }),
    'Transcoded to 720p', // 1280x533: named by its width
  )
  assert.equal(nowPlaying(false, qs(''), { width: 0, height: 0 }), 'Transcoded')
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

test('decision: over the quality limit means video transcode (no reason)', () => {
  const v720 = [
    {
      Index: 0,
      Type: 'Video',
      Codec: 'h264',
      Width: 1280,
      Height: 720,
      BitRate: 900_000,
    },
    h264aac[1],
  ]
  const q =
    'VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=1&TranscodeReasons=DirectPlayError&VideoBitrate=1430815'
  assert.equal(decision(url(q), v720).videoCopy, true) // Auto: bitrate only
  const d = decision(url(`${q}&MaxWidth=854&MaxHeight=480`), v720)
  assert.equal(d.videoCopy, false)
  assert.match(d.text, /over limit: width,height \(1280x720/)
  assert.equal(
    decision(url(q), [{ ...v720[0], BitRate: 5_000_000 }, h264aac[1]])
      .videoCopy,
    false,
  )
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

test('probe: audio muxed for fMP4 clients, alone for .ts clients', async () => {
  // webOS: ac-3 passes alone, fails muxed with any video codec. No AV1.
  let hevcOn = true
  const isTypeSupported = (t: string) =>
    !(t.startsWith('video/') && t.includes('ac-3')) &&
    !t.includes('av01') &&
    (hevcOn || !t.includes('hvc1'))
  Object.assign(globalThis, { MediaSource: { isTypeSupported } })
  assert.ok((await probe()).hevc)
  assert.ok(!(await probe()).audio.includes('ac3'))
  hevcOn = false
  assert.ok((await probe()).audio.includes('ac3'))
})

test('Auto from the measured link: 70 % cap, source fits = no limit', () => {
  assert.equal(median([2, 30, 20]), 20) // the low first burst drops out
  assert.equal(autoQuality(undefined, 40e6), 'Auto') // no measurement: no cap
  assert.equal(autoQuality(20, 10e6), 'Auto') // 10 ≤ 14 Mbps: remux unchanged
  assert.equal(autoQuality(20, 40e6), '1080p') // 4K 40 Mbps: 8 ≤ 14
  assert.equal(autoQuality(10, 40e6), '720p') // cap 7: 4 ≤ 7 < 8
  assert.equal(autoQuality(10), '720p') // unknown source bitrate: the rung
  assert.equal(autoQuality(1, 40e6), '480p') // nothing fits: the lowest
  // compatible mode still caps at 1080p; a lower Auto rung still applies
  assert.equal(limit(autoQuality(20, 10e6), true)?.height, 1080)
  assert.equal(limit(autoQuality(10, 40e6), true)?.height, 720)
  // MaxStreamingBitrate never above the cap, also under a rung's own bitrate
  const max = (mbps: number, q = autoQuality(mbps, 40e6)) =>
    deviceProfile(webos, false, false, q, autoCap(mbps)).MaxStreamingBitrate
  assert.equal(max(20), 8e6) // 1080p's 8 < 14
  assert.equal(max(1), 0.7e6) // 480p's 1.5 > 0.7
  assert.equal(max(20, autoQuality(20, 10e6)), 14e6) // fits: cap only
  assert.equal(deviceProfile(webos).MaxStreamingBitrate, 120e6) // no cap
})

test('Raw: every codec in fMP4, no probe, no caps (#164)', () => {
  const p = deviceProfile(webos, true, false, 'Raw', 4e6) // stereo + cap ignored
  assert.equal(tp(p).Container, 'mp4')
  assert.equal(tp(p).VideoCodec, 'h264,hevc,av1,vp9')
  assert.equal(tp(p).AudioCodec, 'aac,ac3,eac3,dts,truehd,flac,opus,mp3')
  assert.ok(tp(p).AudioCodec.length <= 40) // Jellyfin's master.m3u8 limit
  assert.equal(tp(p).MaxAudioChannels, '8')
  assert.deepEqual(p.CodecProfiles, []) // no level/depth/size/HDR conditions
  assert.equal(p.MaxStreamingBitrate, 2_147_483_647)
  // compatible mode never plays Raw
  assert.equal(tp(deviceProfile(webos, false, true, 'Raw')).Container, 'ts')
})

test('Raw status: the source codecs, unchecked', () => {
  const d = decision(
    '/x?VideoCodec=h264,hevc&AudioCodec=dts&AudioStreamIndex=1',
    [
      { Index: 0, Type: 'Video', Codec: 'hevc' },
      { Index: 1, Type: 'Audio', Codec: 'dts', Channels: 6 },
    ],
  )
  assert.ok(d.videoCopy && d.audioCopy)
  assert.equal(rawStatus(d.codecs), 'Original · HEVC + DTS (unchecked)')
})
