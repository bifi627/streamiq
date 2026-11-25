// Shared by the specs: accounts + households over the API (emulator sign-up as in
// preview.ts, the invite flow), gateways, and browser steps (sign in, pair, play).
// Arrange state here, not through the UI: only the feature under test uses the browser.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

import { startGateway } from './stack.ts'
import { envVar, must } from './must.ts'

export const password = 'e2e-password'

/** The ended tunnels in the gateway's own history (`<state dir>/history/`, the day
 * files gateway/internal/history writes), as stored (keys: relay, bytesSent,
 * endedAt, use, …). */
export function historyTunnels(stateDir: string): Record<string, any>[] {
  const dir = path.join(stateDir, 'history')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /^tunnels-.*\.jsonl$/.test(f))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
}

/** Ended tunnels added to the gateway's own history (`<state dir>/history/`, the
 * day files gateway/internal/history writes): real ones of another user need
 * their own browser and Jellyfin playback. */
export function seedTunnels(
  stateDir: string,
  gatewayId: string,
  rows: { userId: string; use: string; relay: boolean; bytes: number }[],
) {
  const dir = path.join(stateDir, 'history')
  fs.mkdirSync(dir, { recursive: true })
  for (const r of rows) {
    const end = new Date()
    const line = JSON.stringify({
      id: randomUUID(),
      gatewayId,
      createdAt: new Date(end.getTime() - 5 * 60_000).toISOString(),
      endedAt: end.toISOString(),
      userId: r.userId,
      relay: r.relay,
      ipv6: false,
      bytesSent: r.bytes,
      bytesReceived: 0,
      throughputKbps: null,
      failure: null,
      use: r.use,
      activeMs: 60_000,
    })
    fs.appendFileSync(
      path.join(dir, `tunnels-${end.toISOString().slice(0, 10)}.jsonl`),
      line + '\n',
    )
  }
}

/** Health rows added to the gateway's own history (`<state dir>/history/`, the
 * day files gateway/internal/history writes): a real history needs hours of
 * the gateway running. */
export function seedHealth(
  stateDir: string,
  rows: {
    minAgo: number
    reachable: boolean
    jellyfin: string
    gateway: string
    tunnels: number
    cpu: number
  }[],
) {
  const dir = path.join(stateDir, 'history')
  fs.mkdirSync(dir, { recursive: true })
  for (const r of rows) {
    const at = new Date(Date.now() - r.minAgo * 60_000).toISOString()
    const line = JSON.stringify({
      at,
      gatewayVersion: r.gateway,
      jellyfin: { reachable: r.reachable, version: r.jellyfin },
      tunnels: r.tunnels,
      cpu: r.cpu,
    })
    fs.appendFileSync(
      path.join(dir, `health-${at.slice(0, 10)}.jsonl`),
      line + '\n',
    )
  }
}

/** A fresh address per call: the Auth emulator lives for the whole run, and
 * tests run in parallel and under --repeat-each. */
export const uniqueEmail = (tag: string) =>
  `e2e-${tag}-${randomUUID().slice(0, 8)}@streamiq.test`

export type User = {
  email: string
  uid: string // Firebase
  userId: string // users.id
  tenantId: string // their own household (signUp makes it), '' with none
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>
}

/** A new emulator account, provisioned by the API (first /me), with a household
 * of its own as its admin (Create a household) unless household is false.
 * Its alias (displayName) is its email unless given: null = none yet, so
 * the app asks for one first. */
export async function signUp(
  email: string,
  {
    alias = email,
    household = true,
  }: { alias?: string | null; household?: boolean } = {},
): Promise<User> {
  const r = await fetch(
    `${process.env.E2E_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
        ...(alias !== null && { displayName: alias }),
      }),
    },
  ).then((r) => r.json())
  if (!r.idToken) throw new Error(`emulator signUp: ${JSON.stringify(r)}`)
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${process.env.E2E_API_URL}/api${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${r.idToken}`,
        ...init.headers,
      },
    })
    if (!res.ok)
      throw new Error(`${init.method ?? 'GET'} /api${path}: HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
  if (household) await api('/households', { method: 'POST' })
  const me = await api('/me')
  return {
    email,
    uid: r.localId,
    userId: me.userId,
    tenantId: me.tenantId ?? '',
    api,
  }
}

/** user joins host's household over the API: host's invite, user accepts. */
export async function join(host: User, user: User) {
  const { token } = await host.api('/invites', { method: 'POST' })
  await user.api('/invites/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

/**
 * user's new gateway, onboarded the way "Add gateway" does (smoke.spec.ts
 * drives that UI): an enrollment token, the gateway started with it, online.
 * Needs the `jellyfin` fixture (the gateway connects to it).
 */
export async function onboardGateway(user: User) {
  const { token } = await user.api('/gateways/enrollment-tokens', {
    method: 'POST',
  })
  const gateway = await startGateway(
    fs.mkdtempSync(path.join(os.tmpdir(), 'streamiq-e2e-gateway-')),
    {
      STREAMIQ_API_URL: envVar('E2E_API_URL'),
      STREAMIQ_ENROLL_TOKEN: token,
    },
  )
  try {
    await expect
      .poll(
        async () =>
          (await user.api<{ online: boolean }[]>('/gateways'))[0]?.online,
        { timeout: 60_000 },
      )
      .toBe(true)
  } catch (e) {
    await gateway.stop()
    throw e
  }
  return gateway
}

/**
 * Restarts gateway on its state dir, in place, so the `paired` fixture stops the
 * new process. The spent token isn't needed: gateway.json holds the credential.
 */
export async function restartGateway(gateway: Gateway) {
  await gateway.stop()
  Object.assign(
    gateway,
    await startGateway(gateway.stateDir, {
      STREAMIQ_API_URL: envVar('E2E_API_URL'),
    }),
  )
}
type Gateway = Awaited<ReturnType<typeof startGateway>>

/**
 * Signs user in on page (at its current URL), acting in household (what /join or
 * the switcher stores on the device; unset = the user's oldest).
 */
export async function signIn(page: Page, user: User, household?: string) {
  if (household)
    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [`streamiq.household.${user.uid}`, household],
    )
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** The web app's URL for path (Vite on this stack). */
export const appUrl = (path = '') => envVar('E2E_APP_URL') + path

/** A new browser (newPage) opened at path, user signed in there. */
export async function signedInPage(
  browser: Browser,
  user: User,
  path: string,
  household?: string,
) {
  const page = await newPage(browser)
  await page.goto(appUrl(path))
  await signIn(page, user, household)
  return page
}

/** A new browser (own client key) whose playbacks save from the first second:
 * the player's 60 s click-through guard off unless a step sets it. */
export async function newPage(browser: Browser) {
  const ctx = await newContext(browser)
  await ctx.addInitScript(() => {
    if (localStorage.getItem('streamiq.watchMin') === null)
      localStorage.setItem('streamiq.watchMin', '0')
  })
  return ctx.newPage()
}

/** The current test's newContext()s and Chrome's console reports of a blocked load
 * in them: fixtures.ts starts new lists per test, closes the contexts so no page
 * outlives its test, then fails the test on a report. */
export const cspScope = {
  current: { violations: [] as string[], contexts: [] as BrowserContext[] },
}

/** browser.newContext() for every context a test opens (app or local gateway page).
 * Chrome fails in-flight loads with ERR_NETWORK_CHANGED when the host's
 * interfaces change, e.g. Docker adding a container for another worker on CI:
 * a failed module never renders the app, a failed meta refresh leaves the
 * gateway page on Chrome's error page. Reload once per tab, for that
 * error on a page or its scripts only: anything else still fails the test. */
export async function newContext(browser: Browser) {
  const ctx = await browser.newContext()
  // The test that opened this context, not whichever test runs when a report arrives.
  const { violations, contexts } = cspScope.current
  contexts.push(ctx)
  ctx.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) violations.push(m.text())
  })
  // Google's gapi, which Firebase's popup sign-in loads even against the
  // emulator: fetched by Playwright outside Chrome, so the error below can't
  // drop it and a reload can't lose a pending sign-in.
  await ctx.route('https://apis.google.com/**', (r) =>
    r.fetch().then(
      (response) => r.fulfill({ response }),
      () => r.abort(),
    ),
  )
  const reloaded = new WeakSet<Page>()
  ctx.on('requestfailed', (r) => {
    if (
      r.failure()?.errorText !== 'net::ERR_NETWORK_CHANGED' ||
      !['document', 'script'].includes(r.resourceType())
    )
      return
    const p = r.frame().page()
    if (reloaded.has(p)) return
    reloaded.add(p)
    console.warn(`e2e: ${r.url()} hit ERR_NETWORK_CHANGED, reloading once`)
    void p.reload().catch(() => {}) // a test's own navigation may overtake it
  })
  return ctx
}

export const videoTime = (p: Page) =>
  p
    .locator('video')
    .evaluate((v: HTMLVideoElement) => (v.readyState >= 2 ? v.currentTime : -1))

/** Stops inline playback with the player's own exit (the Back key with focus
 * in it; a shown bar hides first) and stays on the detail page. */
export async function exitInline(p: Page) {
  await expect(async () => {
    await p.locator('.player').focus()
    await p.keyboard.press('Escape')
    await expect(p.locator('.hero-player')).toHaveCount(0, { timeout: 1000 })
  }).toPass()
  await expect(p).not.toHaveURL(/[?&]play=/)
}

/** Test connection (or a pairing) tunneled GET /System/Info/Public: a 2xx
 * (else ErrorView) and the server's version shown from its JSON. */
export async function tunnelOk(p: Page) {
  const ok = p.locator('[role=status]', { hasText: 'Tunnel OK' })
  await expect(ok).toBeVisible()
  await expect(ok.locator('dt', { hasText: 'Version' })).toBeVisible()
}

/**
 * Opens the local gateway page in a new tab. Navigating the old tab races its
 * 3s meta refresh: whichever navigation starts second cancels the first.
 * Old tabs stay open (closed with the context): on a busy runner closing one
 * blocked for minutes, and their refreshes are harmless GETs.
 */
export async function gatewayTab(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage()
  await page.goto(url)
  return page
}

/** Pair from the web app; approve on the gateway page only if the codes match.
 * From the overview card's Pair or the gateway page's Pair this browser, both
 * a dialog (closed after, unless keep: the name prompt). */
export async function pair(
  app: Page,
  ctx: BrowserContext,
  gatewayUrl: string,
  keep = false,
) {
  await app.getByRole('button', { name: /^Pair( this browser)?$/ }).click()
  const code = must(
    await app.getByLabel('Comparison code').textContent(),
    'comparison code',
  )
  const gatewayPage = await gatewayTab(ctx, gatewayUrl)
  const request = gatewayPage.locator('form[action="/decide"]')
  await expect(request).toContainText(code) // page self-refreshes every 3s
  await request.getByRole('button', { name: 'Approve' }).click()
  await tunnelOk(app)
  const dialog = app.getByRole('dialog')
  if (!keep && (await dialog.isVisible()))
    await dialog.getByRole('button', { name: 'Close' }).click()
}

/** From the overview: the (only) gateway's page, its tiles collapsed. */
export async function openGateway(p: Page) {
  await p.locator('li.card .gw-link').click()
  await expect(p).toHaveURL(/\/gateways\/[^/]+$/)
}

/**
 * A raw tunnel request from page p's open session (docs/protocol.md framing):
 * the head's status and the body as text. Needs keepPcs(p).
 */
export const viaTunnel = (p: Page, url: string, body?: object) =>
  p.evaluate(
    ([url, body]) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const pcs = (window as { pcs?: RTCPeerConnection[] }).pcs ?? []
        const pc = pcs.findLast((x) => x.connectionState === 'connected')
        if (!pc) return reject(new Error('no connected tunnel: keepPcs(p)?'))
        const dc = pc.createDataChannel(`req:${url}`)
        dc.binaryType = 'arraybuffer'
        let out = ''
        let status = 0
        dc.onopen = () =>
          dc.send(
            JSON.stringify({
              method: body ? 'POST' : 'GET',
              url,
              headers: {},
              ...(body && { body: JSON.stringify(body) }),
            }),
          )
        dc.onmessage = (e) => {
          if (typeof e.data !== 'string')
            out += new TextDecoder().decode(e.data)
          else {
            const m = JSON.parse(e.data)
            if (m.status) status = m.status
            if (m.eof) {
              dc.onclose = null
              dc.close()
              resolve({ status, body: out })
            }
          }
        }
        dc.onclose = () => reject(new Error(`closed: ${url}`))
      }),
    [url, body] as const,
  )
export const keepPcs = (p: Page) =>
  p.addInitScript(() => {
    const P = RTCPeerConnection
    const pcs: RTCPeerConnection[] = []
    ;(window as { pcs?: RTCPeerConnection[] }).pcs = pcs
    window.RTCPeerConnection = class extends P {
      constructor(c?: RTCConfiguration) {
        super(c)
        pcs.push(this)
      }
    } as typeof P
  })

/** Counts the throughput test's /streamiq/burst requests on every load of p;
 * `bursts` reads the count of the current load. */
export const countBursts = (p: Page) =>
  p.addInitScript(() => {
    const w = window as unknown as { bursts: number }
    w.bursts = 0
    const create = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (label, o) {
      if (label.startsWith('req:/streamiq/burst')) w.bursts++
      return create.call(this, label, o)
    }
  })
export const bursts = (p: Page) =>
  p.evaluate(() => (window as { bursts?: number }).bursts)

/** Opens the active gateway's library from the Library tab; its id. */
export async function openLibrary(p: Page) {
  await p
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await expect(p.getByRole('button', { name: /Movies/ })).toBeVisible()
  return must(p.url().match(/\/g\/([^/]+)$/), 'gateway id in the URL')[1]
}

/** The diagnostics dock starts collapsed; its button opens the sheet with
 * the log, the request table and Force relay, and it stays open (per device). */
export const openDock = (p: Page) =>
  p.getByRole('button', { name: /^Diagnostics peer:/, expanded: false }).click()

/** Dominant frequency (Hz) of the <video>'s audio: tells the fixture's 440 Hz
 * English track from its 880 Hz German one. */
export const pitch = (p: Page) =>
  p.locator('video').evaluate((v: HTMLVideoElement & { an?: AnalyserNode }) => {
    if (!v.an) {
      const ctx = new AudioContext()
      v.an = ctx.createAnalyser()
      ctx.createMediaElementSource(v).connect(v.an).connect(ctx.destination)
    }
    const bins = new Float32Array(v.an.frequencyBinCount)
    v.an.getFloatFrequencyData(bins)
    return (
      (bins.indexOf(Math.max(...bins)) * v.an.context.sampleRate) / v.an.fftSize
    )
  })

/** Expands a Settings category that opens in place (Display, Account,
 * Diagnostics): they start closed. */
export const openCategory = (p: Page, name: string) =>
  p
    .locator('summary')
    .filter({ hasText: new RegExp(`^${name}`) })
    .click()
