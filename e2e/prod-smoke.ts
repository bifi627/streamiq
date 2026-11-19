// Prod smoke (#574, spike #570): the last released gateway on this machine, enrolled against the
// real deployment (SMOKE_URL), played to from a browser signed in with real
// Firebase: direct, then forced relay (real Cloudflare TURN). Fixed test account
// (SMOKE_EMAIL / SMOKE_PASSWORD) with one household; its gateway is revoked at
// the end, and stale ones from a crashed run at the start.
// Not a *.spec.ts: the normal e2e run never picks it up (prod-smoke.config.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { newContext, pair, videoTime } from './helpers.ts'
import { JELLYFIN_ADMIN } from './jellyfin.ts'
import { download } from './release.ts'
import { freePort, root, start, startJellyfin, waitHttp } from './stack.ts'

const app = process.env.SMOKE_URL!
const email = process.env.SMOKE_EMAIL!
const password = process.env.SMOKE_PASSWORD!

/** A fresh ID token for the test account (Firebase REST, the app's public web key). */
async function idToken() {
  const html = await fetch(app).then((r) => r.text())
  const js = html.match(/\/assets\/index-[^"]+\.js/)![0]
  const key = (await fetch(app + js).then((r) => r.text())).match(
    /AIza[0-9A-Za-z_-]{35}/,
  )![0]
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: app + '/' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  ).then((r) => r.json())
  if (!r.idToken) throw new Error(`signIn: ${JSON.stringify(r.error)}`)
  return r.idToken as string
}

const report = (p: Page) =>
  p.locator('pre', { hasText: 'StreamIQ diagnostics' })

test('prod smoke: sign in, enroll, play direct, test connection direct + relay', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const t0 = Date.now()
  const lap = (s: string) =>
    console.log(`smoke: ${s} at ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const token = await idToken()
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${app}/api${p}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    })
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${p}: ${res.status}`)
    const t = await res.text()
    return t ? JSON.parse(t) : null
  }
  lap('signed in (REST)')
  for (const g of await api('/gateways')) {
    console.log(`smoke: revoking stale gateway ${g.id}`)
    await api(`/gateways/${g.id}`, { method: 'DELETE' })
  }

  const dir = path.join(import.meta.dirname, '.bin', 'release')
  fs.rmSync(dir, { recursive: true, force: true })
  const bin = download(dir)
  if (!bin) throw new Error('no gateway release to run')
  fs.chmodSync(bin, 0o755)
  lap('gateway downloaded')
  const jf = await startJellyfin()
  lap('jellyfin ready')

  const { token: enroll } = await api('/gateways/enrollment-tokens', {
    method: 'POST',
  })
  const port = await freePort()
  const pageUrl = `http://127.0.0.1:${port}`
  const gateway = start(`gateway-smoke-${port}`, bin, [], {
    cwd: root,
    env: {
      STREAMIQ_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-')),
      STREAMIQ_PAGE_PORT: String(port),
      STREAMIQ_LAN_URL: pageUrl,
      STREAMIQ_ORIGIN: jf.url,
      STREAMIQ_API_URL: app,
      STREAMIQ_ENROLL_TOKEN: enroll,
    },
  })
  const ctxs: { close: () => Promise<void> }[] = []
  try {
    await waitHttp(pageUrl, gateway)
    const login = await fetch(pageUrl + '/jellyfin/login', {
      method: 'POST',
      headers: { Origin: pageUrl },
      body: new URLSearchParams(JELLYFIN_ADMIN),
      redirect: 'manual',
    })
    expect(login.status, await login.text()).toBe(303)
    await expect
      .poll(async () => (await api('/gateways'))[0]?.online, {
        timeout: 60_000,
      })
      .toBe(true)
    lap('gateway online')

    const ctx = await newContext(browser)
    ctxs.push(ctx)
    const page = await ctx.newPage()
    await page.goto(app + '/gateways')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    const gatewayCtx = await newContext(browser)
    ctxs.push(gatewayCtx)
    await pair(page, gatewayCtx, pageUrl)
    lap('paired')

    await page.getByRole('button', { name: 'Open' }).click()
    await page.getByRole('button', { name: /Movies/ }).click()
    await page.getByRole('button', { name: /streamiq e2e clip/ }).click()
    await page.getByRole('button', { name: /^(Play|Resume)$/ }).click()
    await expect
      .poll(() => videoTime(page), { timeout: 60_000 })
      .toBeGreaterThan(2)
    lap('played')

    await page.goto(app + '/diagnostics')
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(report(page)).toContainText(/throughput: [\d.]+ Mbps/, {
      timeout: 60_000,
    })
    console.log(`smoke: direct report\n${await report(page).textContent()}`)
    await expect(report(page)).toContainText(/path: direct/)
    lap('direct ok')

    await page.reload()
    await page.getByLabel('Force relay (TURN)', { exact: true }).check()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(report(page)).toContainText(/throughput: [\d.]+ Mbps/, {
      timeout: 60_000,
    })
    console.log(`smoke: relay report\n${await report(page).textContent()}`)
    await expect(report(page)).toContainText(/path: relayed \(TURN\)/)
    lap('relay ok')
  } finally {
    await Promise.allSettled(ctxs.map((c) => c.close()))
    await gateway.stop()
    await jf.container.stop()
    for (const g of await api('/gateways'))
      await api(`/gateways/${g.id}`, { method: 'DELETE' })
    lap('cleaned up')
  }
})
