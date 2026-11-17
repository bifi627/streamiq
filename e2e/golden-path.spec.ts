// THE golden path: the one critical-path E2E. Real browser → broker → gateway →
// Jellyfin: onboard, pair, browse, play, resume, re-pair, re-pair after an evicted
// key, remove (kills open sessions). Supporting features have per-page specs
// (shell, gateways, households, library, player, screen, diagnostics); edge cases belong in the integration layer.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  gatewayTab,
  newContext,
  newPage,
  openDock,
  pair,
  password,
  tunnelOk,
  uniqueEmail,
  videoTime,
} from './helpers.ts'
import { startGateway } from './stack.ts'

// The test's account, new per run of the test (set at its start).
let account = ''
const email = () => account

async function signIn(browser: Browser, create = false, path = '/') {
  const page = await newPage(browser) // own IndexedDB = own client key
  await page.goto(process.env.E2E_APP_URL! + path)
  if (create)
    await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(email())
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page
    .getByRole('button', { name: create ? 'Create account' : 'Sign in' })
    .click()
  if (create) {
    // A new account picks its alias first (#388): keeps the prefilled email.
    await expect(page.getByLabel('Your name')).toHaveValue(email())
    await page.getByRole('button', { name: 'Continue' }).click()
    // Sign-up makes no household (#387): the user creates one.
    await page.getByRole('button', { name: 'Create a household' }).click()
  }
  if (path === '/')
    await expect(page.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  return page
}

test('onboard gateway, pair, pin, re-pair after cert swap, remove, revoke @golden', async ({
  browser,
  jellyfin: _,
}) => {
  account = uniqueEmail('golden')
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'streamiq-e2e-gateway-'),
  )
  const a = await signIn(browser, true)

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
    await expect(
      a.getByRole('listitem').filter({ hasText: 'Version' }),
    ).toContainText('Online')
    const gatewayCtx = await newContext(browser)
    if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only

    await test.step('browser A pairs; codes match on both sides', async () => {
      await pair(a, gatewayCtx, gateway.pageUrl)
    })

    await test.step('gateway restarts → library opens right away (#172)', async () => {
      // Pairing left the card's shared session open; it still looks connected
      // for ~5–30 s. The broker closing it (gateway socket closed) evicts it,
      // so this Open makes a fresh one.
      await gateway.stop()
      gateway = await startGateway(stateDir, env)
      const gatewayPage = await gatewayTab(gatewayCtx, gateway.pageUrl)
      await expect(gatewayPage.getByText('StreamIQ: connected')).toBeVisible() // back on the broker
      await a.getByRole('button', { name: 'Open' }).click()
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
    })

    await test.step('backup → wiped state → restore: same gateway, no new pairing (#52)', async () => {
      const zip = path.join(
        os.tmpdir(),
        `streamiq-e2e-backup-${Date.now()}.zip`,
      )
      // A free page port: the CLI's "is it running?" check must not hit an installed gateway.
      const cli = (...args: string[]) => {
        const r = spawnSync(process.env.E2E_GATEWAY_BIN!, args, {
          env: {
            ...process.env,
            STREAMIQ_STATE_DIR: stateDir,
            STREAMIQ_PAGE_PORT: new URL(gateway.pageUrl).port,
          },
          encoding: 'utf8',
        })
        expect(r.status, r.stdout + r.stderr).toBe(0)
        return r.stdout
      }
      expect(cli('backup', zip)).toContain('NOT encrypted') // while it runs
      await gateway.stop()
      for (const f of fs.readdirSync(stateDir))
        fs.rmSync(path.join(stateDir, f))
      cli('restore', zip)
      fs.rmSync(zip)
      gateway = await startGateway(stateDir, env)
      const gatewayPage = await gatewayTab(gatewayCtx, gateway.pageUrl)
      await expect(gatewayPage.getByText('StreamIQ: connected')).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByRole('button', { name: 'Open' }).click()
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
    })

    await test.step('browse → play through the tunnel → resume', async () => {
      await a.getByRole('button', { name: /Movies/ }).click()
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await a.getByRole('button', { name: /^(Play|Resume)$/ }).click() // movie page (#204)
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(3)
      await a.goBack() // leaving the player saves the position
      await a.goBack() // movie page → folder
      await a.goBack() // browser history: folder → library home
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      await a.reload()
      // The Resume spot (#203): the saved position, then its Resume button.
      await expect(
        a.getByRole('progressbar', { name: /streamiq e2e clip/ }),
      ).toHaveAttribute('aria-valuetext', /^0:0[3-9] of/)
      await a.getByRole('button', { name: 'Resume' }).click()
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5) // starts there, not at 0
      await a.getByRole('link', { name: '← Gateways' }).click()
    })

    // Buttons, not ?relay / ?debug: a TV can't edit the URL (#71).
    await test.step('diagnostics panel: force relay → tunnel works over TURN', async () => {
      // Diagnostics panel: on once in Settings, the flag persists (#201).
      await a.getByRole('link', { name: 'Settings' }).click()
      await a.getByLabel('Diagnostics panel').check()
      await a.getByRole('link', { name: 'Gateways', exact: true }).click()
      await openDock(a)
      await a.getByLabel('Force relay (TURN) on next connect').check()
      await a.getByRole('button', { name: 'Open' }).click()
      await a
        .getByRole('button', { name: 'Relayed · encrypted' })
        .click({ timeout: 30_000 })
      await expect(
        a.getByText(/encrypted relay that can't see it · [\d.,]+ MB relayed/),
      ).toBeVisible()
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible() // a tunnel request made it
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByLabel('Force relay (TURN) on next connect').uncheck()
    })

    await test.step('pin + key survive a reload (IndexedDB)', async () => {
      await a.reload()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await tunnelOk(a)
    })

    await test.step('browser B (same account, never paired) is refused', async () => {
      // Signed out on the gateway's deep link: sign-in lands B on it.
      const id = (await a.locator('li code').first().textContent())!
      const b = await signIn(browser, false, `/g/${id}`)
      await expect(
        b.locator('[role=alert][data-kind="not-paired"]'),
      ).toContainText('this browser is not paired with the gateway')
      await b.getByRole('link', { name: 'Gateways', exact: true }).click()
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
        a.locator('[role=alert][data-kind="pin-mismatch"]'),
      ).toContainText('Refused: this is not the gateway you paired with.')
      await pair(a, gatewayCtx, gateway.pageUrl)
    })

    await test.step("Remove on the gateway page → A's open session dies, then A is refused", async () => {
      await a.getByRole('button', { name: 'Open' }).click()
      const movies = a.getByRole('button', { name: /Movies/ })
      await expect(movies).toBeVisible() // a live tunnel session, opened before Remove
      const gatewayPage = await gatewayTab(gatewayCtx, gateway.pageUrl)
      const paired = gatewayPage.locator('form[action="/remove"]')
      await expect(paired).toHaveCount(1)
      await paired.getByRole('button', { name: 'Remove' }).click()
      await expect(paired).toHaveCount(0)
      // The gateway closed the PeerConnection: the next request on it fails.
      await movies.click()
      await expect(
        a.locator('[role=alert][data-kind="tunnel-lost"]'),
      ).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        a.getByText('this browser is not paired with the gateway'),
      ).toBeVisible()
    })

    await test.step('evicted client key (#174): message → re-pair right there → stream', async () => {
      // What Safari's 7-day cap or disk pressure does: all IndexedDB gone
      // (client key, pins, and Firebase's sign-in with them).
      const app = process.env.E2E_APP_URL!
      const id = (await a.locator('li code').first().textContent())!
      const cdp = await a.context().newCDPSession(a)
      await cdp.send('Storage.clearDataForOrigin', {
        origin: new URL(app).origin,
        storageTypes: 'indexeddb',
      })
      // Firebase's IndexedDB poll sees the sign-in gone and the app reloads
      // (App.tsx onAuthStateChanged). Wait for that reload to land on the
      // sign-in form, or it aborts / overtakes the goto below (#386).
      await expect(a.getByLabel('Email')).toBeVisible()
      await a.goto(`${app}/g/${id}`)
      await a.getByLabel('Email').fill(email())
      await a.getByLabel('Password', { exact: true }).fill(password)
      await a.getByRole('button', { name: 'Sign in' }).click()
      const alert = a.locator('[role=alert][data-kind="not-paired"]')
      await expect(alert).toContainText(
        "This browser isn't paired with this gateway (anymore). Pair it again.",
      )
      await alert.getByRole('button', { name: 'Pair this browser' }).click()
      const code = (await alert.getByLabel('Comparison code').textContent())!
      const gatewayPage = await gatewayTab(gatewayCtx, gateway.pageUrl)
      const request = gatewayPage.locator('form[action="/decide"]')
      await expect(request).toContainText(code)
      await request.getByRole('button', { name: 'Approve' }).click()
      // Paired → the library reconnects on a fresh session.
      await a.getByRole('button', { name: /Movies/ }).click()
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await a.getByRole('button', { name: /^(Play|Resume)$/ }).click()
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(0)
      // The pairing asked for persistent storage; the result is in the log.
      await expect(
        a.getByText(
          /storage: (persist\(\) (granted|denied)|already persistent)/,
        ),
      ).toBeVisible()
      await a.getByRole('link', { name: 'Gateways', exact: true }).click()
      await expect(a.getByRole('heading', { name: 'Gateways' })).toBeVisible()
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
