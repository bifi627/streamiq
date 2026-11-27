// Every Jellyfin request the web client makes. Mirrors the gateway allowlist
// (gateway/internal/tunnel/jellyfin.go): a path missing there is a 403.
// HLS playlists come from PlaybackInfo's TranscodingUrl, not from here.
import type { Item } from './items'
import { PAGE } from './paging.ts'

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

/** GET /Items: one page of a folder's children. */
export const children = (parentId: string, startIndex: number) =>
  `/Items?parentId=${parentId}&sortBy=SortName&startIndex=${startIndex}&limit=${PAGE}`

/** GET /Items: a page of all movies and episodes with their streams (the
 * transcode report); MediaSources carries them, so not MediaStreams too. */
export const allVideos = (start: number, limit: number) =>
  `/Items?recursive=true&includeItemTypes=Movie,Episode&isMissing=false&fields=MediaSources&enableImages=false&enableUserData=false&sortBy=SortName&startIndex=${start}&limit=${limit}`

/** GET /Items: one page of movies, series and episodes matching a search term. */
export const search = (term: string) =>
  `/Items?searchTerm=${encodeURIComponent(term)}&recursive=true&includeItemTypes=Movie,Series,Episode&isMissing=false&limit=${PAGE}`

/** GET /UserItems/Resume: Continue watching. */
export const resume = '/UserItems/Resume?mediaTypes=Video&limit=4'

export const item = (id: string) => `/Items/${id}`

export const seasons = (seriesId: string) => `/Shows/${seriesId}/Seasons`

/** GET /Shows/{id}/Episodes: all of a series' episodes. */
export const episodes = (seriesId: string) => `/Shows/${seriesId}/Episodes`

/** GET /Shows/{id}/Episodes: this episode and the one after it;
 * isMissing=false: no episode Jellyfin lists without a file. */
export const nextEpisodes = (seriesId: string, itemId: string) =>
  `/Shows/${seriesId}/Episodes?startItemId=${itemId}&limit=2&isMissing=false`

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

export const subtitle = (id: string, source: string, index: number) =>
  `/Videos/${id}/${source}/Subtitles/${index}/0/Stream.vtt`
