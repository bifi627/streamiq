import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// Spike for #570: prod-smoke.ts only, no global setup (no local stack).
export default defineConfig({
  ...base,
  globalSetup: undefined,
  testMatch: 'prod-smoke.ts',
  workers: 1,
  reporter: 'list',
  // No trace, screenshot or page snapshot: they'd carry the typed password.
  use: { ...base.use, trace: 'off', screenshot: 'off', actionTimeout: 30_000 },
})
