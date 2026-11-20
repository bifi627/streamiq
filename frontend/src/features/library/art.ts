// Artwork over the tunnel: an image loads only once its box is on
// screen, and is kept on the device in the Cache API (one cache per gateway),
// so a revisit doesn't fetch it through the tunnel again. The placeholder box
// keeps its size (index.css `.art`) until the image arrives.
import { createContext, useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Item } from './items'
import { image } from './jellyfin'
import { tunnelFetch, tunnelJson } from '../../tunnel'
import { ART_PREFIX, artCleared } from '../../leave'
import { queryClient } from '../../query'
import type { Speed } from '../../speed'

// The gateway's shared tunnel session (Library.tsx GatewayLibrary).
export const Tunnel = createContext<{
  gatewayId: string
  pc: RTCPeerConnection
  speed?: Speed
}>(null!)

export type Art = { id: string; type: 'Primary' | 'Backdrop'; tag: string }

const CAP = 500 // ponytail: entry cap per gateway, oldest out first; a byte budget if images grow
const TRIM_EVERY = 50 // puts between cap checks (+ the first): up to 49 over CAP
const puts = new Map<string, number>()
// Cache API: secure contexts only (https, localhost); without it, no cache.
// None either once a sign-out or household switch cleared them (leave.ts).
const store = () =>
  typeof caches === 'undefined' || artCleared() ? null : caches

/** Playback per gateway: when it started (cached data from before may
 * predate its progress) and, once the player is left, its exit save, which
 * every read for that gateway waits for. The player (engine.ts) sets it. */
export const playback = new Map<
  string,
  { at: number; saved?: Promise<unknown> }
>()

/** Whether a query's data is newer than the gateway's last playback start. */
export const current = (gatewayId: string, dataUpdatedAt: number) =>
  dataUpdatedAt > (playback.get(gatewayId)?.at ?? 0)

/** A library read over the tunnel, cached per gateway: keyed by
 * gatewayId, not pc (a reconnect keeps the data), the current pc fetches it.
 * Fresh 5 min, then shown at once and refetched. url null = not yet. */
export function useTunnelQuery<T>(url: string | null) {
  const { gatewayId, pc } = useContext(Tunnel)
  return useQuery({
    queryKey: ['tunnel', gatewayId, url],
    queryFn: async () => {
      await playback.get(gatewayId)?.saved // else it reads the old progress
      return tunnelJson<T>(pc, url!)
    },
    enabled: url !== null,
    staleTime: 5 * 60_000,
    gcTime: Infinity, // ponytail: kept until reload; KBs per screen. A cap if a TV tab grows
  })
}

/** A page of Jellyfin items over the tunnel. */
export const items = (pc: RTCPeerConnection, url: string) =>
  tunnelJson<{ Items: Item[] }>(pc, url).then((p) => p.Items)

// ponytail: at most 4 image channels in flight.
let active = 0
const waiting: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>) {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

export async function load(
  pc: RTCPeerConnection,
  gatewayId: string,
  a: Art,
  width: number,
) {
  // Keyed by item + image type + size + Jellyfin's image tag (a new image = a new tag).
  const key = `/art/${a.id}/${a.type}/${width}/${a.tag}`
  const cache = await store()
    ?.open(ART_PREFIX + gatewayId)
    .catch(() => undefined)
  const hit = await cache?.match(key).catch(() => undefined)
  if (hit) return hit.blob()
  const r = await limited(() =>
    tunnelFetch(pc, image(a.id, a.type, width, a.tag)),
  )
  if (r.status !== 200) return null
  const blob = new Blob([r.body], { type: r.headers['Content-Type'] })
  if (cache && !artCleared()) {
    const n = (puts.get(gatewayId) ?? 0) + 1
    puts.set(gatewayId, n)
    cache
      .put(key, new Response(blob))
      .then(async () => {
        if (n > 1 && n % TRIM_EVERY) return // and once per page load
        const keys = await cache.keys()
        await Promise.all(
          keys
            .slice(0, Math.max(0, keys.length - CAP))
            .map((k) => cache.delete(k)),
        )
      })
      .catch(() => {}) // full or blocked: shown anyway, just not kept
  }
  return blob
}

/** An image's object URL (null: none), loaded once enabled. Immutable per
 * tag, so never refetched; dropped with its last view (the Cache API keeps it). */
export function useArt(a: Art | null, width: number, enabled: boolean) {
  const { gatewayId, pc } = useContext(Tunnel)
  return useQuery({
    queryKey: ['art', gatewayId, a?.id, a?.type, a?.tag, width],
    queryFn: async () => {
      const b = await load(pc, gatewayId, a!, width)
      return b && URL.createObjectURL(b)
    },
    enabled: enabled && !!a,
    staleTime: Infinity,
    gcTime: 0,
  })
}

queryClient.getQueryCache().subscribe((e) => {
  if (
    e.type === 'removed' &&
    e.query.queryKey[0] === 'art' &&
    e.query.state.data
  )
    URL.revokeObjectURL(e.query.state.data as string)
})

export const primary = (i: Item): Art | null =>
  i.ImageTags?.Primary
    ? { id: i.Id, type: 'Primary', tag: i.ImageTags.Primary }
    : null

/** The item's backdrop, else its series' (episodes have none of their own). */
export const backdrop = (i: Item): Art | null =>
  i.BackdropImageTags?.[0]
    ? { id: i.Id, type: 'Backdrop', tag: i.BackdropImageTags[0] }
    : i.ParentBackdropItemId && i.ParentBackdropImageTags?.[0]
      ? {
          id: i.ParentBackdropItemId,
          type: 'Backdrop',
          tag: i.ParentBackdropImageTags[0],
        }
      : null
