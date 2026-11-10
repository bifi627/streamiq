// Preview env per worktree (#135): this checkout's stack (startStack), detached
// from the shell that started it, seeded, served on the LAN over HTTPS so a phone
// or TV can try it. Not a Playwright spec: `npm test` never runs it.
//
//   npm run preview --prefix e2e [-- up] [--media] [--port N]
//   npm run preview --prefix e2e -- status
//   npm run preview --prefix e2e -- down
//
// `up` spawns one detached `serve` process (the stack owner), waits until it
// wrote ready into .preview/state.json, prints the URLs and exits. `down` kills
// that process tree, removes the containers (label streamiq.preview=<id>) and
// waits until its ports are closed.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(import.meta.dirname, '.preview')
const stateFile = path.join(dir, 'state.json')
const cert = path.join(dir, 'cert.pem')
const key = path.join(dir, 'key.pem')
const root = path.resolve(import.meta.dirname, '..')
const id = createHash('sha1').update(root).digest('hex').slice(0, 12)
const login = { email: 'preview@streamiq.test', password: 'preview-password' }
const win = process.platform === 'win32'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const cmd = args[0]?.startsWith('--') ? 'up' : (args[0] ?? 'up')

type State = {
  pid: number
  port: number
  ready?: boolean
  lan?: string[]
  local?: string
  gatewayPage?: string
  pids?: number[] // backend, vite, gateway: down kills them even if serve died
  ports?: number[]
}

const read = (): State | undefined => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return undefined
  }
}
const write = (s: State) => fs.writeFileSync(stateFile, JSON.stringify(s))

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Non-virtual adapters first: those are the ones a phone can reach.
function lanIps() {
  const ips = Object.entries(os.networkInterfaces()).flatMap(([name, as]) =>
    (as ?? [])
      .filter((a) => a.family === 'IPv4' && !a.internal)
      .filter((a) => !a.address.startsWith('169.254.'))
      .map((a) => ({
        ip: a.address,
        virtual: /vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V/i.test(name),
      })),
  )
  return ips.sort((a, b) => +a.virtual - +b.virtual).map((a) => a.ip)
}

// Self-signed, once per worktree; again only when the LAN addresses changed.
function ensureCert() {
  const san = [
    'DNS:localhost',
    'IP:127.0.0.1',
    ...lanIps().map((ip) => `IP:${ip}`),
  ].join(',')
  const sanFile = path.join(dir, 'cert-san.txt')
  if (
    fs.existsSync(cert) &&
    fs.existsSync(sanFile) &&
    fs.readFileSync(sanFile, 'utf8') === san
  )
    return
  // openssl ships with Git for Windows; outside Git Bash it's not on PATH.
  const candidates = [
    'openssl',
    path.join(
      process.env.ProgramFiles ?? '',
      'Git',
      'usr',
      'bin',
      'openssl.exe',
    ),
  ]
  for (const openssl of candidates) {
    try {
      execFileSync(
        openssl,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '825',
          '-subj',
          '/CN=StreamIQ preview',
          '-addext',
          `subjectAltName=${san}`,
          '-addext',
          'extendedKeyUsage=serverAuth',
        ],
        { stdio: 'ignore' },
      )
      fs.writeFileSync(sanFile, san)
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  throw new Error(
    'openssl not found (Git for Windows ships it: run from Git Bash)',
  )
}

function print(s: State) {
  console.log(`StreamIQ preview of ${root}
  LAN:          ${s.lan!.join('  ') || '(no LAN address found)'}
                (phone/TV on the same network; accept the certificate warning once)
  local:        ${s.local}
  login:        ${login.email} / ${login.password} (account exists)
  gateway page: ${s.gatewayPage} (approve pairing requests here)
  logs:         ${path.join(dir, 'logs')}, ${path.join(dir, 'preview.log')}
  stop:         npm run preview --prefix e2e -- down`)
}

async function up() {
  let s = read()
  if (s && !alive(s.pid)) {
    await down(s) // a dead run's leftovers
    s = undefined
  }
  if (!s) {
    fs.mkdirSync(dir, { recursive: true })
    ensureCert()
    const port =
      Number(opt('--port') ?? process.env.STREAMIQ_PREVIEW_PORT) ||
      41000 + (parseInt(id.slice(0, 8), 16) % 1000) // stable per worktree: bookmarks keep working
    const log = fs.openSync(path.join(dir, 'preview.log'), 'w')
    const child = spawn(
      process.execPath,
      [import.meta.filename, 'serve', ...args.slice(cmd === args[0] ? 1 : 0)],
      {
        detached: true, // POSIX: own session; Windows: own console, outlives the caller
        stdio: ['ignore', log, log],
        windowsHide: true,
        env: {
          ...process.env,
          E2E_LOGS: path.join(dir, 'logs'),
          NODE_EXTRA_CA_CERTS: cert, // serve's readiness probe trusts the cert
          PREVIEW_PORT: String(port),
        },
      },
    )
    child.unref()
    s = { pid: child.pid!, port }
    write(s)
    console.log(
      `starting (pid ${s.pid}, ~2-4 min; log: ${path.join(dir, 'preview.log')}) ...`,
    )
  } else if (s.ready) {
    console.log('already running:')
    return print(s)
  }
  for (const end = Date.now() + 15 * 60_000; ;) {
    const now = read()
    if (now?.ready) return print(now)
    if (!alive(s.pid) || Date.now() > end) {
      console.error(
        fs.readFileSync(path.join(dir, 'preview.log'), 'utf8').slice(-4000),
      )
      await down(read() ?? s)
      console.error('preview failed to start (log above)')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

function kill(pid: number) {
  if (win)
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
    })
  else
    for (const target of [-pid, pid])
      // the process group (start() spawns detached), else the process
      try {
        process.kill(target, 'SIGTERM')
      } catch {
        // already gone
      }
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    c.once('connect', () => (c.destroy(), resolve(true)))
    c.once('error', () => resolve(false))
  })

async function down(s = read()) {
  if (!s) return console.log('no preview running for this worktree')
  for (const pid of [s.pid, ...(s.pids ?? [])]) kill(pid)
  const ids = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `label=streamiq.preview=${id}`],
    { encoding: 'utf8' },
  )
    .stdout.split(/\s+/)
    .filter(Boolean)
  if (ids.length) spawnSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' })
  for (const end = Date.now() + 30_000; ;) {
    const open = []
    for (const p of s.ports ?? [s.port]) if (await listening(p)) open.push(p)
    if (!open.length && ![s.pid, ...(s.pids ?? [])].some(alive)) break
    if (Date.now() > end)
      throw new Error(
        `still running after down: ports ${open} / pids ${s.pid} ${s.pids}`,
      )
    await new Promise((r) => setTimeout(r, 500))
  }
  fs.rmSync(stateFile, { force: true })
  console.log(`preview stopped (${ids.length} containers removed)`)
}

function status() {
  const s = read()
  if (!s || !alive(s.pid))
    return console.log('not running (start: npm run preview --prefix e2e)')
  if (!s.ready) return console.log(`starting (pid ${s.pid})`)
  print(s)
}

// The detached stack owner: everything below runs in the background process.
async function serve() {
  const { startStack, startGateway, started } = await import('./stack.ts')
  const cleanup = async (code: number) => {
    await Promise.all(started.map((p) => p.stop()))
    process.exit(code)
  }
  process.on('SIGTERM', () => cleanup(0)) // POSIX down; Windows: taskkill /T
  try {
    const port = Number(process.env.PREVIEW_PORT)
    const stack = await startStack({
      dir: path.join(dir, 'bin'),
      lan: { port, cert, key },
      media: args.includes('--media'),
      label: id,
    })

    // Seed: account (the API provisions its tenant on first sign-in), then a
    // gateway onboarded the way "Add gateway" does, until it is online.
    const signUp = await fetch(
      `${stack.emulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...login, returnSecureToken: true }),
      },
    ).then((r) => r.json())
    if (!signUp.idToken)
      throw new Error(`emulator signUp: ${JSON.stringify(signUp)}`)
    const authed = async (p: string, method = 'GET') => {
      const r = await fetch(`${stack.api}/api${p}`, {
        method,
        headers: { Authorization: `Bearer ${signUp.idToken}` },
      })
      if (!r.ok) throw new Error(`${method} /api${p}: HTTP ${r.status}`)
      return r.json()
    }
    const { token } = await authed('/gateways/enrollment-tokens', 'POST')
    const stateDir = path.join(dir, 'gateway-state') // fresh DB each up → fresh gateway
    fs.rmSync(stateDir, { recursive: true, force: true })
    fs.mkdirSync(stateDir)
    const gateway = await startGateway(stateDir, {
      STREAMIQ_API_URL: stack.api,
      STREAMIQ_ENROLL_TOKEN: token,
    })
    for (let i = 0; !(await authed('/gateways'))[0]?.online; i++) {
      if (i > 60) throw new Error('gateway not online after 60 s')
      await new Promise((r) => setTimeout(r, 1000))
    }

    write({
      ...read()!,
      ready: true,
      lan: lanIps().map((ip) => `https://${ip}:${port}`),
      local: stack.app,
      gatewayPage: gateway.pageUrl,
      pids: started.map((p) => p.proc.pid!),
      ports: [
        port,
        ...[stack.api, gateway.pageUrl].map((u) => Number(new URL(u).port)),
      ],
    })
    console.log('ready')
  } catch (e) {
    console.error(e)
    await cleanup(1)
  }
}

if (cmd === 'up') await up()
else if (cmd === 'down') await down()
else if (cmd === 'status') status()
else if (cmd === 'serve') await serve()
else {
  console.error(`unknown command ${cmd}: up | status | down`)
  process.exit(2)
}
