// Shared by the specs: accounts + households over the API (emulator sign-up as in
// preview.ts, the #191 invite flow), gateways, and browser steps (sign in, pair, play).
// Arrange state here, not through the UI: only the feature under test uses the browser.
import { spawnSync } from 'node:child_process'
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

export const password = 'e2e-password'

/** One `tunnels` row (#390) as JSON (EF column names: Relay, BytesSent, EndedAt, …),
 * read from the stack's Postgres with its own psql: e2e has no DB client. null = no row. */
export function tunnelRow(id: string): Record<string, any> | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`not a tunnel id: ${id}`)
  const r = spawnSync(
    'docker',
    [
      'exec',
      process.env.E2E_PG_CONTAINER!,
      'psql',
      '-U',
      'streamiq',
      '-d',
      'streamiq',
      '-At',
      '-c',
      `select row_to_json(t) from tunnels t where "Id" = '${id}'`,
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`)
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
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
 * of its own as its admin (Create a household, #387) unless household is false.
 * Its alias (displayName, #388) is its email unless given: null = none yet, so
 * the app asks for one first. */
export async function signUp(
  email: string,
  alias: string | null = email,
  household = true,
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

/** user joins host's household over the API (#191): host's invite, user accepts. */
export async function join(host: User, user: User) {
  const { token } = await host.api('/invites', { method: 'POST' })
  await user.api('/invites/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

/**
 * user's new gateway, onboarded the way "Add gateway" does (the golden path
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
      STREAMIQ_API_URL: process.env.E2E_API_URL!,
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
export const appUrl = (path = '') => process.env.E2E_APP_URL! + path

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
 * the player's 60 s click-through guard (#330) off unless a step sets it. */
export async function newPage(browser: Browser) {
  const ctx = await newContext(browser)
  await ctx.addInitScript(() => {
    if (localStorage.getItem('streamiq.watchMin') === null)
      localStorage.setItem('streamiq.watchMin', '0')
  })
  return ctx.newPage()
}

/** browser.newContext() for every context a test opens (app or local gateway page).
 * Chrome fails in-flight loads with ERR_NETWORK_CHANGED when the host's
 * interfaces change, e.g. Docker adding a container for another worker on CI:
 * a failed module never renders the app, a failed meta refresh leaves the
 * gateway page on Chrome's error page (#419). Reload once per tab, for that
 * error on a page or its scripts only: anything else still fails the test. */
export async function newContext(browser: Browser) {
  const ctx = await browser.newContext()
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

/** Test connection (or a pairing) tunneled GET /System/Info/Public: a 2xx
 * (else ErrorView) and the server's version shown from its JSON. */
export async function tunnelOk(p: Page) {
  const ok = p.locator('[role=status]', { hasText: 'Tunnel OK' })
  await expect(ok).toBeVisible()
  await expect(ok.locator('dt', { hasText: 'Version' })).toBeVisible()
}

/**
 * Opens the local gateway page in a new tab. Navigating the old tab races its
 * 3s meta refresh: whichever navigation starts second cancels the first (#149).
 * Old tabs stay open (closed with the context): on a busy runner closing one
 * blocked for minutes (#397), and their refreshes are harmless GETs.
 */
export async function gatewayTab(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage()
  await page.goto(url)
  return page
}

/** Pair from the web app; approve on the gateway page only if the codes match. */
export async function pair(app: Page, ctx: BrowserContext, gatewayUrl: string) {
  await app.getByRole('button', { name: 'Pair this browser' }).click()
  const code = (await app.getByLabel('Comparison code').textContent())!
  const gatewayPage = await gatewayTab(ctx, gatewayUrl)
  const request = gatewayPage.locator('form[action="/decide"]')
  await expect(request).toContainText(code) // page self-refreshes every 3s
  await request.getByRole('button', { name: 'Approve' }).click()
  await tunnelOk(app)
}

/**
 * A raw tunnel request from page p's open session (docs/protocol.md framing):
 * the head's status and the body as text. Needs keepPcs(p).
 */
export const viaTunnel = (p: Page, url: string, body?: object) =>
  p.evaluate(
    ([url, body]) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const pcs = (window as { pcs?: RTCPeerConnection[] }).pcs!
        const pc = pcs.findLast((x) => x.connectionState === 'connected')!
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
    const w = window as { pcs?: RTCPeerConnection[] }
    w.pcs = []
    window.RTCPeerConnection = class extends P {
      constructor(c?: RTCConfiguration) {
        super(c)
        w.pcs!.push(this)
      }
    } as typeof P
  })
