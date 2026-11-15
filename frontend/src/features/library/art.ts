// Artwork over the tunnel (#203): an image loads only once its box is on
// screen, and is kept on the device in the Cache API (one cache per gateway),
// so a revisit doesn't fetch it through the tunnel again. The placeholder box
// keeps its size (index.css `.art`) until the image arrives.
import { createContext } from 'react'
import type { Item } from './items'
import { tunnelFetch } from '../../tunnel'
import type { Speed } from '../../speed'

// The gateway's shared tunnel session (Library.tsx GatewayLibrary).
export const Tunnel = createContext<{
  gatewayId: string
  pc: RTCPeerConnection
  speed?: Speed
}>(null!)

export type Art = { id: string; type: 'Primary' | 'Backdrop'; tag: string }

const PREFIX = 'streamiq-art-'
const CAP = 500 // ponytail: entry cap per gateway, oldest out first; a byte budget if images grow
// Cache API: secure contexts only (https, localhost); without it, no cache.
const store = () => (typeof caches === 'undefined' ? null : caches)

/** Deletes every gateway's artwork cache: on sign-out and a household switch. */
export async function clearArt() {
  const c = store()
  if (!c) return
  try {
    const names = (await c.keys()).filter((k) => k.startsWith(PREFIX))
    await Promise.all(names.map((k) => c.delete(k)))
  } catch {
    /* storage blocked: nothing was cached either */
  }
}

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
    ?.open(PREFIX + gatewayId)
    .catch(() => undefined)
  const hit = await cache?.match(key).catch(() => undefined)
  if (hit) return hit.blob()
  const r = await limited(() =>
    tunnelFetch(
      pc,
      `/Items/${a.id}/Images/${a.type}?maxWidth=${width}&tag=${a.tag}`,
    ),
  )
  if (r.status !== 200) return null
  const blob = new Blob([r.body], { type: r.headers['Content-Type'] })
  cache
    ?.put(key, new Response(blob))
    .then(() => cache.keys())
    .then((keys) =>
      Promise.all(
        keys
          .slice(0, Math.max(0, keys.length - CAP))
          .map((k) => cache.delete(k)),
      ),
    )
    .catch(() => {}) // full or blocked: shown anyway, just not kept
  return blob
}

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
