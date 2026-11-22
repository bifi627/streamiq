/** What the policy depends on: the build's VITE_ settings and whether it's `vite dev`. */
export type CspInput = {
  dev: boolean
  api?: string // VITE_API_URL; unset = same origin
  emulator?: string // VITE_FIREBASE_AUTH_EMULATOR
  authDomain: string
}

const origin = (url: string) => new URL(url).origin
const wsOrigin = (url: string) => origin(url).replace(/^http/, 'ws')

/** The web app's Content-Security-Policy: vite.config.ts sends it from `vite dev` and
 * `vite preview` and writes the build's into csp.txt, which the API serves (front.go). */
export function csp({ dev, api, emulator, authDomain }: CspInput): string {
  const extra = (...urls: (string | false | undefined)[]) =>
    urls.filter((u): u is string => !!u)
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      // Firebase's popup sign-in loads Google's gapi, also against the emulator.
      'https://apis.google.com',
      // Vite dev's React refresh preamble is an inline script.
      ...extra(dev && "'unsafe-inline'"),
    ],
    // Vite dev injects CSS as <style> tags; the build links files.
    'style-src': ["'self'", ...extra(dev && "'unsafe-inline'")],
    'connect-src': [
      "'self'",
      // API + broker socket when the app isn't served by the API (dev, e2e).
      ...extra(api && origin(api), api && wsOrigin(api)),
      // Firebase Auth's REST endpoints, or the emulator that stands in for them.
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      ...extra(emulator && origin(emulator)),
      // Vite dev's HMR socket.
      ...extra(dev && 'ws:', dev && 'wss:'),
    ],
    // Posters arrive over the tunnel as blobs; a reload's stand-in frame is a canvas data: URL.
    'img-src': ["'self'", 'blob:', 'data:'],
    // hls.js plays through a MediaSource blob URL; subtitles are blob VTT tracks.
    'media-src': ["'self'", 'blob:'],
    // hls.js starts its transmux worker from a blob URL.
    'worker-src': ["'self'", 'blob:'],
    // Firebase's sign-in iframe on the auth domain (or the emulator).
    // Dev 'self': the LAN preview proxies the emulator to the app's own origin.
    'frame-src': [
      `https://${authDomain}`,
      ...extra(emulator && origin(emulator), dev && "'self'"),
    ],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
  }
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ')
}
