// Every Jellyfin request the web client makes (#557): one path builder per
// endpoint. Mirrors the gateway allowlist in gateway/internal/tunnel/jellyfin.go:
// a new endpoint goes on both, or the gateway refuses it (403).
// check.sh (scripts/check-jellyfin-paths.sh) fails on a Jellyfin path elsewhere in frontend/src.
// The /Videos/{id}/… HLS playlists come from PlaybackInfo's TranscodingUrl, not from here.
import type { Item } from './items'

/** GET /System/Info/Public: the pairing page's test request. */
export const systemInfo = '/System/Info/Public'
export type SystemInfo = {
  ServerName?: string
  Version?: string
  ProductName?: string
}

/** GET /UserViews: the libraries. */
export const userViews = '/UserViews'

/** GET /Items: the 16 most recently added movies and series. */
export const recentlyAdded =
  '/Items?sortBy=DateCreated&sortOrder=Descending&recursive=true&includeItemTypes=Movie,Series&limit=16'

/** GET /Items: a folder's children. */
export const children = (parentId: string) =>
  `/Items?parentId=${parentId}&sortBy=SortName`

/** GET /UserItems/Resume: Continue watching. */
export const resume = '/UserItems/Resume?mediaTypes=Video&limit=4'

/** GET /Items/{id}: one item. */
export const item = (id: string) => `/Items/${id}`

/** GET /Shows/{id}/Seasons. */
export const seasons = (seriesId: string) => `/Shows/${seriesId}/Seasons`

/** GET /Shows/{id}/Episodes: all of a series' episodes. */
export const episodes = (seriesId: string) => `/Shows/${seriesId}/Episodes`

/** GET /Shows/{id}/Episodes: this episode and the one after it (#344);
 * isMissing=false: no episode Jellyfin lists without a file (#337). */
export const nextEpisodes = (seriesId: string, itemId: string) =>
  `/Shows/${seriesId}/Episodes?startItemId=${itemId}&limit=2&isMissing=false`

/** GET /Items/{id}/Images/{type}. */
export const image = (id: string, type: string, width: number, tag: string) =>
  `/Items/${id}/Images/${type}?maxWidth=${width}&tag=${tag}`

/** POST /Items/{id}/PlaybackInfo: the stream to play, for a DeviceProfile. */
export const playbackInfo = (id: string) => `/Items/${id}/PlaybackInfo`
export type PlaybackInfo = {
  ErrorCode?: string
  MediaSources: {
    Id: string
    TranscodingUrl?: string
    Bitrate?: number
    MediaStreams: NonNullable<Item['MediaStreams']>
  }[]
}

/** POST /UserItems/{id}/UserData: resume position / played. */
export const userData = (id: string) => `/UserItems/${id}/UserData`

/** GET /Videos/{id}/{source}/Subtitles/{index}/0/Stream.vtt: a text subtitle. */
export const subtitle = (id: string, source: string, index: number) =>
  `/Videos/${id}/${source}/Subtitles/${index}/0/Stream.vtt`
