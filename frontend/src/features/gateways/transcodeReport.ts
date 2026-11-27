// The transcode report's decisions: which library items some paired
// client would transcode. Each client's verdict runs the item through the
// DeviceProfile the player would send for it at Source quality, so the report
// and the player can't drift apart. ponytail: deviceProfile's conditions, not
// Jellyfin's StreamBuilder: container bitrate, interlacing, ref frames and
// image subtitles aren't seen; PlaybackInfo per item × client if that matters.
import { autoAudio, deviceProfile } from '../player/profile.ts'
import type { Item } from '../library/items.ts'
import type { Client } from '../../generated/pairing.ts'

type Stream = NonNullable<Item['MediaStreams']>[number]
type Profile = ReturnType<typeof deviceProfile>
type Cond = { Property: string; Condition: string; Value: string }

const VIDEO_PROPS: Record<string, (s: Stream) => string | number | undefined> =
  {
    VideoRangeType: (s) => s.VideoRangeType,
    VideoBitDepth: (s) => s.BitDepth,
    VideoProfile: (s) => s.Profile,
    VideoLevel: (s) => s.Level,
    Width: (s) => s.Width,
    Height: (s) => s.Height,
  }

// An unknown value passes, as in Jellyfin (IsRequired: false).
function holds(c: Cond, s: Stream) {
  const v = VIDEO_PROPS[c.Property]?.(s)
  if (v === undefined) return true
  if (c.Condition === 'EqualsAny')
    return c.Value.toLowerCase().split('|').includes(String(v).toLowerCase())
  return Number(v) <= Number(c.Value) // LessThanEqual, the only other one used
}

const DETAIL: Record<string, (s: Stream) => string> = {
  VideoRangeType: (s) => s.VideoRangeType ?? 'HDR',
  VideoBitDepth: (s) => `${s.BitDepth}-bit`,
  VideoProfile: (s) => s.Profile ?? '',
  VideoLevel: (s) => `level ${s.Level}`,
  Width: (s) => `${s.Width}×${s.Height}`,
  Height: (s) => `${s.Width}×${s.Height}`,
}

/** "video: HEVC 10-bit" when p transcodes v, else null. bitrate = the source's. */
export function videoReason(p: Profile, v: Stream, bitrate?: number) {
  const codec = (v.Codec ?? '?').toLowerCase()
  const name = `video: ${codec.toUpperCase()}`
  if (!p.TranscodingProfiles[0].VideoCodec.split(',').includes(codec))
    return name
  const conds: Cond[] =
    p.CodecProfiles.find((c) => c.Codec === codec)?.Conditions ?? []
  const failed = [
    ...new Set(
      conds.filter((c) => !holds(c, v)).map((c) => DETAIL[c.Property](v)),
    ),
  ]
  if (bitrate && bitrate > p.MaxStreamingBitrate)
    failed.push(`over ${p.MaxStreamingBitrate / 1e6} Mbps`)
  return failed.length ? `${name} ${failed.join(' ')}` : null
}

const channels = (n?: number) =>
  n === 6
    ? '5.1'
    : n === 8
      ? '7.1'
      : n === 2
        ? 'stereo'
        : n === 1
          ? 'mono'
          : `${n ?? '?'}ch`

/** "audio: DTS 5.1" when p transcodes the audio the player would pick, else
 * null: the default track, or autoAudio's pick when the default doesn't decode. */
export function audioReason(p: Profile, streams: Stream[], def?: number) {
  const tp = p.TranscodingProfiles[0]
  const codecs = tp.AudioCodec.split(',')
  const max = Number(tp.MaxAudioChannels)
  const audio = streams.filter((s) => s.Type === 'Audio')
  const d = audio.find((s) => s.Index === def) ?? audio[0]
  if (!d) return null
  const fits =
    codecs.includes(d.Codec?.toLowerCase() ?? '') && (d.Channels ?? 0) <= max
  if (fits || autoAudio(streams, def, codecs, max > 2) !== undefined)
    return null
  return `audio: ${(d.Codec ?? '?').toUpperCase()} ${channels(d.Channels)}`
}

/** What client c would transcode of item i: its reasons, none = plays as is. */
export function reasons(p: Profile, i: Item) {
  const src = i.MediaSources?.[0]
  const streams = i.MediaStreams ?? []
  const v = streams.find((s) => s.Type === 'Video')
  return [
    v && videoReason(p, v, src?.Bitrate),
    audioReason(p, streams, src?.DefaultAudioStreamIndex),
  ].filter((r): r is string => !!r)
}

export type Row = {
  id: string
  name: string
  /** a series: its episodes that need a transcode, of all of them */
  episodes?: { n: number; of: number }
  /** reason → the clients it applies to, video reasons first */
  reasons: { text: string; clients: string[] }[]
}

type Profiled = { name: string; profile: Profile }

/** The probed clients' profiles (a probe without H.264 plays nothing, so it
 * is left out) and the names of the clients never probed. */
export function profiled(clients: Client[]) {
  const out: Profiled[] = []
  const notProbed: string[] = []
  for (const c of clients) {
    if (!c.profile) notProbed.push(c.name)
    else if (c.profile.probe.h264)
      out.push({
        name: c.name,
        profile: deviceProfile(
          c.profile.probe,
          false,
          c.profile.compatible,
          'Source',
        ),
      })
  }
  return { clients: out, notProbed }
}

/** The report: one row per movie and per series that some client transcodes,
 * the ones with a video transcode first, then by name. */
export function report(items: Item[], clients: Profiled[]): Row[] {
  const rows = new Map<
    string,
    Row & { all: number; found: Map<string, Set<string>> }
  >()
  for (const i of items) {
    const key = i.Type === 'Episode' && i.SeriesId ? i.SeriesId : i.Id
    const row = rows.get(key) ?? {
      id: key,
      name: key === i.Id ? i.Name : (i.SeriesName ?? i.Name),
      reasons: [],
      all: 0,
      found: new Map(),
      ...(key === i.Id ? {} : { episodes: { n: 0, of: 0 } }),
    }
    rows.set(key, row)
    let any = false
    for (const c of clients)
      for (const r of reasons(c.profile, i)) {
        any = true
        row.found.set(r, (row.found.get(r) ?? new Set()).add(c.name))
      }
    if (row.episodes) {
      row.episodes.of++
      if (any) row.episodes.n++
    }
  }
  const video = (r: Row) => r.reasons.some((x) => x.text.startsWith('video'))
  return [...rows.values()]
    .filter((r) => r.found.size)
    .map(({ id, name, episodes, found }) => ({
      id,
      name,
      ...(episodes ? { episodes } : {}),
      reasons: [...found]
        .map(([text, cs]) => ({ text, clients: [...cs].sort() }))
        .sort((a, b) => b.text.localeCompare(a.text)), // "video" before "audio"
    }))
    .sort(
      (a, b) =>
        Number(video(b)) - Number(video(a)) || a.name.localeCompare(b.name),
    )
}

/** The report's status line; null = the rows (or its empty line). */
export function reportNote(o: {
  admin: boolean
  probed: number
  error: string | null
  loaded: boolean
}) {
  if (!o.admin) return 'Only admins can see this.'
  if (o.error) return o.error
  if (!o.loaded) return 'loading…'
  if (!o.probed)
    return 'No paired client has played anything yet, so none has a profile to check against.'
  return null
}

/** "12 of 24 episodes" */
export const episodesLine = (e: { n: number; of: number }) =>
  `${e.n.toLocaleString()} of ${e.of.toLocaleString()} episodes`
