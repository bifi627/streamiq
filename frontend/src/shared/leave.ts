// Leaving the account or household: the artwork caches go
// (features/library/art.ts keeps them), then the page reloads.
import { event } from './diag'
export const ART_PREFIX = 'streamiq-art-'

let clearing = false
/** True once a clear started: art.ts then neither opens nor fills a cache. */
export const artCleared = () => clearing

/** Deletes every artwork cache, then runs go: at once if the Cache API is
 *  missing or blocked, after 1 s at most if it is slow or hangs. */
export function clearArtThen(go: () => void) {
  clearing = true
  const clear = (async () => {
    const c = caches // throws without the Cache API (plain http)
    const names = (await c.keys()).filter((k) => k.startsWith(ART_PREFIX))
    await Promise.all(names.map((k) => c.delete(k)))
  })()
  // ponytail: a hung clear leaves the caches to the next sign-out; the reload wins.
  Promise.race([clear, new Promise((r) => setTimeout(r, 1000))])
    .catch((e) => event(`sign-out: cache clear failed: ${e}`))
    .finally(go)
}
