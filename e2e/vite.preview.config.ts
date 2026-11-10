// The preview's Vite (preview.ts → startStack({ lan })): HTTPS, because pairing
// needs WebCrypto = a secure context, and one origin, proxying the API (+ broker
// WebSocket) and the auth emulator. The app finds both at location.origin, so any
// LAN address (or localhost) the device used works.
import fs from 'node:fs'
import base from '../frontend/vite.config.ts'

const env = process.env
// The API's CORS allowlist doesn't know these origins; same-origin needs no Origin.
const sameOrigin = (target: string, ws = false) => ({
  target,
  ws,
  changeOrigin: true,
  configure: (proxy: {
    on: (
      e: string,
      f: (r: { removeHeader: (h: string) => void }) => void,
    ) => void
  }) => {
    proxy.on('proxyReq', (r) => r.removeHeader('origin'))
    proxy.on('proxyReqWs', (r) => r.removeHeader('origin'))
  },
})

export default {
  ...base,
  define: {
    'import.meta.env.VITE_API_URL': 'location.origin',
    'import.meta.env.VITE_FIREBASE_AUTH_EMULATOR': 'location.origin',
  },
  server: {
    https: {
      cert: fs.readFileSync(env.PREVIEW_CERT!),
      key: fs.readFileSync(env.PREVIEW_KEY!),
    },
    proxy: {
      '/api': sameOrigin(env.PREVIEW_API!, true),
      '/identitytoolkit.googleapis.com': sameOrigin(env.PREVIEW_AUTH!),
      '/securetoken.googleapis.com': sameOrigin(env.PREVIEW_AUTH!),
      '/emulator': sameOrigin(env.PREVIEW_AUTH!),
    },
  },
}
