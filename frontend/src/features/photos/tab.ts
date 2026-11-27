import { skipToken, useQuery } from '@tanstack/react-query'
import type { Item } from '../library/items'
import { userViews } from '../library/jellyfin'
import { photoLibraries } from './gallery'

/** Whether the gateway's libraries, as last loaded over its tunnel, include a
 * photo one: the nav's Photos tab. The shell has no tunnel, so it reads the
 * library's cached user views (useTunnelQuery's key) and never fetches. */
export function useHasPhotos(gatewayId: string | null) {
  const views = useQuery<{ Items: Item[] }>({
    queryKey: ['tunnel', gatewayId, userViews],
    queryFn: skipToken,
  }).data
  return photoLibraries(views?.Items).length > 0
}
