// The preview's Vite (preview.ts → startStack({ lan })): HTTPS, because pairing
// needs WebCrypto = a secure context, and one origin, proxying the API (+ broker
// WebSocket) and the auth emulator. The app finds both at location.origin, so any
// LAN address (or localhost) the device used works.
import fs from 'node:fs'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
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

// <LAN>/tv → the --tunnel URL (preview.ts writes it to state.json), so a TV
// bookmarks one LAN address instead of retyping a random hostname each run.
const tvRedirect = {
  name: 'preview-tv',
  configureServer(server: {
    middlewares: {
      use: (p: string, f: (req: unknown, res: ServerResponse) => void) => void
    }
  }) {
    server.middlewares.use('/tv', (_req, res) => {
      let tunnel: string | undefined
      try {
        tunnel = JSON.parse(
          fs.readFileSync(
            path.join(import.meta.dirname, '.preview', 'state.json'),
            'utf8',
          ),
        ).tunnel
      } catch {
        // no state yet
      }
      if (tunnel) res.writeHead(302, { Location: tunnel }).end()
      else res.writeHead(404).end('no tunnel: npm run preview -- up --tunnel')
    })
  },
}

export default {
  ...base,
  plugins: [...base.plugins, tvRedirect],
  define: {
    'import.meta.env.VITE_API_URL': 'location.origin',
    'import.meta.env.VITE_FIREBASE_AUTH_EMULATOR': 'location.origin',
  },
  server: {
    // HTTP skips Vite's host check over HTTPS; the HMR socket doesn't.
    allowedHosts: ['.trycloudflare.com'],
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
