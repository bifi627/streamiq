// Run: node --test src/features/player/profile.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  audioCodecs,
  autoAudio,
  autoCap,
  burstSize,
  autoQuality,
  decision,
  describe,
  effective,
  escalates,
  deviceProfile,
  fit,
  limit,
  median,
  nowPlaying,
  probe,
  qualities,
  rawStatus,
  saverOn,
  sizeName,
  sourceHint,
  toQuality,
  onFailure,
  type Playing,
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
  // one side over a rung is enough: it scales down
  assert.equal(at(2560, 1080), 'Auto,Source,1080p,720p,480p') // ultrawide
  assert.equal(at(1080, 1920), 'Auto,Source,1080p,720p,480p') // portrait
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
  // the axis that binds sets the scale: width for scope, height for 4:3
  assert.equal(
    nowPlaying(false, qs('MaxWidth=1920&MaxHeight=1080'), {
      width: 3840,
      height: 1600,
    }),
    'Transcoded to 1080p', // 1920x800, not 2592x1080
  )
  assert.equal(
    nowPlaying(false, qs('MaxWidth=1920&MaxHeight=1080'), {
      width: 2880,
      height: 2160,
    }),
    'Transcoded to 1080p', // 1440x1080, not 1920x1440
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

test('decision: the audio stream by its index; a source at the limit remuxes', () => {
  // not in index order: the video stream is found by its type
  const streams = [
    { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2 },
    { Index: 2, Type: 'Audio', Codec: 'dts', Channels: 6 },
    { Index: 0, Type: 'Video', Codec: 'h264', Width: 1280, Height: 720 },
  ]
  const q = (i: number) =>
    url(
      `VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=${i}&MaxWidth=1280&MaxHeight=720&TranscodeReasons=AudioCodecNotSupported`,
    )
  assert.deepEqual(
    [decision(q(1), streams).videoCopy, decision(q(1), streams).audioCopy],
    [true, true],
  )
  assert.equal(decision(q(2), streams).audioCopy, false)
  assert.equal(decision(q(2), streams).codecs, 'H264 + DTS')
  // the video stream's index is not an audio stream
  assert.equal(decision(q(0), streams).codecs, 'H264 + ?')
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

test('decodingInfo (#236): not smooth at 2160p = ≤1080p, unsupported at 1080p = dropped', () => {
  const yes = { supported: true, smooth: true }
  const jerky = { supported: true, smooth: false }
  const no = { supported: false, smooth: false }
  const hevc = { level: 153, main10: true }
  assert.equal(fit(hevc), hevc) // no answer: as today
  assert.equal(fit(hevc, yes), hevc)
  assert.equal(fit(null, yes, yes), null)
  assert.deepEqual(fit(hevc, yes, yes), { ...hevc, hd: false })
  assert.deepEqual(fit(hevc, yes, jerky), { ...hevc, hd: true })
  assert.equal(fit(hevc, no, no), null)
  assert.deepEqual(fit(webos.h264, no, no, true), { ...webos.h264, hd: true }) // H.264 stays

  const probed = {
    ...webos,
    hevc: fit(hevc, yes, jerky),
    av1: fit({ main10: false }, no, no),
  }
  assert.match(describe(probed), /hevc L5\.1 10bit ≤1080p · av1 no/)
  const p = deviceProfile(probed)
  assert.equal(tp(p).VideoCodec, 'hevc,h264')
  const conds = (codec: string, q = p) =>
    q.CodecProfiles.find((c) => c.Codec === codec)!
      .Conditions.filter((x) => /Width|Height/.test(x.Property))
      .map((c) => `${c.Property} ${c.Value}`)
  assert.deepEqual(conds('hevc'), ['Width 1920', 'Height 1080'])
  assert.deepEqual(conds('h264'), []) // smooth (no answer) = no cap
  assert.deepEqual(conds('hevc', deviceProfile(probed, false, false, '720p')), [
    'Width 1280',
    'Height 720',
  ]) // a lower rung still wins
})

test('probe: decodingInfo trims codecs; throwing = as today', async () => {
  Object.assign(globalThis, { MediaSource: { isTypeSupported: () => true } })
  const nav = (decodingInfo: (c: any) => Promise<unknown>) =>
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaCapabilities: { decodingInfo } },
      configurable: true,
    })
  nav(async (c) => {
    const t: string = c.video?.contentType ?? ''
    return {
      supported: !t.includes('av01'),
      smooth: !(t.includes('hvc1') && c.video.height > 1080),
    }
  })
  const p = await probe()
  assert.equal(p.hevc?.hd, true)
  assert.equal(p.h264?.hd, false)
  assert.equal(p.av1, null)
  nav(async () => {
    throw new Error('nope')
  })
  const q = await probe()
  assert.ok(q.av1 && q.hevc && q.hevc.hd === undefined)
})

test('probe: codecs dropped by decodingInfo leave audio tested alone (.ts)', async () => {
  // webOS-like: ac-3 fails muxed with video; decodingInfo rejects HEVC/AV1.
  Object.assign(globalThis, {
    MediaSource: {
      isTypeSupported: (t: string) =>
        !(t.startsWith('video/') && t.includes('ac-3')),
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaCapabilities: {
        decodingInfo: async (c: any) => {
          const ok = !/hvc1|av01/.test(c.video?.contentType ?? '')
          return { supported: ok, smooth: ok }
        },
      },
    },
    configurable: true,
  })
  const p = await probe()
  assert.equal(p.hevc, null)
  assert.equal(p.av1, null)
  assert.ok(p.audio.includes('ac3'))
})

test('escalates to compatible only after a fallback, not in compatible mode', () => {
  const all = { video: true, audio: true }
  assert.equal(escalates(all, false), false) // first failure: the normal fallback
  assert.equal(escalates({ video: false, audio: true }, false), true)
  assert.equal(escalates({ video: true, audio: false }, false), true)
  assert.equal(escalates({ video: false, audio: true }, true), false) // already on
})

test('auto audio (#252): a decodable track of the default language', () => {
  const a = (Index: number, Codec: string, Channels: number, more = {}) => ({
    Index,
    Type: 'Audio',
    Codec,
    Channels,
    Language: 'eng',
    ...more,
  })
  const dts = a(1, 'dts', 6)
  const codecs = audioCodecs(webos) // .ts: aac, ac3 (not opus)
  const pick = (streams: ReturnType<typeof a>[], surround = true) =>
    autoAudio([{ Index: 0, Type: 'Video' }, ...streams], 1, codecs, surround)
  assert.equal(pick([a(1, 'ac3', 6), a(2, 'aac', 6)]), undefined) // default decodes
  assert.equal(pick([dts, a(2, 'ac3', 6)]), 2)
  assert.equal(pick([dts, a(2, 'opus', 6), a(3, 'aac', 6)]), 3) // opus: not in .ts
  assert.equal(pick([dts, a(2, 'aac', 2)]), undefined) // stereo on a 5.1 device
  assert.equal(pick([dts, a(2, 'aac', 2)], false), 2) // stereo device
  assert.equal(
    pick([dts, a(2, 'ac3', 6, { Title: "Director's Commentary" })]),
    undefined,
  )
  assert.equal(pick([dts, a(2, 'ac3', 6, { Language: 'ger' })]), undefined)
  // The default is found by its index, not taken as the first audio track.
  assert.equal(autoAudio([a(1, 'aac', 6), a(2, 'dts', 6)], 2, codecs, true), 1)
  // Only audio streams: a video stream tagged with a language is no default.
  assert.equal(
    autoAudio(
      [
        { Index: 0, Type: 'Video', Codec: 'h264', Language: 'eng' },
        a(1, 'aac', 6),
      ],
      undefined,
      codecs,
      true,
    ),
    undefined,
  )
  // No default index: the first audio track is Jellyfin's default.
  assert.equal(autoAudio([dts, a(2, 'ac3', 6)], undefined, codecs, true), 2)
})

test('a throughput burst lasts ~2 s at the last read, within 1..16 MiB (#259)', () => {
  assert.equal(burstSize(40), 10_000_000) // 40 Mbps × 2 s
  assert.equal(burstSize(2), 1 << 20) // slow link: at least the warm-up size
  assert.equal(burstSize(300), 16 << 20) // loopback: the gateway's cap
})

test('data saver (#291): Automatic follows the browser, On/Off override it, Auto ≤ 480p', () => {
  assert.equal(saverOn('auto', { saveData: true, type: 'wifi' }), true)
  assert.equal(saverOn('auto', { type: 'cellular' }), true)
  assert.equal(saverOn('auto', { type: 'wifi', saveData: false }), false)
  assert.equal(saverOn('auto', undefined), false) // no Network Information API
  assert.equal(saverOn('on', undefined), true)
  assert.equal(saverOn('off', { saveData: true, type: 'cellular' }), false)
  assert.equal(autoQuality(100, 40e6, true), '480p') // fast link: still 480p
  assert.equal(autoQuality(undefined, undefined, true), '480p') // no measurement
  assert.equal(autoQuality(20, 40e6, false), '1080p')
  // a slow link still caps below 480p's 1.5 Mbps
  assert.equal(
    deviceProfile(webos, false, false, autoQuality(1, 40e6, true), autoCap(1))
      .MaxStreamingBitrate,
    0.7e6,
  )
  // the saver caps Auto only: a hand-picked quality plays as picked
  assert.equal(effective('Auto', 20, 40e6, true), '480p')
  assert.equal(effective('1080p', 20, 40e6, true), '1080p')
  assert.equal(effective('Source', 20, 40e6, true), 'Source')
  assert.equal(effective('Auto', 20, 40e6, false), '1080p')
})

// The fallback chain: onFailure.
const fresh: Playing = {
  raw: false,
  copy: { video: true, audio: true },
  compatible: false,
  escalated: false,
}
const media = (x: { fatal?: boolean; audio?: boolean } = {}) => ({
  media: true,
  fatal: false,
  audio: false,
  details: 'bufferAppendError',
  ...x,
})
const net = {
  media: false,
  fatal: true,
  audio: false,
  details: 'fragLoadError',
}

test('onFailure: stuck video → video transcode', () => {
  assert.deepEqual(onFailure('stuck', fresh), {
    reload: 'fallback: video transcode',
    less: { video: false },
  })
})

test('onFailure: an audio media error → stereo AAC, not again once audio is not copied', () => {
  assert.deepEqual(onFailure(media({ audio: true }), fresh), {
    reload: 'fallback: stereo AAC',
    less: { audio: false },
  })
  const noAudio = { ...fresh, copy: { video: true, audio: false } }
  assert.equal(onFailure(media({ audio: true }), noAudio), null)
  // fatal: no second stereo AAC, the compatible escalation instead
  assert.deepEqual(onFailure(media({ audio: true, fatal: true }), noAudio), {
    reload: 'fallback: compatible (after playback error: bufferAppendError)',
    less: { video: false, audio: false },
    escalate: true,
  })
})

test('onFailure: a failure after a fallback → compatible once, then the error', () => {
  const after = { ...fresh, copy: { video: false, audio: true } }
  assert.deepEqual(onFailure('stuck', after), {
    reload: 'fallback: compatible (after fallback: video transcode)',
    less: { video: false, audio: false },
    escalate: true,
  })
  const esc: Playing = {
    ...fresh,
    copy: { video: false, audio: false },
    compatible: true,
    escalated: true,
  }
  assert.deepEqual(onFailure('stuck', esc), {
    error: 'Playback failed (even in compatible mode)',
  })
  assert.deepEqual(onFailure(media({ fatal: true }), esc), {
    error: 'playback error: bufferAppendError (even in compatible mode)',
  })
  assert.deepEqual(
    onFailure(media({ audio: true }), {
      ...esc,
      copy: { video: false, audio: true },
    }),
    {
      error: 'Playback failed (even in compatible mode)',
    },
  )
})

test('onFailure: a fatal media error with nothing left to drop is the error', () => {
  // full copy: no fallback happened yet, nothing to escalate from
  assert.deepEqual(onFailure(media({ fatal: true }), fresh), {
    error: 'playback error: bufferAppendError',
  })
  const none = {
    ...fresh,
    copy: { video: false, audio: false },
    compatible: true,
  }
  assert.deepEqual(onFailure(media({ fatal: true }), none), {
    error: 'playback error: bufferAppendError',
  })
})

test('onFailure: compatible mode never escalates: the next fallback, then the error', () => {
  const compat = { ...fresh, compatible: true }
  assert.deepEqual(onFailure('stuck', compat), {
    reload: 'fallback: video transcode',
    less: { video: false },
  })
  const after = { ...compat, copy: { video: false, audio: true } }
  assert.deepEqual(onFailure(media({ audio: true }), after), {
    reload: 'fallback: stereo AAC',
    less: { audio: false },
  })
  assert.deepEqual(onFailure(media({ fatal: true }), after), {
    error: 'playback error: bufferAppendError',
  })
})

test('onFailure: Raw never reloads: stuck, fatal and audio media errors are the Raw error', () => {
  const raw = { ...fresh, raw: true }
  for (const f of [
    'stuck',
    media({ fatal: true }),
    media({ audio: true }),
  ] as const)
    assert.deepEqual(onFailure(f, raw), { raw: true })
  // even after an earlier fallback turned copy off (Raw copies anyway)
  const after = { ...raw, copy: { video: false, audio: false } }
  assert.deepEqual(onFailure(media({ audio: true }), after), { raw: true })
  assert.deepEqual(onFailure('stuck', after), { raw: true })
  assert.equal(onFailure(media(), raw), null)
  assert.deepEqual(onFailure(net, raw), {
    error: 'playback error: fragLoadError',
  })
})

test('onFailure: a fatal non-media error is the error, never a fallback', () => {
  for (const s of [fresh, { ...fresh, copy: { video: false, audio: true } }])
    assert.deepEqual(onFailure(net, s), {
      error: 'playback error: fragLoadError',
    })
  assert.deepEqual(onFailure({ ...net, audio: true }, fresh), {
    error: 'playback error: fragLoadError',
  })
  // no "(even in compatible mode)": only the fallback chain says that
  assert.deepEqual(onFailure(net, { ...fresh, escalated: true }), {
    error: 'playback error: fragLoadError',
  })
})

test('onFailure: a non-fatal, non-audio error does nothing', () => {
  assert.equal(onFailure(media(), fresh), null)
  assert.equal(onFailure({ ...net, fatal: false }, fresh), null)
})
