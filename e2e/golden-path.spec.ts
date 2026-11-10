// THE golden path (dev-env spec: exactly one E2E; edge cases belong in the
// integration layer). Real browser → broker → gateway → Jellyfin: onboard, pair,
// install check, browse, play, resume, re-pair, remove (kills open sessions).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { startGateway } from './stack'

const email = 'e2e@streamiq.test'
const password = 'e2e-password'

async function signIn(browser: Browser, create = false, path = '/') {
  const page = await (await browser.newContext()).newPage() // own IndexedDB = own client key
  await page.goto(process.env.E2E_APP_URL! + path)
  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('password').fill(password)
  await page
    .getByRole('button', { name: create ? 'Create account' : 'Sign in' })
    .click()
  if (path === '/')
    await expect(page.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  return page
}

const videoTime = (p: Page) =>
  p
    .locator('video')
    .evaluate((v: HTMLVideoElement) => (v.readyState >= 2 ? v.currentTime : -1))

const tunnelOk = (p: Page) =>
  expect(p.getByText('Tunnel OK · HTTP 200')).toBeVisible()

/** Pair from the web app; approve on the gateway page only if the codes match. */
async function pair(app: Page, gatewayPage: Page, gatewayUrl: string) {
  await app.getByRole('button', { name: 'Pair this browser' }).click()
  const code = (await app
    .locator('p', { hasText: /^Code/ })
    .locator('b')
    .textContent())!
  await gatewayPage.goto(gatewayUrl)
  const request = gatewayPage.locator('form[action="/decide"]')
  await expect(request).toContainText(code) // page self-refreshes every 3s
  await request.getByRole('button', { name: 'Approve' }).click()
  await tunnelOk(app)
}

test('onboard gateway, pair, pin, re-pair after cert swap, remove, revoke', async ({
  browser,
}) => {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'streamiq-e2e-gateway-'),
  )
  const a = await signIn(browser, true)

  await test.step('installable as a PWA (manifest + icons)', async () => {
    const cdp = await a.context().newCDPSession(a)
    const { installabilityErrors } = await cdp.send(
      'Page.getInstallabilityErrors',
    )
    // Playwright contexts are always incognito: that error is the harness, not the app.
    expect(
      installabilityErrors.filter((e) => e.errorId !== 'in-incognito'),
    ).toEqual([])
    expect((await cdp.send('Page.getAppManifest')).errors).toEqual([])
  })

  // Onboarding: Add gateway → run the shown install command.
  await a.getByRole('button', { name: 'Add gateway' }).click()
  const cmd = (await a.locator('pre').first().textContent())!
  const env = Object.fromEntries(
    [...cmd.matchAll(/(STREAMIQ_\w+)=(\S+)/g)].map((m) => [m[1], m[2]]),
  )
  // The gateway refuses to start without an API URL; it must point at this stack.
  expect(env.STREAMIQ_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:/)
  let gateway = await startGateway(stateDir, env)
  try {
    await expect(a.getByRole('listitem')).toContainText('online')
    const gatewayCtx = await browser.newContext()
    if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only
    const gatewayPage = await gatewayCtx.newPage()

    await test.step('browser A pairs; codes match on both sides', () =>
      pair(a, gatewayPage, gateway.pageUrl))

    await test.step('browse → play through the tunnel → resume', async () => {
      await a.getByRole('button', { name: 'Open' }).click()
      await a.getByRole('button', { name: /Movies/ }).click()
      await expect(a).toHaveURL(/\/g\/[^/]+\/i\/[^/]+$/) // folder deep link
      await a.reload() // restores the folder: item loaded by ID over a new tunnel
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await expect(a.getByLabel('Subtitles')).toBeVisible() // sidecar .srt → HLS rendition
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(3)
      await expect(
        a.getByText(/end-to-end encrypted · direct · StreamIQ carried 0 bytes/),
      ).toBeVisible() // same host: host candidates, no relay
      await a.getByRole('button', { name: 'Back' }).click() // saves the position
      await a.goBack() // browser history: folder → library home
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      await a.reload()
      const resume = a.getByRole('button', {
        name: /streamiq e2e clip.*Resume 0:0[3-9]/,
      })
      await resume.click() // "Continue watching" row
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5) // starts there, not at 0
      await a.getByRole('link', { name: '← Gateways' }).click()
    })

    // Buttons, not ?relay / ?debug: a TV can't edit the URL (#71).
    await test.step('diagnostics panel: force relay → tunnel works, panel logs it', async () => {
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await a.getByLabel('Force relay (TURN) on next connect').check()
      await a.getByRole('button', { name: 'Open' }).click()
      await expect(
        a.getByText(/relayed \(encrypted, StreamIQ cannot decrypt\)/),
      ).toBeVisible({ timeout: 30_000 })
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible() // a tunnel request made it
      await expect(a.getByText('peer: connected / connected')).toBeVisible()
      await expect(
        a.getByRole('row', { name: /opened.*HTTP 200.*\/UserViews/ }).first(), // newest first; earlier sessions' rows are kept too
      ).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByLabel('Force relay (TURN) on next connect').uncheck()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
    })

    await test.step('pin + key survive a reload (IndexedDB)', async () => {
      await a.reload()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await tunnelOk(a)
    })

    await test.step('browser B (same account, never paired) is refused', async () => {
      // Signed out on a deep link: sign-in, then that same route loads.
      const id = (await a.locator('li code').first().textContent())!
      const b = await signIn(browser, false, `/g/${id}`)
      await expect(
        b.getByText('this browser is not paired with the gateway'),
      ).toBeVisible()
      expect(new URL(b.url()).pathname).toBe(`/g/${id}`)
      await b.goto(process.env.E2E_APP_URL! + '/no-such-page')
      await b.getByRole('link', { name: 'Go to your gateways' }).click()
      await b.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        b.getByText('this browser is not paired with the gateway'),
      ).toBeVisible()
    })

    await test.step('new gateway certificate → red warning → re-pair', async () => {
      await gateway.stop()
      fs.rmSync(path.join(stateDir, 'cert.pem'))
      // Same env; the spent token is ignored — gateway.json already holds the credential.
      gateway = await startGateway(stateDir, env)
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        a.getByText('Refused: this is not the gateway you paired with.'),
      ).toBeVisible()
      await pair(a, gatewayPage, gateway.pageUrl)
    })

    await test.step("Remove on the gateway page → A's open session dies, then A is refused", async () => {
      await a.getByRole('button', { name: 'Open' }).click()
      const movies = a.getByRole('button', { name: /Movies/ })
      await expect(movies).toBeVisible() // a live tunnel session, opened before Remove
      await gatewayPage.goto(gateway.pageUrl)
      const paired = gatewayPage.locator('form[action="/remove"]')
      await expect(paired).toHaveCount(1)
      await paired.getByRole('button', { name: 'Remove' }).click()
      await expect(paired).toHaveCount(0)
      // The gateway closed the PeerConnection: the next request on it fails.
      await movies.click()
      await expect(a.locator('p[style*="crimson"]')).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        a.getByText('this browser is not paired with the gateway'),
      ).toBeVisible()
    })

    await test.step('Remove in the web app → gateway revoked and disconnected', async () => {
      let out = ''
      gateway.proc.stderr!.on('data', (d) => (out += d))
      a.once('dialog', (d) => d.accept())
      await a.getByRole('button', { name: 'Remove' }).click()
      await expect(a.getByText('No gateways yet.')).toBeVisible()
      // Its socket was closed and the reconnect is refused (401).
      await expect
        .poll(() => out, { timeout: 60_000 })
        .toContain('credential revoked or unknown')
    })
  } finally {
    await gateway.stop()
  }
})
