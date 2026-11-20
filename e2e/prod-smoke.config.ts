import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// Prod smoke (.github/workflows/prod-smoke.yml): prod-smoke.ts only, no global setup (no local stack).
export default defineConfig({
  ...base,
  globalSetup: undefined,
  testMatch: 'prod-smoke.ts',
  timeout: 300_000,
  workers: 1,
  reporter: 'list',
  // No trace, screenshot or page snapshot: they'd carry the typed password.
  use: { ...base.use, trace: 'off', screenshot: 'off', actionTimeout: 30_000 },
})
