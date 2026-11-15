import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // webOS TVs run Chrome 87: the default target (Chrome 111) lets Lightning CSS
  // rewrite `(max-width: …)` to range syntax `(width <= …)`, which 87 ignores.
  build: { cssTarget: 'chrome87' },
})
