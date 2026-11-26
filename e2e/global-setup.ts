// The e2e stack (startStack in stack.ts); Playwright calls the returned teardown.
import path from 'node:path'
import type { FullConfig } from '@playwright/test'
import { fixtureMedia, startJellyfin, startStack, timed } from './stack.ts'

// The area tags whose specs never start a gateway, so never a Jellyfin
// (playwright.config.ts lists them all).
const NO_JELLYFIN_AREAS = ['@households', '@shell']

/**
 * Can this run need a Jellyfin? Yes unless its --grep is just NO_JELLYFIN_AREAS
 * tags (`@households`, `@shell|@households`). Global setup runs in the runner
 * process, whose argv carries the CLI's --grep (FullConfig.grep doesn't: it
 * stays the config's match-all). Any other grep, or none, encodes: a plain
 * string check, no RegExp built from argv.
 */
function mayNeedJellyfin() {
  const a = process.argv
  const i = a.findIndex((x) => x === '--grep' || x === '-g')
  const grep =
    i >= 0 ? a[i + 1] : a.find((x) => x.startsWith('--grep='))?.slice(7)
  return !grep?.split('|').every((t) => NO_JELLYFIN_AREAS.includes(t.trim()))
}

export default async function globalSetup(config: FullConfig) {
  // Inside this checkout, not os.tmpdir(): a shared path lets another
  // worktree's build overwrite (or, on Windows, fail on) the running binary.
  const [stack, , managed] = await timed(
    'total',
    Promise.all([
      startStack({
        dir: path.join(import.meta.dirname, '.bin'),
        // CI runs all of its shard's specs: one Jellyfin per worker, started next to the stack.
        // Locally a worker starts its own on first use (fixtures.ts), so a
        // run of specs that don't need one never starts it.
        jellyfins: process.env.CI ? config.workers : 0,
      }),
      // Here, once, so no two workers encode the fixtures at the same time; not
      // for a run of Jellyfin-free areas (no image pull, no encode).
      mayNeedJellyfin() && timed('fixture media', fixtureMedia()),
      // CI: the managed test's (gateways.spec.ts) too, so its new Docker network
      // and containers don't trip ERR_NETWORK_CHANGED in parallel tests' pages.
      // ponytail: every shard starts it, one runs the test; skip it per shard
      // if the setup time shows it.
      process.env.CI &&
        timed(
          'jellyfin managed',
          startJellyfin({ managed: true }, undefined, 'jellyfin managed'),
        ),
    ]),
  )
  if (managed) process.env.E2E_JELLYFIN_MANAGED_URL = managed.url // gateways.spec.ts
  return async () => {
    await Promise.all([stack.stop(), managed && managed.stop()])
  }
}
