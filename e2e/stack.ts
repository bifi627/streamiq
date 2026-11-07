// Process helpers shared by global-setup.ts and the specs. Every process logs to
// e2e/logs/<name>.log (uploaded by CI on failure) — the first place to look.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const root = path.resolve(import.meta.dirname, '..')
export const logs = path.join(import.meta.dirname, 'logs')

export type Proc = { proc: ChildProcess; stop: () => Promise<void> }

export function start(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Proc {
  fs.mkdirSync(logs, { recursive: true })
  const log = fs.createWriteStream(path.join(logs, `${name}.log`), {
    flags: 'a',
  })
  const win = process.platform === 'win32'
  // detached on POSIX = own process group, so stop() takes children with it.
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: !win,
  })
  proc.stdout!.pipe(log)
  proc.stderr!.pipe(log)
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const exited = new Promise((r) => proc.once('exit', r))
    if (win) spawnSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)])
    else process.kill(-proc.pid!, 'SIGTERM')
    await exited
  }
  return { proc, stop }
}

/** Polls url until it answers 2xx; fails early if the process died. */
export async function waitHttp(url: string, p: Proc, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (p.proc.exitCode !== null)
      throw new Error(
        `${url}: process exited ${p.proc.exitCode} (see e2e/logs)`,
      )
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${url}: not up after ${timeoutMs}ms (see e2e/logs)`)
}

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

/**
 * Runs the gateway binary built in global setup. stateDir survives stop/start
 * (that's the cert-swap step); the token is only needed for the first run.
 */
export async function startGateway(
  stateDir: string,
  env: Record<string, string>,
) {
  const port = await freePort()
  const pageUrl = `http://127.0.0.1:${port}`
  const gwEnv: Record<string, string> = {
    STREAMIQ_STATE_DIR: stateDir,
    STREAMIQ_PAGE_PORT: String(port),
    STREAMIQ_LAN_URL: pageUrl,
    STREAMIQ_ORIGIN: process.env.E2E_JELLYFIN_URL!,
    STREAMIQ_JELLYFIN_API_KEY: process.env.E2E_JELLYFIN_API_KEY!,
    ...env,
  }
  const p = process.env.E2E_GATEWAY_IMAGE
    ? await dockerGateway(process.env.E2E_GATEWAY_IMAGE, port, gwEnv)
    : start('gateway', process.env.E2E_GATEWAY_BIN!, [], {
        cwd: root,
        env: gwEnv,
      })
  await waitHttp(pageUrl, p)
  return { ...p, pageUrl }
}

/**
 * E2E_GATEWAY_IMAGE=streamiq-gateway:dev runs the gateway as the install does: in
 * a container on a bridge network, ICE through one published UDP port with the
 * host's address advertised (sessions.NewAPI). Same port number both sides —
 * the advertised candidate carries the container-side port.
 */
async function dockerGateway(
  image: string,
  port: number,
  env: Record<string, string>,
): Promise<Proc> {
  const name = `streamiq-e2e-gateway-${port}`
  const icePort = String(await freePort())
  const viaHost = (u: string) => u.replace(/\/\/(127\.0\.0\.1|localhost)\b/, '//host.docker.internal')
  const vars = {
    ...env,
    STREAMIQ_STATE_DIR: '/state',
    STREAMIQ_PAGE_PORT: '8097',
    STREAMIQ_ICE_PORT: icePort,
    STREAMIQ_API_URL: viaHost(env.STREAMIQ_API_URL),
    STREAMIQ_ORIGIN: viaHost(env.STREAMIQ_ORIGIN),
    // Harness-only: the e2e coturn advertises 127.0.0.1 relay addresses,
    // which inside the container mean the container. The gateway allocates on
    // the same coturn instead, so coturn relays to itself. Real TURN
    // (Cloudflare) has public addresses and needs none of this.
    STREAMIQ_ICE_URLS: `turn:host.docker.internal:${process.env.E2E_TURN_PORT}?transport=udp`,
    STREAMIQ_ICE_USERNAME: 'e2e',
    STREAMIQ_ICE_CREDENTIAL: 'e2e',
  }
  const p = start('gateway', 'docker', [
    'run', '--rm', '--name', name,
    '--add-host', 'host.docker.internal:host-gateway', // Linux CI; Docker Desktop has it
    ...(process.getuid ? ['--user', String(process.getuid())] : []), // bind-mounted state dir
    '-v', `${env.STREAMIQ_STATE_DIR}:/state`,
    '-p', `127.0.0.1:${port}:8097`,
    '-p', `127.0.0.1:${icePort}:${icePort}/udp`,
    ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image,
  ], { cwd: root })
  return {
    proc: p.proc,
    stop: async () => {
      spawnSync('docker', ['rm', '-f', name]) // killing the CLI doesn't stop the container
      await p.stop()
    },
  }
}
