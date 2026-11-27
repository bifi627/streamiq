// The Photos page's decisions (Photos.tsx): which libraries hold photos, the
// viewer's previous / next, swipes and image sizes. No DOM: node --test.
import type { Item } from '../library/items.ts'

/** Jellyfin's "Home videos & photos" libraries. */
export const isPhotoLibrary = (i: Item) => i.CollectionType === 'homevideos'

export const photoLibraries = (views: Item[] = []) =>
  views.filter(isPhotoLibrary)

/** The Library home's libraries: the photo ones have their own tab. */
export const videoLibraries = (views: Item[]) =>
  views.filter((i) => !isPhotoLibrary(i))

export const isPhoto = (i: Item) => i.Type === 'Photo'

/** Where previous / next leads from `id` among the loaded photos: another
 * photo, `more` (past the last loaded one while the folder has more pages:
 * load the next page and ask again), or nothing (the first or the last). */
export function step(
  photos: Item[],
  id: string,
  dir: -1 | 1,
  hasMore: boolean,
): { to: string } | 'more' | null {
  const i = photos.findIndex((p) => p.Id === id)
  if (i < 0) return null
  const to = photos[i + dir]
  if (to) return { to: to.Id }
  return dir === 1 && hasMore ? 'more' : null
}

/** A swipe's direction, by finger travel in px: left = next (1), right =
 * previous (-1); a short or mostly vertical one is none (0). */
export function swipe(dx: number, dy: number) {
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

/** The viewer's image size: the screen in device pixels, not the original. */
export const screenSize = (w: number, h: number, dpr: number) => ({
  width: Math.round(w * dpr),
  height: Math.round(h * dpr),
})

/** The viewer's caption: the photo's name. Never its Overview: Jellyfin puts
 * a JPEG's comment there (camera firmware, encoder tags). */
export const caption = (i: Item) => i.Name

/** What a key does in the viewer: step, close, or `stay` (an arrow that
 * must not move focus to the grid behind it); null = not the viewer's. */
export function viewerKey(key: string): -1 | 1 | 'close' | 'stay' | null {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  if (key === 'Escape') return 'close'
  return key === 'ArrowUp' || key === 'ArrowDown' ? 'stay' : null
}
