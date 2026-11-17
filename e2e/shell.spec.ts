// The app shell and Settings, no gateway or Jellyfin (#406): sign-in, a signed-out
// deep link, not-found, the nav, Settings Back, PWA installability, each per-device
// setting persisted, and the D-pad on Settings (#229). What the settings do to
// playback is the player's spec (#410).
import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  newPage,
  signedInPage,
  signUp,
  uniqueEmail,
} from './helpers.ts'

/** A new account signed in on a new browser at path. */
const signedIn = async (browser: Browser, path = '/gateways') =>
  signedInPage(browser, await signUp(uniqueEmail('shell')), path)

const gatewaysHeading = (p: Page) =>
  p.getByRole('heading', { level: 1, name: 'Gateways' })

test('sign-in: through the form to Gateways @shell', async ({ browser }) => {
  const p = await signedIn(browser, '/')
  await expect(gatewaysHeading(p)).toBeVisible()
})

test('sign-in: a wrong password shows the error, stays on the form @shell', async ({
  browser,
}) => {
  const user = await signUp(uniqueEmail('shell'))
  const p = await newPage(browser)
  await p.goto(appUrl())
  await p.getByLabel('Email').fill(user.email)
  await p.getByLabel('Password', { exact: true }).fill('not-the-password')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await expect(p.getByRole('alert')).toHaveText('Wrong email or password.')
  await expect(p.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(gatewaysHeading(p)).toHaveCount(0)
})

test('signed-out deep link: that route loads after sign-in @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings')
  await expect(p.getByRole('heading', { level: 1 })).toHaveText('Settings')
  expect(new URL(p.url()).pathname).toBe('/settings')
})

test('not-found: Go to your gateways @shell', async ({ browser }) => {
  const p = await signedIn(browser, '/no-such-page')
  await expect(p.getByText('Page not found.')).toBeVisible()
  await p.getByRole('link', { name: 'Go to your gateways' }).click()
  await expect(p).toHaveURL(/\/gateways$/)
  await expect(gatewaysHeading(p)).toBeVisible()
})

test('nav: Gateways, Household, Settings @shell', async ({ browser }) => {
  const p = await signedIn(browser, '/settings')
  const nav = p.getByRole('navigation', { name: 'Main' })
  const h1 = p.getByRole('heading', { level: 1 })
  await nav.getByRole('link', { name: 'Gateways' }).click()
  await expect(p).toHaveURL(/\/gateways$/)
  await expect(h1).toHaveText('Gateways')
  await nav.getByRole('link', { name: 'Household' }).click()
  await expect(p).toHaveURL(/\/household$/)
  await expect(h1).toHaveText(/^Household/) // its label (households.spec.ts)
  await nav.getByRole('link', { name: 'Settings' }).click()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(h1).toHaveText('Settings')
})

test('Settings Back: home after a direct open, else back in history @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings') // no in-app history
  const back = p.getByRole('button', { name: 'Back' })
  await back.click()
  await expect(gatewaysHeading(p)).toBeVisible()
  // Gateways → Settings → Back: history, here Gateways again.
  const settings = p.getByRole('link', { name: 'Settings', exact: true })
  await settings.click()
  await expect(p).toHaveURL(/\/settings$/)
  await back.click()
  await expect(p).toHaveURL(/\/gateways$/)
  await expect(gatewaysHeading(p)).toBeVisible()
  // Home is /gateways too, so only a page other than home proves history.
  await p.getByRole('link', { name: 'Household', exact: true }).click()
  await expect(p).toHaveURL(/\/household$/)
  await settings.click()
  await expect(p).toHaveURL(/\/settings$/)
  await back.click()
  await expect(p).toHaveURL(/\/household$/)
})

test('installable as a PWA (manifest + icons) @shell', async ({ browser }) => {
  const p = await signedIn(browser)
  await expect(gatewaysHeading(p)).toBeVisible()
  const cdp = await p.context().newCDPSession(p)
  const { installabilityErrors } = await cdp.send(
    'Page.getInstallabilityErrors',
  )
  // Playwright contexts are always incognito: that error is the harness, not the app.
  expect(
    installabilityErrors.filter((e) => e.errorId !== 'in-incognito'),
  ).toEqual([])
  expect((await cdp.send('Page.getAppManifest')).errors).toEqual([])
})

// Each toggle once, then a reload: per-device settings live in localStorage.
test('Settings toggles persist across a reload @shell', async ({ browser }) => {
  const p = await signedIn(browser, '/settings')
  const saver = p.getByRole('group', { name: 'Data saver' })
  const dock = p.getByRole('complementary', { name: 'Diagnostics' })
  // Desktop Chrome: no saveData, not cellular, so Automatic is off.
  await expect(
    saver.getByRole('button', { name: 'Automatic' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(p.getByText(/^Off now:/)).toBeVisible()
  await expect(dock).toHaveCount(0)

  await p.getByLabel('TV mode').check()
  await expect(p.locator('html')).toHaveClass(/\btv\b/)
  await p.getByLabel('Compatible mode').check()
  await saver.getByRole('button', { name: 'On' }).click()
  await expect(p.getByText(/^On now:/)).toBeVisible()
  await p.getByLabel('Raw quality option').check()
  await p.getByLabel('Diagnostics panel').check()
  await expect(dock).toBeVisible()

  await p.reload()
  await expect(p.getByLabel('TV mode')).toBeChecked()
  await expect(p.locator('html')).toHaveClass(/\btv\b/)
  await expect(p.getByLabel('Compatible mode')).toBeChecked()
  await expect(saver.getByRole('button', { name: 'On' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(p.getByText(/^On now:/)).toBeVisible()
  await expect(p.getByLabel('Raw quality option')).toBeChecked()
  await expect(p.getByLabel('Diagnostics panel')).toBeChecked()
  await expect(dock).toBeVisible()

  // Back to Automatic: the line follows.
  await saver.getByRole('button', { name: 'Automatic' }).click()
  await expect(p.getByText(/^Off now:/)).toBeVisible()
})

// The D-pad leaves a checkbox (#229), Left/Right too (no caret to keep
// them), and Down goes on past Data saver. Right isn't driven: every Settings
// checkbox ends its row, so Right has no target.
test('Settings D-pad: off a checkbox, Down past Data saver to Raw @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings')
  const compatible = p.getByLabel('Compatible mode')
  await compatible.focus()
  await p.keyboard.press('ArrowLeft')
  await expect(compatible).not.toBeFocused()
  await compatible.focus()
  await p.keyboard.press('ArrowDown')
  const saver = p.getByRole('group', { name: 'Data saver' })
  await expect(saver.getByRole('button', { name: 'Off' })).toBeFocused()
  await p.keyboard.press('ArrowDown')
  await expect(p.getByLabel('Raw quality option')).toBeFocused()
})
