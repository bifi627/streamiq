import { defineConfig } from '@playwright/test'

// The whole stack (testcontainers for Postgres, Firebase Auth emulator, coturn,
// Jellyfin; the API, Vite and the gateway as processes) starts in global-setup.ts,
// not `webServer`: it needs the containers' random ports. Jellyfin: one per worker
// (fixtures.ts). Tests run in parallel on that stack, each with its own accounts
// (uniqueEmail) and gateway. Area tags: `npm test -- --grep @households`
// (`allowedTags` in .oxlintrc.json); CI runs everything.
export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0, // a flake is a bug to fix, not to retry away
  forbidOnly: !!process.env.CI, // backstop for a .only that got past lint (playwright/no-focused-test)
  fullyParallel: true, // tests in a file too: they're independent
  // CI: 3 shards (`--shard`, .github/workflows/ci.yml), each its own stack (~1.5 min fixed).
  // CI: 4 vCPUs (16 GB) for Chromes, gateways and a transcoding Jellyfin per
  // worker; 4 workers made every test slower (7m06s / 7m34s vs ~5.5 min at 3).
  // Locally 4, not Playwright's half the cores: 12 Jellyfins peg a 24-thread box
  // and timing tests flake from load alone. `--workers N` overrides.
  workers: process.env.CI ? 3 : 4,
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
