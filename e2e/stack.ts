// The stack (startStack) + process helpers, shared by global-setup.ts, the specs
// and preview.ts. Every process logs to e2e/logs/<name>.log (uploaded by CI on
// failure; the preview's: e2e/.preview/logs) — the first place to look.
// Imports carry .ts: preview.ts runs this under plain Node (type stripping).
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { GenericContainer, Wait } from 'testcontainers'
import { JELLYFIN_ADMIN, setupJellyfin } from './jellyfin.ts'

export const root = path.resolve(import.meta.dirname, '..')
export const logs =
  process.env.E2E_LOGS ?? path.join(import.meta.dirname, 'logs')

export type Proc = { proc: ChildProcess; stop: () => Promise<void> }
/** Every process start() spawned: the preview kills them when it fails or stops. */
export const started: Proc[] = []

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
  started.push({ proc, stop })
  return { proc, stop }
}

/** Polls url until it answers 2xx; fails early if the process died. */
export async function waitHttp(
  url: string,
  p: Proc,
  timeoutMs = 120_000,
  headers: Record<string, string> = {},
) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (p.proc.exitCode !== null)
      throw new Error(
        `${url}: process exited ${p.proc.exitCode} (see e2e/logs)`,
      )
    try {
      if ((await fetch(url, { headers })).ok) return
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
    ...env,
  }
  const p = process.env.E2E_GATEWAY_IMAGE
    ? await dockerGateway(process.env.E2E_GATEWAY_IMAGE, port, gwEnv)
    : start('gateway', process.env.E2E_GATEWAY_BIN!, [], {
        cwd: root,
        env: gwEnv,
      })
  // A containerized gateway sees the host as a LAN client, not loopback: sign in
  // with the page token (#42), as a person on another device does.
  const headers: Record<string, string> = {}
  let pageCookie: { name: string; value: string; url: string } | undefined
  if (process.env.E2E_GATEWAY_IMAGE) {
    const file = path.join(stateDir, 'page-token')
    for (const end = Date.now() + 120_000; !fs.existsSync(file);) {
      if (Date.now() > end || p.proc.exitCode !== null)
        throw new Error(`${file}: not written (see e2e/logs)`)
      await new Promise((r) => setTimeout(r, 500))
    }
    pageCookie = {
      name: 'streamiq_page',
      value: fs.readFileSync(file, 'utf8').trim(),
      url: pageUrl,
    }
    headers.Cookie = `${pageCookie.name}=${pageCookie.value}`
  }
  await waitHttp(pageUrl, p, undefined, headers)
  // First start: connect Jellyfin the way a person does, with an admin login on
  // the local page; the gateway keeps only its viewer token (state/jellyfin.json).
  if (!fs.existsSync(path.join(stateDir, 'jellyfin.json'))) {
    const res = await fetch(pageUrl + '/jellyfin/login', {
      method: 'POST',
      headers: { Origin: pageUrl, ...headers },
      body: new URLSearchParams(JELLYFIN_ADMIN),
      redirect: 'manual',
    })
    if (res.status !== 303) {
      throw new Error(
        `gateway Jellyfin login: HTTP ${res.status} ${await res.text()}`,
      )
    }
  }
  return { ...p, pageUrl, pageCookie }
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
  const turnUser = `${Math.floor(Date.now() / 1000) + 3600}:e2e-gateway`
  const viaHost = (u: string) =>
    u.replace(/\/\/(127\.0\.0\.1|localhost)\b/, '//host.docker.internal')
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
    // TURN REST creds for coturn's --static-auth-secret=e2e, valid 1 h.
    STREAMIQ_ICE_URLS: `turn:host.docker.internal:${process.env.E2E_TURN_PORT}?transport=udp`,
    STREAMIQ_ICE_USERNAME: turnUser,
    STREAMIQ_ICE_CREDENTIAL: createHmac('sha1', 'e2e')
      .update(turnUser)
      .digest('base64'),
  }
  const p = start(
    'gateway',
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--add-host',
      'host.docker.internal:host-gateway', // Linux CI; Docker Desktop has it
      ...(process.getuid ? ['--user', String(process.getuid())] : []), // bind-mounted state dir
      '-v',
      `${env.STREAMIQ_STATE_DIR}:/state`,
      '-p',
      `127.0.0.1:${port}:8097`,
      '-p',
      `127.0.0.1:${icePort}:${icePort}/udp`,
      ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      image,
    ],
    { cwd: root },
  )
  return {
    proc: p.proc,
    stop: async () => {
      spawnSync('docker', ['rm', '-f', name]) // killing the CLI doesn't stop the container
      await p.stop()
    },
  }
}

// Image pins live in docker-compose.yml (one source of truth, never `latest`).
const pin = (name: string) =>
  fs
    .readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
    .match(new RegExp(`image: (${name}:\\S+)`))![1]

export type StackOptions = {
  /** Build output (backend + gateway binary), per checkout and per user (e2e,
   *  preview): on Windows a running copy locks its files. */
  dir: string
  /** Serve the app over HTTPS on all interfaces with the API + auth emulator
   *  proxied to the same origin (vite.preview.config.ts). PEM file paths. */
  lan?: { port: number; cert: string; key: string }
  /** Also mount the repo's dev-media/ into Jellyfin's library (must exist). */
  media?: boolean
  /** Docker label on every container (the preview's `down` removes by it). */
  label?: string
}

/**
 * Starts the whole stack hermetically: random ports everywhere (but lan.port),
 * so it runs next to a live `dev.ps1` stack, other worktrees, and in CI alike.
 * Sets the E2E_* env vars that startGateway() and the specs read.
 */
export async function startStack(o: StackOptions) {
  fs.rmSync(logs, { recursive: true, force: true })
  fs.mkdirSync(logs, { recursive: true })
  const build = (cmd: string, args: string[], cwd: string) =>
    execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  const labeled = (c: GenericContainer) =>
    o.label ? c.withLabels({ 'streamiq.preview': o.label }) : c

  // Firebase emulator image: same Dockerfile as dev + the backend test harness.
  const firebaseImage = await GenericContainer.fromDockerfile(
    path.join(root, 'dev', 'firebase'),
  ).build('streamiq-firebase-emulator:e2e', { deleteOnExit: false })

  const jellyfinContainer = labeled(
    new GenericContainer(pin('jellyfin/jellyfin'))
      .withExposedPorts(8096)
      .withWaitStrategy(
        Wait.forHttp('/System/Info/Public', 8096).forStatusCode(200),
      )
      .withStartupTimeout(180_000),
  )
  if (o.media) {
    const media = path.join(root, 'dev-media')
    if (!fs.existsSync(media))
      throw new Error(`${media} missing (bash scripts/gen-test-media.sh)`)
    jellyfinContainer.withBindMounts([
      { source: media, target: '/media/dev-media', mode: 'ro' },
    ])
  }
  const apiOut = path.join(o.dir, 'api')
  const [pg, firebase, jellyfin, { coturn, turnPort }] = await Promise.all([
    labeled(
      new GenericContainer(pin('postgres'))
        .withEnvironment({
          POSTGRES_USER: 'streamiq',
          POSTGRES_PASSWORD: 'dev',
          POSTGRES_DB: 'streamiq',
        })
        .withExposedPorts(5432)
        // Twice: the init run restarts the server once before it's really ready.
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        ),
    ).start(),
    labeled(
      firebaseImage
        .withCopyFilesToContainer([
          {
            source: path.join(root, 'dev', 'firebase', 'firebase.json'),
            target: '/app/firebase.json',
          },
        ])
        .withWorkingDir('/app')
        .withCommand([
          'firebase',
          'emulators:start',
          '--only',
          'auth',
          '--project',
          'demo-streamiq',
        ])
        .withExposedPorts(9099)
        .withWaitStrategy(Wait.forLogMessage('All emulators ready')),
    ).start(),
    jellyfinContainer.start(),
    startCoturn(labeled),
    // Build while the containers boot.
    (async () => {
      build(
        'dotnet',
        ['build', 'src/StreamIq.Api', '--nologo', '-v', 'q', '-o', apiOut],
        path.join(root, 'backend'),
      )
      const bin = path.join(
        o.dir,
        `streamiq-e2e-gateway${process.platform === 'win32' ? '.exe' : ''}`,
      )
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      build(
        'go',
        ['build', '-o', bin, './cmd/gateway'],
        path.join(root, 'gateway'),
      )
      process.env.E2E_GATEWAY_BIN = bin
    })(),
  ])

  process.env.E2E_TURN_PORT = String(turnPort) // stack.ts: Docker-gateway mode
  const emulator = `http://${firebase.getHost()}:${firebase.getMappedPort(9099)}`
  process.env.E2E_JELLYFIN_URL = `http://${jellyfin.getHost()}:${jellyfin.getMappedPort(8096)}`
  // Fixture media, made in the container by Jellyfin's own ffmpeg (no host
  // ffmpeg in CI): a 30 s H.264 clip with two AAC tracks (English 440 Hz,
  // German 880 Hz: the audio menu, #109) + sidecar English subtitle, in
  // Jellyfin's one-folder-per-movie layout.
  const sh = (cmd: string) =>
    jellyfin.exec(['sh', '-c', cmd]).then((r) => {
      if (r.exitCode !== 0) throw new Error(`jellyfin exec: ${r.output}`)
    })
  await sh(
    'D="/media/streamiq e2e clip" && mkdir -p "$D" && /usr/lib/jellyfin-ffmpeg/ffmpeg -loglevel error -y ' +
      '-f lavfi -i testsrc=duration=30:size=640x360:rate=30 -f lavfi -i sine=frequency=440:duration=30 ' +
      '-f lavfi -i sine=frequency=880:duration=30 -map 0:v -map 1:a -map 2:a ' +
      '-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -metadata:s:a:0 language=eng -metadata:s:a:1 language=deu ' +
      '-metadata title="streamiq e2e clip" "$D/streamiq e2e clip.mp4" && ' +
      `printf '1\n00:00:00,000 --> 00:00:30,000\nstreamiq e2e subtitle\n' > "$D/streamiq e2e clip.en.srt"`,
  )
  await setupJellyfin(process.env.E2E_JELLYFIN_URL)

  const apiPort = await freePort()
  const api = `http://127.0.0.1:${apiPort}`
  // Picked before the backend starts: it's the backend's CORS allowlist entry.
  // (LAN: the proxy drops Origin — a same-origin app — so CORS never applies.)
  const appPort = o.lan?.port ?? (await freePort())
  const app = o.lan
    ? `https://localhost:${appPort}`
    : `http://127.0.0.1:${appPort}`
  process.env.E2E_APP_URL = app
  const backend = start(
    'backend',
    'dotnet',
    [path.join(apiOut, 'StreamIq.Api.dll')],
    {
      cwd: path.join(root, 'backend', 'src', 'StreamIq.Api'),
      env: {
        ASPNETCORE_ENVIRONMENT: 'Development',
        ASPNETCORE_URLS: api,
        ConnectionStrings__Default: `Host=${pg.getHost()};Port=${pg.getMappedPort(5432)};Database=streamiq;Username=streamiq;Password=dev`,
        FIREBASE_AUTH_EMULATOR_HOST: new URL(emulator).host,
        FIREBASE_PROJECT_ID: 'demo-streamiq',
        CORS_ORIGINS: app,
        // The broker mints per-session creds from these (dev path; prod: Cloudflare).
        STREAMIQ_TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=udp`,
        STREAMIQ_TURN_SECRET: 'e2e',
      },
    },
  )

  const vite = start(
    'vite',
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      ...(o.lan
        ? ['--config', path.join(import.meta.dirname, 'vite.preview.config.ts')]
        : []),
      '--host',
      o.lan ? '0.0.0.0' : '127.0.0.1',
      '--port',
      String(appPort),
      '--strictPort',
    ],
    {
      cwd: path.join(root, 'frontend'),
      env: o.lan
        ? {
            PREVIEW_API: api,
            PREVIEW_AUTH: emulator,
            PREVIEW_CERT: o.lan.cert,
            PREVIEW_KEY: o.lan.key,
          }
        : { VITE_API_URL: api, VITE_FIREBASE_AUTH_EMULATOR: emulator },
    },
  )

  await Promise.all([
    waitHttp(`${api}/healthz`, backend),
    // 127.0.0.1: Vite listens on IPv4 only. LAN: the caller trusts the
    // self-signed cert (NODE_EXTRA_CA_CERTS).
    waitHttp(app.replace('localhost', '127.0.0.1'), vite),
  ])

  return {
    app,
    api,
    emulator,
    procs: [backend, vite],
    async stop() {
      await Promise.all([backend.stop(), vite.stop()])
      // Ryuk reaps the containers even if this never runs (crash, Ctrl+C).
      await Promise.all([
        pg.stop(),
        firebase.stop(),
        jellyfin.stop(),
        coturn.stop(),
      ])
    },
  }
}

// TURN for the forced-relay step. Host port must equal container port: coturn
// advertises 127.0.0.1 (--external-ip). Random base per run (not fixed) so
// concurrent runs from other worktrees don't collide; retry on a taken port.
async function startCoturn(labeled: (c: GenericContainer) => GenericContainer) {
  for (let attempt = 1; ; attempt++) {
    const turnPort = 20000 + Math.floor(Math.random() * 20000) // below Windows' ephemeral range; a clash anywhere is a bind error → retry
    const relayPorts = [1, 2, 3, 4, 5].map((i) => turnPort + i)
    const hex = turnPort.toString(16).toUpperCase().padStart(4, '0')
    const fixed = (port: number, protocol: 'tcp' | 'udp') => ({
      container: port,
      host: port,
      protocol,
    })
    try {
      const coturn = await labeled(
        new GenericContainer(pin('coturn/coturn'))
          .withCommand([
            'turnserver',
            '-n',
            // TURN REST creds (expiring HMAC), same scheme the API mints per session.
            '--use-auth-secret',
            '--static-auth-secret=e2e',
            '--realm',
            'streamiq.e2e',
            '--listening-port',
            String(turnPort),
            '--min-port',
            String(relayPorts[0]),
            '--max-port',
            String(relayPorts.at(-1)),
            '--external-ip=127.0.0.1',
            '--verbose',
          ])
          .withExposedPorts(
            fixed(turnPort, 'tcp'),
            fixed(turnPort, 'udp'),
            ...relayPorts.map((p) => fixed(p, 'udp')),
          )
          .withLogConsumer((stream) =>
            stream.pipe(fs.createWriteStream(path.join(logs, 'coturn.log'))),
          )
          // Ready = TCP listener up (/proc/net/tcp lists ports in hex). Not a log line: coturn
          // block-buffers stdout without a TTY, so its log arrives in 4 KB chunks.
          .withHealthCheck({
            test: ['CMD-SHELL', `grep -q ':${hex} ' /proc/net/tcp`],
            interval: 500, // ms
            retries: 60,
          })
          .withWaitStrategy(Wait.forHealthCheck()),
      ).start()
      return { coturn, turnPort }
    } catch (e) {
      if (attempt >= 5 || !/already allocated|bind|excluded/i.test(String(e)))
        throw e
    }
  }
}
