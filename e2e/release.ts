// The last gateway release's binary for this OS/arch (compat.spec.ts, prod-smoke.ts).
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const goos =
  { win32: 'windows', darwin: 'darwin', linux: 'linux' }[
    process.platform as string
  ] ?? process.platform
const goarch =
  { x64: 'amd64', arm64: 'arm64' }[process.arch as string] ?? process.arch
export const asset = `streamiq-gateway-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`

/** The latest release's asset, as the gateway-windows CI job gets it; null = none. */
export function download(dir: string) {
  const r = spawnSync(
    'gh',
    [
      'release',
      'download',
      '--repo',
      process.env.GITHUB_REPOSITORY ?? 'bifi627/streamiq',
      '--pattern',
      asset,
      '--dir',
      dir,
    ],
    { encoding: 'utf8', timeout: 120_000 }, // sync: Playwright's timeout can't fire
  )
  if (r.error || r.signal) throw r.error ?? new Error(`gh: ${r.signal}`) // gh missing, timed out
  if (r.status === 0) return path.join(dir, asset)
  // A fork or a repo before its first release: nothing to test against.
  if (/release not found|no assets/i.test(r.stderr)) return null
  throw new Error(`gh release download ${asset}: ${r.stderr}`)
}
