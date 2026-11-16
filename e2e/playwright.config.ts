import { defineConfig } from '@playwright/test'

// The e2e specs (golden path, multi-user, households): the whole stack — testcontainers for Postgres,
// Firebase Auth emulator, coturn, Jellyfin; backend, Vite, and the gateway as real
// processes — is started by global-setup.ts, not `webServer` (it needs the
// containers' random ports, which only exist after setup runs). Jellyfin only
// once a spec asks for it, one per worker slot (fixtures.ts).
//
// Tests run in parallel on that one stack, so each is independent: own accounts
// (uniqueEmail), own gateway. Area tags pick a slice while working on it:
// `npm test -- --grep @households` (tags: @golden @gateways @player
// @households). CI and check.sh run everything.
export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0, // a flake is a bug to fix, not to retry away
  fullyParallel: true, // tests in a file too: they're independent
  // ponytail: no CI sharding: each shard would start its own stack (~1.5 min).
  // CI: a GitHub runner has 4 vCPUs for Chromes, gateways and one transcoding
  // Jellyfin. Locally: Playwright's default (half the cores).
  workers: process.env.CI ? 3 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Branded Chrome, not bundled Chromium: item 5's <video> needs H.264/AAC,
    // which only the branded build decodes.
    channel: 'chrome',
    trace: 'retain-on-failure',
    launchOptions: {
      // Headless Chrome hides host ICE candidates behind mDNS .local names;
      // runners may not resolve them. Both peers are on this host anyway.
      // Autoplay: the player calls play() after loading; no user gesture here.
      args: [
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
})
