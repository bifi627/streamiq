// The smoke test: a first run through the UI on this stack, browser → broker →
// gateway → Jellyfin: sign up, Add gateway, its install command, pair, browse,
// play, resume, Activity, then prod-smoke.ts's connection tests (direct, forced
// relay) as its local twin. One chain on purpose: each step needs the one before.
// It may repeat what the page specs assert; every other flow lives in them
// (lifecycle, gateways, library, player, diagnostics, …).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  newContext,
  newPage,
  openActivity,
  pair,
  password,
  uniqueEmail,
  videoTime,
} from './helpers.ts'
import { startGateway } from './stack.ts'
import { must } from './must.ts'

const report = (p: Page) =>
  p.locator('pre', { hasText: 'StreamIQ diagnostics' })

test('first run: sign up, add a gateway, pair, play, resume, Activity, direct + relay @smoke', async ({
  browser,
  jellyfin: _,
}) => {
  const email = uniqueEmail('smoke')
  const a = await newPage(browser)
  await test.step('sign up: alias, then a household', async () => {
    await a.goto(appUrl('/'))
    await a.getByRole('button', { name: 'Create an account' }).click()
    await a.getByLabel('Email').fill(email)
    await a.getByLabel('Password', { exact: true }).fill(password)
    await a.getByRole('button', { name: 'Create account' }).click()
    // A new account picks its alias first: keeps the prefilled email.
    await expect(a.getByLabel('Your name')).toHaveValue(email)
    await a.getByRole('button', { name: 'Continue' }).click()
    // Sign-up makes no household: the user creates one.
    await a.getByRole('button', { name: 'Create a household' }).click()
    await expect(a.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  })

  // Add gateway → run the shown install command.
  await a.getByRole('button', { name: 'Add gateway' }).click()
  const cmd = must(
    await a.locator('pre').first().textContent(),
    'install command',
  )
  await a.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  const env = Object.fromEntries(
    [...cmd.matchAll(/(STREAMIQ_\w+)=(\S+)/g)].map((m) => [m[1], m[2]]),
  )
  // The gateway refuses to start without an API URL; it must point at this stack.
  expect(env.STREAMIQ_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:/)
  const gateway = await startGateway(
    fs.mkdtempSync(path.join(os.tmpdir(), 'streamiq-e2e-gateway-')),
    env,
  )
  try {
    await expect(
      a.locator('li.card').getByRole('img', { name: 'Online' }),
    ).toBeVisible()

    await test.step('pair: codes match on both sides', async () => {
      const gatewayCtx = await newContext(browser)
      if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only
      await pair(a, gatewayCtx, gateway.pageUrl)
    })

    await test.step('browse → play through the tunnel → resume', async () => {
      await a.getByRole('link', { name: 'Library' }).click()
      await a.getByRole('button', { name: /Movies/ }).click()
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await a.getByRole('button', { name: /^(Play|Resume)$/ }).click() // movie page
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(3)
      await a.goBack() // movie page → folder; leaving the player saves the position
      await a.goBack() // browser history: folder → library home
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      await a.reload()
      // The Resume spot: the saved position, then its Resume button.
      await expect(
        a.getByRole('progressbar', { name: /streamiq e2e clip/ }),
      ).toHaveAttribute('aria-valuetext', /^0:0[3-9] of/)
      await a.getByRole('button', { name: 'Resume' }).click()
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5) // starts there, not at 0
      await a.goBack() // the movie's page, playing → the library home
      await a
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Gateways' })
        .click()
    })

    await test.step('Activity lists the tunnels so far as Direct, one for Playback', async () => {
      // Tunnels ended so far: those the gateway reported show their route.
      await openActivity(a)
      await expect(
        a.getByRole('cell', { name: /^Direct( · IPv6)?$/ }).first(),
      ).toBeVisible()
      await expect(
        a.getByRole('cell', { name: 'Playback', exact: true }).first(),
      ).toBeVisible()
      await expect(
        a.getByText(
          'Showing the last 30 days (up to 200 tunnels per gateway).',
        ),
      ).toBeVisible()
    })

    await test.step('Test connection: direct, then forced relay (TURN)', async () => {
      await a.goto(appUrl('/diagnostics'))
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(report(a)).toContainText(/throughput: [\d.]+ Mbps/, {
        timeout: 30_000,
      })
      await expect(report(a)).toContainText(/path: direct/)
      await a.reload()
      await a.getByLabel('Force relay (TURN)', { exact: true }).check()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(report(a)).toContainText('relay: available', {
        timeout: 30_000,
      })
      await expect(report(a)).toContainText(/throughput: [\d.]+ Mbps/, {
        timeout: 30_000,
      })
      await expect(report(a)).toContainText(/path: relayed \(TURN\)/)
    })
  } finally {
    await gateway.stop()
  }
})
