/// <reference lib="dom" /> -- probe() is DOM; node --test imports the rest
// Client capability probe → Jellyfin DeviceProfile (#115). Jellyfin decides
// per playback, from this profile, whether video is remuxed or transcoded and
// whether audio is copied; it says why in TranscodeReasons. Re-probed at each
// playback start (milliseconds, no storage). TVs over-report (#81), so the
// player keeps its runtime fallbacks. mediaCapabilities.decodingInfo then
// trims each video codec to what decodes smoothly (#236). Pure except probe() (node --test imports
// this file).

/** hd = at most 1080p: 2160p is not smooth (decodingInfo, #236) */
type Hd = { hd?: boolean }
export type Probe = {
  /** H.264 profiles (Jellyfin names) + highest level, e.g. 51 = 5.1 */
  h264: ({ profiles: string[]; level: number } & Hd) | null
  /** HEVC Main; level in Jellyfin units (level × 30, e.g. 153 = 5.1) */
  hevc: ({ level: number; main10: boolean } & Hd) | null
  av1: ({ main10: boolean } & Hd) | null
  /** Jellyfin audio codec names */
  audio: string[]
  /** 5.1 audio decodes (mediaCapabilities) */
  surround: boolean
}

const H264 = { high: '64', main: '4D', baseline: '42' }
const H264_LEVELS = [52, 51, 50, 42, 41, 40, 32, 31, 30]
const HEVC_LEVELS = [186, 183, 180, 156, 153, 150, 123, 120, 93]
const AUDIO: Record<string, string> = {
  aac: 'mp4a.40.2',
  ac3: 'ac-3',
  eac3: 'ec-3',
  opus: 'opus',
  flac: 'flac',
}

type Info = { supported: boolean; smooth: boolean }

/** A codec's entry from decodingInfo at 1080p and 2160p (#236): dropped when
 * 1080p is not supported, capped at 1080p when 2160p is not smooth. No answer
 * (no mediaCapabilities, or it threw) = unchanged. keep = never drop (H.264:
 * the transcode target, without it nothing plays). */
export function fit<T extends object>(
  c: T | null,
  hd?: Info,
  uhd?: Info,
  keep = false,
): (T & Hd) | null {
  if (!c || !hd || !uhd) return c
  if (!hd.supported && !keep) return null
  return { ...c, hd: !uhd.smooth }
}

/** Asks this browser what it can decode via MSE. Works on Chrome 87. */
export async function probe(): Promise<Probe> {
  const ok = (codecs: string, kind = 'video') =>
    MediaSource.isTypeSupported(`${kind}/mp4; codecs="${codecs}"`)
  const profiles = Object.entries(H264)
    .filter(([, p]) => ok(`avc1.${p}0028`)) // level 4.0
    .map(([name]) => name)
  if (profiles.includes('baseline')) profiles.push('constrained baseline')
  const top = profiles.includes('high')
    ? '64'
    : profiles.includes('main')
      ? '4D'
      : '42'
  const h264Level = H264_LEVELS.find((l) =>
    ok(`avc1.${top}00${l.toString(16)}`),
  )
  const hevcLevel = HEVC_LEVELS.find((l) => ok(`hvc1.1.6.L${l}.B0`))
  const info = async (codecs: string, height: number, bitrate: number) => {
    try {
      return await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: {
          contentType: `video/mp4; codecs="${codecs}"`,
          width: (height * 16) / 9,
          height,
          bitrate,
          framerate: 30,
        },
      })
    } catch {
      return undefined // no mediaCapabilities: isTypeSupported alone, as before
    }
  }
  // 30 fps at 10 / 40 Mbps: a typical 1080p / 4K source. One codec string per
  // codec, at both sizes: its top probed level (AV1: 5.0, 4K) and bit depth.
  const smooth = async <T extends object>(
    c: T | null,
    codecs: string,
    keep = false,
  ) => {
    if (!c) return c
    const [hd, uhd] = await Promise.all([
      info(codecs, 1080, 10e6),
      info(codecs, 2160, 40e6),
    ])
    return fit(c, hd, uhd, keep)
  }
  let surround = false
  try {
    surround = (
      await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        audio: {
          contentType: `audio/mp4; codecs="${AUDIO.aac}"`,
          channels: '6',
          bitrate: 384_000,
          samplerate: 48_000,
        },
      })
    ).supported
  } catch {
    // no mediaCapabilities: stay stereo
  }
  const hevc10 = ok('hvc1.2.4.L153.B0')
  const av10 = ok('av01.0.08M.10')
  const [h264, hevc, av1] = await Promise.all([
    smooth(
      profiles.length && h264Level ? { profiles, level: h264Level } : null,
      `avc1.${top}00${h264Level?.toString(16)}`,
      true,
    ),
    smooth(
      hevcLevel ? { level: hevcLevel, main10: hevc10 } : null,
      hevc10 ? `hvc1.2.4.L${hevcLevel}.B0` : `hvc1.1.6.L${hevcLevel}.B0`,
    ),
    smooth(
      ok('av01.0.08M.08') ? { main10: av10 } : null,
      av10 ? 'av01.0.12M.10' : 'av01.0.12M.08',
    ),
  ])
  // fMP4 (HEVC/AV1 clients, see deviceProfile) plays from one muxed
  // audiovideo SourceBuffer: audio must pass muxed with every video codec it
  // can sit beside (webOS: audio/mp4 ac-3 yes, video/mp4 avc1+ac-3 no). .ts
  // transmuxes into separate buffers, so there audio alone is the right test.
  const muxed = [
    'avc1.42E01E',
    hevc && 'hvc1.1.6.L93.B0',
    av1 && 'av01.0.08M.08',
  ].filter(Boolean)
  return {
    h264,
    hevc,
    av1,
    audio: Object.keys(AUDIO).filter((c) =>
      hevc || av1
        ? muxed.every((v) => ok(`${v},${AUDIO[c]}`))
        : ok(AUDIO[c], 'audio'),
    ),
    surround,
  }
}

const hd = (c: Hd) => (c.hd ? ' ≤1080p' : '')
export const describe = (p: Probe) =>
  [
    `h264 ${p.h264 ? `${p.h264.profiles.join('/')} L${p.h264.level / 10}${hd(p.h264)}` : 'no'}`,
    `hevc ${p.hevc ? `L${p.hevc.level / 30}${p.hevc.main10 ? ' 10bit' : ''}${hd(p.hevc)}` : 'no'}`,
    `av1 ${p.av1 ? (p.av1.main10 ? '10bit' : '8bit') + hd(p.av1) : 'no'}`,
    `audio ${p.audio.join(',') || 'none'}`,
    p.surround ? '5.1' : 'stereo',
  ].join(' · ')

// Jellyfin plays only these audio codecs in HLS .ts (StreamBuilder).
const TS_AUDIO = ['aac', 'ac3', 'eac3', 'mp3']

// Auto's ceiling (≈ jellyfin-web's), so sources remux at any realistic bitrate.
const MAX_BITRATE = 120_000_000

/** Quality picker (#108, #161). Source = no limit: the original file plays
 * unless the device can't take it. Raw (#164, behind a setting) = no limit and
 * no probe: every codec Jellyfin can put in fMP4 is copied, unchecked. Auto = Source, or a rung picked from the
 * measured link (autoQuality, #162). The others cap MaxStreamingBitrate and the size:
 * Jellyfin remuxes a source within them and transcodes a larger one down (it
 * only scales down). Ordered from least to most restrictive. */
export const QUALITY = {
  Auto: null,
  Source: null,
  Raw: null,
  '1080p': { bitrate: 8_000_000, width: 1920, height: 1080 },
  '720p': { bitrate: 4_000_000, width: 1280, height: 720 },
  '480p': { bitrate: 1_500_000, width: 854, height: 480 },
}
export type Quality = keyof typeof QUALITY
export const QUALITIES = Object.keys(QUALITY) as Quality[]

/** The middle value (the first burst reads low: the data channel ramps up). */
export const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/** Auto's MaxStreamingBitrate cap (#162): 70 % of the measured gateway →
 * client Mbps, in bps. No measurement = no cap. */
export const autoCap = (mbps?: number) =>
  mbps ? Math.round(mbps * 7e5) : undefined

/** Auto's pick from the measurement: no limit without one, or for a source
 * (bps) under the cap (it remuxes unchanged); else the highest rung under the
 * cap, at least 480p (deviceProfile still caps that at autoCap). An unknown
 * source bitrate gets the rung (Jellyfin knows it, we may not). */
export function autoQuality(mbps?: number, bitrate?: number): Quality {
  const cap = autoCap(mbps)
  if (!cap || (bitrate && bitrate <= cap)) return 'Auto'
  return (
    (['1080p', '720p'] as const).find((r) => QUALITY[r].bitrate <= cap) ??
    '480p'
  )
}

/** A stored value as a Quality; invalid or missing = Auto. */
export const toQuality = (v: unknown): Quality =>
  QUALITIES.includes(v as Quality) ? (v as Quality) : 'Auto'

/** The limit in effect: the quality's, but at most 1080p in compatible mode
 * (#113). null = no limit. */
export const limit = (quality: Quality, compatible = false) =>
  QUALITY[compatible && !QUALITY[quality] ? '1080p' : quality]

/** The source's video size; 0 = unknown. */
export type Size = { width: number; height: number }

/** The picker's options for a source: a rung that would not scale it down is
 * hidden (Jellyfin never upscales), unless it is the current choice. Unknown
 * size = all. Raw only with its setting on (#164). */
export const qualities = (src: Size, current: Quality, raw = false) =>
  QUALITIES.filter((o) => {
    const r = QUALITY[o]
    if (o === 'Raw') return raw
    return (
      !r ||
      o === current ||
      !src.height ||
      r.height < src.height ||
      r.width < src.width
    )
  })

const NAMES: [number, number, string][] = [
  [3840, 2160, '4K'],
  [2560, 1440, '1440p'],
  [1920, 1080, '1080p'],
  [1280, 720, '720p'],
  [854, 480, '480p'],
]
/** A video size by its usual name: 3840x1600 (scope) is 4K, 640x360 is 360p.
 * 5 % slack for crops (1916x1076); portrait by its short side. */
export function sizeName({ width, height }: Size) {
  const [long, short] = [Math.max(width, height), Math.min(width, height)] // portrait too
  return (
    NAMES.find(([w, h]) => long >= w * 0.95 || short >= h * 0.95)?.[2] ??
    `${short}p`
  )
}

/** "4K, 40 Mbps" for the Source option; parts that are unknown are left out. */
export const sourceHint = (src: Size, bitrate?: number) =>
  [
    src.height && sizeName(src),
    bitrate &&
      `${(bitrate / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} Mbps`,
  ]
    .filter(Boolean)
    .join(', ')

/** What plays, for the picker: the original, or the transcode's size from the
 * final TranscodingUrl params (Jellyfin keeps the aspect within MaxWidth/
 * MaxHeight and never upscales). */
export function nowPlaying(
  videoCopy: boolean,
  params: URLSearchParams,
  src: Size,
) {
  if (videoCopy) return `Original${src.height ? ` ${sizeName(src)}` : ''}`
  const num = (k: string) => Number(params.get(k) ?? Infinity)
  const scale = Math.min(
    1,
    num('MaxHeight') / src.height,
    num('MaxWidth') / src.width,
  )
  return src.height
    ? `Transcoded to ${sizeName({ width: Math.round(src.width * scale), height: Math.round(src.height * scale) })}`
    : 'Transcoded'
}

// Raw (#164): every codec Jellyfin copies into fMP4 HLS (spike on #164: it
// drops vp8/mpeg2/vc1 itself). AudioCodec ends up in the master.m3u8 URL, which
// Jellyfin rejects above 40 chars, so this is not "everything". Int32 max:
// anything larger is a 400.
const RAW_VIDEO = 'h264,hevc,av1,vp9'
const RAW_AUDIO = 'aac,ac3,eac3,dts,truehd,flac,opus,mp3'

/** The status for Raw: the original streams, unchecked. */
export const rawStatus = (codecs: string) => `Original · ${codecs} (unchecked)`

/** The DeviceProfile for PlaybackInfo. stereo = the audio fallback: AAC 2.0
 * only. compatible = the most restrictive profile (#113): H.264 only, stereo
 * AAC, .ts, at most 1080p / 8 Mbps. quality = the picker's limit (#108); Raw
 * ignores the probe and every other argument (#164). cap = Auto's bitrate cap
 * (bps, #162). Throws when there is no H.264 (the one
 * transcode target). */
export function deviceProfile(
  probed: Probe,
  stereo = false,
  compatible = false,
  quality: Quality = 'Auto',
  cap = Infinity,
) {
  if (quality === 'Raw' && !compatible)
    return {
      MaxStreamingBitrate: 2_147_483_647,
      DirectPlayProfiles: [],
      TranscodingProfiles: [
        {
          Type: 'Video',
          Context: 'Streaming',
          Protocol: 'hls',
          Container: 'mp4',
          VideoCodec: RAW_VIDEO,
          AudioCodec: RAW_AUDIO,
          MaxAudioChannels: '8',
          BreakOnNonKeyFrames: false,
        },
      ],
      CodecProfiles: [],
      SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls' }],
    }
  const max = limit(quality, compatible)
  const p: Probe = compatible
    ? { ...probed, hevc: null, av1: null, audio: ['aac'], surround: false }
    : probed
  if (!p.h264) throw new Error("this browser can't play H.264")
  // hls.js plays HEVC/AV1 only from fMP4; .ts stays the proven (webOS) path.
  const fmp4 = !!(p.hevc || p.av1)
  const video = [p.hevc && 'hevc', p.av1 && 'av1', 'h264'].filter(Boolean)
  // aac first: it is what Jellyfin transcodes to.
  const audio = stereo
    ? ['aac']
    : p.audio.filter((c) => fmp4 || TS_AUDIO.includes(c))
  const cond = (
    Property: string,
    Condition: string,
    Value: string | number,
  ) => ({
    Property,
    Condition,
    Value: String(Value),
    IsRequired: false,
  })
  const sdr = cond('VideoRangeType', 'EqualsAny', 'SDR') // HDR transcodes (tone-mapped)
  const depth = (main10?: boolean) =>
    cond('VideoBitDepth', 'LessThanEqual', main10 ? 10 : 8)
  // On every codec: the limit holds for a remux too (above it, transcode). A
  // codec not smooth at 2160p (#236) is capped at 1080p (every rung is ≤ that).
  const size = (c: Hd) => {
    const m = max ?? (c.hd ? QUALITY['1080p'] : null)
    return m
      ? [
          cond('Width', 'LessThanEqual', m.width),
          cond('Height', 'LessThanEqual', m.height),
        ]
      : []
  }
  return {
    MaxStreamingBitrate: Math.min(max?.bitrate ?? MAX_BITRATE, cap),
    DirectPlayProfiles: [], // always HLS over the tunnel
    TranscodingProfiles: [
      {
        Type: 'Video',
        Context: 'Streaming',
        Protocol: 'hls',
        Container: fmp4 ? 'mp4' : 'ts',
        VideoCodec: video.join(','),
        AudioCodec: audio.join(','),
        MaxAudioChannels: String(p.surround && !stereo ? 6 : 2),
        BreakOnNonKeyFrames: false,
      },
    ],
    CodecProfiles: [
      {
        Type: 'Video',
        Codec: 'h264',
        Conditions: [
          sdr,
          depth(),
          cond('VideoProfile', 'EqualsAny', p.h264.profiles.join('|')),
          cond('VideoLevel', 'LessThanEqual', p.h264.level),
          ...size(p.h264),
        ],
      },
      ...(p.hevc
        ? [
            {
              Type: 'Video',
              Codec: 'hevc',
              Conditions: [
                sdr,
                depth(p.hevc.main10),
                cond('VideoLevel', 'LessThanEqual', p.hevc.level),
                ...size(p.hevc),
              ],
            },
          ]
        : []),
      ...(p.av1
        ? [
            {
              Type: 'Video',
              Codec: 'av1',
              Conditions: [sdr, depth(p.av1.main10), ...size(p.av1)],
            },
          ]
        : []),
    ],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls' }], // text subs as WebVTT in HLS
  }
}

type Stream = {
  Index: number
  Type: string
  Codec?: string
  Channels?: number
  Width?: number
  Height?: number
  BitRate?: number
}

/** What Jellyfin will do with a TranscodingUrl, from its params (mirrors
 * EncodingHelper.CanStreamCopy*): video remux/transcode, audio copy/transcode,
 * and the TranscodeReasons. A quality limit (#108) puts MaxWidth/MaxHeight/
 * VideoBitrate in the URL but no reason, so `over` says which one it is. */
export function decision(url: string, streams: Stream[]) {
  const q = new URLSearchParams(url.split('?')[1])
  const has = (list: string | null, c?: string) =>
    !!c && (list ?? '').toLowerCase().split(',').includes(c.toLowerCase())
  const reasons = q.get('TranscodeReasons') ?? ''
  const v = streams.find((s) => s.Type === 'Video')
  const a = streams.find(
    (s) => s.Type === 'Audio' && String(s.Index) === q.get('AudioStreamIndex'),
  )
  const num = (k: string) => Number(q.get(k) ?? Infinity)
  const over = [
    (v?.Width ?? 0) > num('MaxWidth') && 'width',
    (v?.Height ?? 0) > num('MaxHeight') && 'height',
    // Jellyfin transcodes a source of unknown bitrate when one is set.
    (v?.BitRate ?? Infinity) > num('VideoBitrate') && 'bitrate',
  ].filter(Boolean)
  const videoCopy =
    !over.length &&
    q.get('allowVideoStreamCopy') !== 'false' &&
    has(q.get('VideoCodec'), v?.Codec) &&
    !/Video|ContainerBitrate|Interlaced|Anamorphic|RefFrames/.test(reasons)
  const audioCopy =
    q.get('allowAudioStreamCopy') !== 'false' &&
    has(q.get('AudioCodec'), a?.Codec) &&
    (a?.Channels ?? 0) <= Number(q.get('TranscodingMaxAudioChannels') ?? 99)
  const up = (c?: string) => c?.toUpperCase() ?? '?'
  return {
    videoCopy,
    audioCopy,
    reasons,
    /** "HEVC + DTS": the source codecs that play */
    codecs: `${up(v?.Codec)} + ${up(a?.Codec)}`,
    text: `video ${videoCopy ? 'remux' : 'transcode'} (${v?.Codec ?? '?'}) · audio ${audioCopy ? 'copy' : 'transcode'} (${a?.Codec ?? '?'} ${a?.Channels ?? '?'}ch, stream ${a?.Index ?? '?'}) · reasons ${reasons || 'none'}${over.length ? ` · over limit: ${over.join(',')} (${v?.Width}x${v?.Height}, ${v?.BitRate ?? '?'} bps)` : ''}`,
  }
}
