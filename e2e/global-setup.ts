// The e2e stack (startStack in stack.ts); Playwright calls the returned teardown.
// Jellyfin starts lazily, one per worker slot (fixtures.ts): the stack lives in
// this (the runner's) process, so workers ask for theirs over a small loopback
// server. Only specs that use Jellyfin pay for it.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { startStack } from './stack.ts'

export default async function globalSetup() {
  // Inside this checkout, not os.tmpdir(): a shared path lets another
  // worktree's build overwrite (or, on Windows, fail on) the running binary.
  const stack = await startStack({
    dir: path.join(import.meta.dirname, '.bin'),
    lazyJellyfin: true,
  })

  const server = http.createServer(async (req, res) => {
    const jf = req.url!.match(/^\/jellyfin\/(\d+)$/)
    if (!jf) return res.writeHead(404).end()
    try {
      res.end(await stack.jellyfin(Number(jf[1])))
    } catch (e) {
      res.writeHead(500).end(String(e))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  process.env.E2E_HARNESS_URL = `http://127.0.0.1:${port}` // workers inherit it

  return async () => {
    server.closeAllConnections()
    server.close()
    await stack.stop()
  }
}
