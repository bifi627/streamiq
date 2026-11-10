// The e2e stack (startStack in stack.ts); Playwright calls the returned teardown.
import path from 'node:path'
import { startStack } from './stack.ts'

export default async function globalSetup() {
  // Inside this checkout, not os.tmpdir(): a shared path lets another
  // worktree's build overwrite (or, on Windows, fail on) the running binary.
  const stack = await startStack({
    dir: path.join(import.meta.dirname, '.bin'),
  })
  return stack.stop
}
