// Jellyfin item shape (the fields the UI reads) + pure helpers (no DOM, so
// node --test can import this file).
export type Item = {
  Id: string
  Name: string
  Type: string
  IsFolder?: boolean
  SeriesId?: string
  SeriesName?: string
  SeasonId?: string
  ParentId?: string
  RunTimeTicks?: number
  ProductionYear?: number
  Overview?: string
  Genres?: string[]
  IndexNumber?: number
  ParentIndexNumber?: number
  ImageTags?: { Primary?: string }
  BackdropImageTags?: string[]
  ParentBackdropItemId?: string
  ParentBackdropImageTags?: string[]
  UserData?: { PlaybackPositionTicks?: number; Played?: boolean }
  MediaSources?: {
    Id?: string
    Bitrate?: number
    DefaultAudioStreamIndex?: number
  }[]
  MediaStreams?: {
    Index: number
    Type: string
    Codec?: string
    Channels?: number
    Width?: number
    Height?: number
    BitRate?: number
    Language?: string
    Title?: string
    IsTextSubtitleStream?: boolean
  }[]
}

/** The series page's primary button: the in-progress episode, else
 * the first unwatched one, else the first one (specials last both times).
 * Jellyfin's NextUp is not on the gateway allowlist, so this reads the
 * episodes' user data. */
export function upNext(episodes: Item[]) {
  const started = episodes.find(
    (e) => !e.UserData?.Played && (e.UserData?.PlaybackPositionTicks ?? 0) > 0,
  )
  const unwatched = episodes.filter((e) => !e.UserData?.Played)
  return (
    started ??
    unwatched.find((e) => e.ParentIndexNumber !== 0) ??
    unwatched[0] ??
    episodes.find((e) => e.ParentIndexNumber !== 0) ??
    episodes[0]
  )
}

/** A tile opens the player, not a page: an episode (its Play on… is on the
 * series page). A movie or other video has its page with Play / Resume and
 * Play on…. The Resume spot plays at once regardless. */
export const playsAtOnce = (i: Item) => i.Type === 'Episode'

/** Opens in the player, not as a listing. */
export const playable = (i: Item) =>
  !i.IsFolder && i.Type !== 'Series' && i.Type !== 'Season'

type Stream = NonNullable<Item['MediaStreams']>[number]

const lang = (code?: string) => {
  if (!code || code === 'und') return undefined
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(code)
  } catch {
    return code // not a language code Intl knows
  }
}

/** The audio menu's options: language (browser locale) + title, the
 * codec and channels as the hint. */
export function audioTracks(streams: Stream[] = []) {
  const layout = (n?: number) =>
    n === 1 ? 'mono' : n === 2 ? 'stereo' : n ? `${n - 1}.1` : ''
  return streams
    .filter((s) => s.Type === 'Audio')
    .map((s, i) => ({
      value: String(s.Index),
      label:
        [lang(s.Language), s.Title].filter(Boolean).join(' · ') ||
        `Track ${i + 1}`,
      hint: [s.Codec?.toUpperCase(), layout(s.Channels)]
        .filter(Boolean)
        .join(' '),
    }))
}

/** The subtitle menu's options: Off, then each text subtitle (image
 * subtitles need burn-in: out of scope), labelled like the audio menu. */
export function subtitleTracks(streams: Stream[] = []) {
  return [
    { value: '-1', label: 'Off' },
    ...streams
      .filter((s) => s.Type === 'Subtitle' && s.IsTextSubtitleStream)
      .map((s, i) => ({
        value: String(s.Index),
        label:
          [lang(s.Language), s.Title].filter(Boolean).join(' · ') ||
          `Track ${i + 1}`,
        hint: (s.Codec === 'subrip' ? 'srt' : (s.Codec ?? '')).toUpperCase(),
      })),
  ]
}

export const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** hls.js ranges have an exclusive end; HTTP Range's end is inclusive. */
export function rangeHeader(start?: number, end?: number) {
  if (start == null && end == null) return undefined
  return `bytes=${start ?? 0}-${end ? end - 1 : ''}`
}

/** Jellyfin time unit: 100 ns ticks. */
export const TICKS_PER_SECOND = 10_000_000

const minutes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'minute',
  unitDisplay: 'short',
})
const toMinutes = (ticks: number) => ticks / TICKS_PER_SECOND / 60
const position = (i: Item) => i.UserData?.PlaybackPositionTicks ?? 0

/** "42 min", or '' without a runtime. */
export const runtime = (i: Item) =>
  i.RunTimeTicks ? minutes.format(Math.round(toMinutes(i.RunTimeTicks))) : ''

/** "12 min left" (at least 1), or '' without a runtime. */
export const timeLeft = (i: Item) =>
  i.RunTimeTicks
    ? `${minutes.format(Math.max(1, Math.round(toMinutes(i.RunTimeTicks - position(i)))))} left`
    : ''

/** Started and not watched to the end. */
export const inProgress = (i: Item) => !i.UserData?.Played && position(i) > 0

/** An episode row's state: 'Watched', the time left once started, else ''. */
export const progress = (i: Item) =>
  i.UserData?.Played ? 'Watched' : inProgress(i) ? timeLeft(i) : ''

/** What the item page shows: the item, or for a season its series on that
 * season's tab; null while the series loads. */
export function pageItem(item: Item, series?: Item) {
  if (item.Type !== 'Season' || !item.SeriesId) return { item }
  return series ? { item: series, season: item.Id } : null
}

/** Video appends in a row that may leave the playhead without video before
 * the player gives up on stream copy (webOS drops stream-copied open-GOP
 * h264 after a seek/resume; the appends "succeed" but buffer nothing). */
export const STUCK_APPENDS = 4

type Ranges = {
  length: number
  start(i: number): number
  end(i: number): number
}

/** Whether a (video) buffered range covers t. 1 s slack: a fragment's first
 * frame can land just after the requested position. */
export const covers = (r: Ranges | undefined, t: number) =>
  !!r &&
  Array.from({ length: r.length }).some(
    (_, i) => r.start(i) - 1 <= t && t <= r.end(i) + 1,
  )

/** The remote's Back: Escape, GoBack/BrowserBack, webOS 461. */
export const isBack = (e: KeyboardEvent) =>
  e.key === 'Escape' ||
  e.key === 'GoBack' ||
  e.key === 'BrowserBack' ||
  e.keyCode === 461 // webOS remote

/** A folder's Back without in-app history: its parent folder, or null for
 * the library home (a library's own parent is Jellyfin's hidden root). */
export const folderUp = (i: Item) =>
  i.Type === 'CollectionFolder' || i.Type === 'UserView'
    ? null
    : (i.ParentId ?? null)

/** The title page's info line: year · runtime (a series: its season count) ·
 * the first genre; what's missing is left out. */
export function titleInfo(item: Item, seasons?: number) {
  const length =
    item.Type === 'Series'
      ? seasons && `${seasons} ${seasons === 1 ? 'season' : 'seasons'}`
      : runtime(item)
  return [item.ProductionYear, length, item.Genres?.[0]]
    .filter(Boolean)
    .join(' · ')
}

/** The title page's play label for the item it plays: "Play", or "Resume"
 * with progress; an episode adds "· S1 · E3". */
export function playLabel(next: Item) {
  const resumes =
    !next.UserData?.Played && (next.UserData?.PlaybackPositionTicks ?? 0) > 0
  const verb = resumes ? 'Resume' : 'Play'
  return next.Type === 'Episode'
    ? `${verb} · S${next.ParentIndexNumber ?? '?'} · E${next.IndexNumber ?? '?'}`
    : verb
}
