import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { csp } from './src/shared/csp.ts'

// ponytail: the VITE_ vars from the environment only (Dockerfile, e2e), not .env files.
const env = process.env
const policy = (dev: boolean) =>
  csp({
    dev,
    api: env.VITE_API_URL ?? (dev ? 'http://localhost:5028' : undefined),
    emulator:
      env.VITE_FIREBASE_AUTH_EMULATOR ??
      (dev ? 'http://localhost:9099' : undefined),
    authDomain:
      env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo-streamiq.firebaseapp.com',
  })

// The build's policy goes into csp.txt for the API to send; `vite preview` sends that file.
const cspFile: Plugin = {
  name: 'csp',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'csp.txt', source: policy(false) })
  },
  configurePreviewServer(s) {
    const file = path.resolve(s.config.root, s.config.build.outDir, 'csp.txt')
    const p = fs.readFileSync(file, 'utf8')
    s.middlewares.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', p)
      next()
    })
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspFile],
  server: { headers: { 'Content-Security-Policy': policy(true) } },
  // Not server's: cspFile sends the build's.
  preview: { headers: {} },
  // webOS TVs run Chrome 87 (e2e/chrome87.spec.ts runs the build on it). JS: newer
  // syntax gets lowered, or fails the build. CSS: the default target (Chrome 111) lets
  // Lightning CSS rewrite `(max-width: …)` to range syntax `(width <= …)`, which 87 ignores.
  build: { target: 'chrome87', cssTarget: 'chrome87' },
})
