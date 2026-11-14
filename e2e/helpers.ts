// Shared by the specs: accounts + households over the API (emulator sign-up as in
// preview.ts, the #191 invite flow), and browser steps (sign in, pair, play).
import { expect, type BrowserContext, type Page } from '@playwright/test'

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
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} /api${path}: HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
  const me = await api('/me')
  return { email, uid: r.localId, userId: me.userId, tenantId: me.tenantId, api }
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
  await page.getByPlaceholder('email').fill(user.email)
  await page.getByPlaceholder('password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

export const videoTime = (p: Page) =>
  p
    .locator('video')
    .evaluate((v: HTMLVideoElement) => (v.readyState >= 2 ? v.currentTime : -1))

export const tunnelOk = (p: Page) =>
  expect(p.getByText('Tunnel OK · HTTP 200')).toBeVisible()

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
  const code = (await app
    .locator('p', { hasText: /^Code/ })
    .locator('b')
    .textContent())!
  const gatewayPage = await gatewayTab(ctx, gatewayUrl)
  const request = gatewayPage.locator('form[action="/decide"]')
  await expect(request).toContainText(code) // page self-refreshes every 3s
  await request.getByRole('button', { name: 'Approve' }).click()
  await tunnelOk(app)
}
