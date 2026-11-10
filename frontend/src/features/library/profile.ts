/// <reference lib="dom" /> -- probe() is DOM; node --test imports the rest
// Client capability probe → Jellyfin DeviceProfile (#115). Jellyfin decides
// per playback, from this profile, whether video is remuxed or transcoded and
// whether audio is copied; it says why in TranscodeReasons. Re-probed at each
// playback start (milliseconds, no storage). TVs over-report (#81), so the
// player keeps its runtime fallbacks. Pure except probe() (node --test imports
// this file).

export type Probe = {
  /** H.264 profiles (Jellyfin names) + highest level, e.g. 51 = 5.1 */
  h264: { profiles: string[]; level: number } | null
  /** HEVC Main; level in Jellyfin units (level × 30, e.g. 153 = 5.1) */
  hevc: { level: number; main10: boolean } | null
  av1: { main10: boolean } | null
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
  return {
    h264: profiles.length && h264Level ? { profiles, level: h264Level } : null,
    hevc: hevcLevel
      ? { level: hevcLevel, main10: ok('hvc1.2.4.L153.B0') }
      : null,
    av1: ok('av01.0.08M.08') ? { main10: ok('av01.0.08M.10') } : null,
    // Probed muxed with H.264: fMP4 plays from one audiovideo SourceBuffer, and
    // webOS says yes to audio/mp4 ac-3 alone but no to video/mp4 avc1+ac-3.
    audio: Object.keys(AUDIO).filter((c) => ok(`avc1.42E01E,${AUDIO[c]}`)),
    surround,
  }
}

export const describe = (p: Probe) =>
  [
    `h264 ${p.h264 ? `${p.h264.profiles.join('/')} L${p.h264.level / 10}` : 'no'}`,
    `hevc ${p.hevc ? `L${p.hevc.level / 30}${p.hevc.main10 ? ' 10bit' : ''}` : 'no'}`,
    `av1 ${p.av1 ? (p.av1.main10 ? '10bit' : '8bit') : 'no'}`,
    `audio ${p.audio.join(',') || 'none'}`,
    p.surround ? '5.1' : 'stereo',
  ].join(' · ')

// Jellyfin plays only these audio codecs in HLS .ts (StreamBuilder).
const TS_AUDIO = ['aac', 'ac3', 'eac3', 'mp3']

// ponytail: fixed 120 Mbps ceiling (≈ jellyfin-web's), so sources remux at any
// realistic bitrate; #108 sets this from the quality picker.
const MAX_BITRATE = 120_000_000

// Compatible mode (#113) caps: they hold even for a remux (Jellyfin transcodes
// anything above them).
const COMPATIBLE = { bitrate: 8_000_000, width: 1920, height: 1080 }

/** The DeviceProfile for PlaybackInfo. stereo = the audio fallback: AAC 2.0
 * only. compatible = the most restrictive profile (#113): H.264 only, stereo
 * AAC, .ts, 1080p / 8 Mbps. Throws when there is no H.264 (the one transcode
 * target). */
export function deviceProfile(
  probed: Probe,
  stereo = false,
  compatible = false,
) {
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
  return {
    MaxStreamingBitrate: compatible ? COMPATIBLE.bitrate : MAX_BITRATE,
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
          ...(compatible
            ? [
                cond('Width', 'LessThanEqual', COMPATIBLE.width),
                cond('Height', 'LessThanEqual', COMPATIBLE.height),
              ]
            : []),
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
              ],
            },
          ]
        : []),
      ...(p.av1
        ? [
            {
              Type: 'Video',
              Codec: 'av1',
              Conditions: [sdr, depth(p.av1.main10)],
            },
          ]
        : []),
    ],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls' }], // text subs as WebVTT in HLS
  }
}

type Stream = { Index: number; Type: string; Codec?: string; Channels?: number }

/** What Jellyfin will do with a TranscodingUrl, from its params (mirrors
 * EncodingHelper.CanStreamCopy*): video remux/transcode, audio copy/transcode,
 * and the TranscodeReasons. */
export function decision(url: string, streams: Stream[]) {
  const q = new URLSearchParams(url.split('?')[1])
  const has = (list: string | null, c?: string) =>
    !!c && (list ?? '').toLowerCase().split(',').includes(c.toLowerCase())
  const reasons = q.get('TranscodeReasons') ?? ''
  const v = streams.find((s) => s.Type === 'Video')
  const a = streams.find(
    (s) => s.Type === 'Audio' && String(s.Index) === q.get('AudioStreamIndex'),
  )
  const videoCopy =
    q.get('allowVideoStreamCopy') !== 'false' &&
    has(q.get('VideoCodec'), v?.Codec) &&
    !/Video|ContainerBitrate|Interlaced|Anamorphic|RefFrames/.test(reasons)
  const audioCopy =
    q.get('allowAudioStreamCopy') !== 'false' &&
    has(q.get('AudioCodec'), a?.Codec) &&
    (a?.Channels ?? 0) <= Number(q.get('TranscodingMaxAudioChannels') ?? 99)
  return {
    videoCopy,
    audioCopy,
    reasons,
    text: `video ${videoCopy ? 'remux' : 'transcode'} (${v?.Codec ?? '?'}) · audio ${audioCopy ? 'copy' : 'transcode'} (${a?.Codec ?? '?'} ${a?.Channels ?? '?'}ch) · reasons ${reasons || 'none'}`,
  }
}
