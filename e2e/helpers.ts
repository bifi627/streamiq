// Shared by the specs: accounts + households over the API (emulator sign-up as in
// preview.ts, the #191 invite flow), and browser steps (sign in, pair, play).
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

export const password = 'e2e-password'

export type User = {
  email: string
  uid: string // Firebase
  userId: string // users.id
  tenantId: string // the household made on first sign-in
  api: <T = any>(path: string, init?: RequestInit) => Promise<T>
}

/** A new emulator account, provisioned by the API (first /me). */
export async function signUp(email: string): Promise<User> {
  const r = await fetch(
    `${process.env.E2E_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
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
  const me = await api('/me')
  return {
    email,
    uid: r.localId,
    userId: me.userId,
    tenantId: me.tenantId,
    api,
  }
}

/** admin invites member into admin's own household; member accepts (#191). */
export async function invite(admin: User, member: User) {
  const { token } = await admin.api('/invites', { method: 'POST' })
  await member.api('/invites/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  return token as string
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

/** A new browser (own client key) whose playbacks save from the first second:
 * the player's 60 s click-through guard (#330) off unless a step sets it. */
export async function newPage(browser: Browser) {
  const ctx = await browser.newContext()
  await ctx.addInitScript(() => {
    if (localStorage.getItem('streamiq.watchMin') === null)
      localStorage.setItem('streamiq.watchMin', '0')
  })
  return ctx.newPage()
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
 */
export async function gatewayTab(ctx: BrowserContext, url: string) {
  for (const p of ctx.pages()) await p.close() // drops the pending refresh
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
