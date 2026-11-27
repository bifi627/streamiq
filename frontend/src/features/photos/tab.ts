import { useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Item } from '../library/items'
import { userViews } from '../library/jellyfin'
import { photoLibraries } from './gallery'

/** Whether the gateway's libraries, as last loaded over its tunnel, include a
 * photo one: the nav's Photos tab. The shell has no tunnel, so it reads the
 * library's cached user views (useTunnelQuery's key) without observing the
 * query: an observer without a queryFn would replace the library's. */
export function useHasPhotos(gatewayId: string | null) {
  const cache = useQueryClient().getQueryCache()
  const views = useSyncExternalStore(
    (on) => cache.subscribe(on),
    () =>
      cache.find<{ Items: Item[] }>({
        queryKey: ['tunnel', gatewayId, userViews],
      })?.state.data,
  )
  return photoLibraries(views?.Items).length > 0
}
