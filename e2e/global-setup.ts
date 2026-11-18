// The e2e stack (startStack in stack.ts); Playwright calls the returned teardown.
import path from 'node:path'
import type { FullConfig } from '@playwright/test'
import { fixtureMedia, startStack } from './stack.ts'

// The area tags whose specs start a gateway, so a Jellyfin (playwright.config.ts).
// @households and @shell never do.
const JELLYFIN_AREAS = [
  '@golden',
  '@gateways',
  '@library',
  '@player',
  '@diagnostics',
  '@compat',
]

/**
 * Can this run need a Jellyfin? Yes unless its --grep matches none of
 * JELLYFIN_AREAS. Global setup runs in the runner process, whose argv carries
 * the CLI's --grep (FullConfig.grep doesn't: it stays the config's match-all).
 * ponytail: a grep matching no area tag (a title word) skips the encode here;
 * a worker that needs Jellyfin then encodes the fixtures itself (slower, still
 * right). File arguments are ignored: no --grep, so it encodes.
 */
function mayNeedJellyfin() {
  const a = process.argv
  const i = a.findIndex((x) => x === '--grep' || x === '-g')
  const grep =
    i >= 0 ? a[i + 1] : a.find((x) => x.startsWith('--grep='))?.slice(7)
  return !grep || JELLYFIN_AREAS.some((t) => new RegExp(grep).test(t))
}

export default async function globalSetup(config: FullConfig) {
  // Inside this checkout, not os.tmpdir(): a shared path lets another
  // worktree's build overwrite (or, on Windows, fail on) the running binary.
  const [stack] = await Promise.all([
    startStack({
      dir: path.join(import.meta.dirname, '.bin'),
      // CI runs every spec: one Jellyfin per worker, started next to the stack
      // (#494). Locally a worker starts its own on first use (fixtures.ts), so a
      // run of specs that don't need one never starts it.
      jellyfins: process.env.CI ? config.workers : 0,
    }),
    // Here, once, so no two workers encode the fixtures at the same time; not
    // for a run of Jellyfin-free areas (no image pull, no encode).
    mayNeedJellyfin() && fixtureMedia(),
  ])
  return stack.stop
}
