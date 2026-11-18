import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // webOS TVs run Chrome 87 (e2e/chrome87.spec.ts runs the build on it). JS: newer
  // syntax gets lowered, or fails the build. CSS: the default target (Chrome 111) lets
  // Lightning CSS rewrite `(max-width: …)` to range syntax `(width <= …)`, which 87 ignores.
  build: { target: 'chrome87', cssTarget: 'chrome87' },
})
