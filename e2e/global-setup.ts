// The e2e stack (startStack in stack.ts); Playwright calls the returned teardown.
import path from 'node:path'
import type { FullConfig } from '@playwright/test'
import { startStack } from './stack.ts'

export default async function globalSetup(config: FullConfig) {
  // Inside this checkout, not os.tmpdir(): a shared path lets another
  // worktree's build overwrite (or, on Windows, fail on) the running binary.
  const stack = await startStack({
    dir: path.join(import.meta.dirname, '.bin'),
    // CI runs every spec: one Jellyfin per worker, started next to the stack
    // (#494). Locally a worker starts its own on first use (fixtures.ts), so a
    // run of specs that don't need one never starts it.
    jellyfins: process.env.CI ? config.workers : 0,
  })
  return stack.stop
}
