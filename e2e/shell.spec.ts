// The app shell and Settings, no gateway or Jellyfin: sign-in, a signed-out
// deep link, not-found, the nav (five tabs, Library disabled without a
// gateway), the title row's Back (Diagnostics), PWA installability, the
// Settings overview (categories, the Playback page, expandables, D-pad), each
// per-device setting persisted, and the D-pad on Playback. TV mode: the first visit
// on a TV (webOS turns it on, Android TV asks), the handoff page (/household: QR
// code, Back), the Settings + nav TV subsets, the D-pad up to the title row and
// along the nav. What the settings do to playback is the player's spec.
import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  newPage,
  openCategory,
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

test('nav: five tabs, Library disabled without a gateway @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings')
  const nav = p.getByRole('navigation', { name: 'Main' })
  const h1 = p.getByRole('heading', { level: 1 })
  await expect(nav.getByRole('link')).toHaveText([
    'Gateways',
    'Activity',
    'Library',
    'Household',
    'Settings',
  ])
  await expect(nav.getByRole('link', { name: 'Library' })).toBeDisabled()
  await expect(p.getByText('Your files stay on your hardware')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Activity' }).click()
  await expect(p).toHaveURL(/\/activity$/)
  await expect(h1).toHaveText('Activity')
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

test('title row Back: only on a page with a parent; Diagnostics goes to Settings after a direct open @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings')
  const h1 = p.getByRole('heading', { level: 1 })
  const back = p.getByRole('button', { name: 'Back' })
  await expect(h1).toHaveText('Settings')
  await expect(back).toHaveCount(0) // a tab: no parent
  await p.goto(appUrl('/diagnostics')) // no in-app history
  await expect(h1).toHaveText('Diagnostics')
  await back.click()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(h1).toHaveText('Settings')
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

test('TV mode: /household hands off, the nav keeps Library + Settings, D-pad to the top bar, Settings keeps Sign out, no alias @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings')
  const nav = p.getByRole('navigation', { name: 'Main' })
  const h1 = p.getByRole('heading', { level: 1 })
  const alias = p.getByText('What members of your households see')
  await openCategory(p, 'Account')
  await expect(alias).toBeVisible()
  await openCategory(p, 'Display')
  await p.getByLabel('TV mode').check() // applies at once, no reload
  // Account keeps Sign out; the alias is a phone/PC's to change.
  await expect(alias).toBeHidden()
  await expect(p.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(nav.getByRole('link')).toHaveText(['Library', 'Settings'])

  // D-pad: Up from the page reaches the top bar (nearest: Settings, right
  // above), Left/Right move along it; Down from the logo is the title row's Back.
  await p.goto(appUrl('/diagnostics'))
  await p.getByRole('button', { name: 'Test connection' }).focus()
  await p.keyboard.press('ArrowUp')
  const settings = nav.getByRole('link', { name: 'Settings' })
  await expect(settings).toBeFocused()
  const logo = p.getByRole('link', { name: 'StreamIQ home' })
  await p.keyboard.press('ArrowLeft') // past the disabled Library
  await expect(logo).toBeFocused()
  await p.keyboard.press('ArrowRight')
  await expect(settings).toBeFocused()
  await logo.focus()
  await p.keyboard.press('ArrowDown')
  await expect(p.getByRole('button', { name: 'Back' })).toBeFocused()

  await p.goto(appUrl('/household?x=1'))
  await expect(h1).toHaveText('Do this on your phone or PC')
  await expect(
    p.getByText(appUrl('/household?x=1'), { exact: true }),
  ).toBeVisible()
  await expect(p.getByRole('button', { name: 'Back' })).toBeFocused()
  const qr = p.getByRole('img', { name: "QR code of this page's address" })
  await expect(qr).toBeVisible()
  await expect(p.getByRole('button', { name: 'Back' })).toBeFocused()
  await p.goto(appUrl('/join#tok'))
  await expect(p.getByText(appUrl('/join#tok'), { exact: true })).toBeVisible()
  await expect(qr).toBeVisible()

  await p.goto(appUrl('/settings'))
  await expect(h1).toHaveText('Settings')
  await openCategory(p, 'Display')
  await p.getByLabel('TV mode').uncheck()
  await p.goto(appUrl('/household'))
  await expect(h1).toHaveText(/^Household/)
  await expect(nav.getByRole('link', { name: 'Household' })).toBeVisible()
})

/** A signed-out browser at the sign-in page whose user agent says ua. */
async function visitAs(browser: Browser, ua: string) {
  const p = await newPage(browser)
  await p.addInitScript((ua) => {
    Object.defineProperty(navigator, 'userAgent', { get: () => ua })
  }, ua)
  await p.goto(appUrl())
  return p
}

test('first visit on a webOS TV: TV mode from the sign-in page @shell', async ({
  browser,
}) => {
  const p = await visitAs(
    browser,
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36',
  )
  await expect(p.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(p.locator('html')).toHaveClass(/\btv\b/)
  await expect(p.getByLabel('TV mode')).toBeChecked()

  // Off by the sign-in toggle: detection never overrides a stored value.
  await p.getByLabel('TV mode').uncheck()
  await p.reload()
  await expect(p.getByLabel('TV mode')).not.toBeChecked()
  await expect(p.locator('html')).not.toHaveClass(/\btv\b/)
})

test('first visit on an Android TV: asks once, answered by remote @shell', async ({
  browser,
}) => {
  const p = await visitAs(
    browser,
    'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  )
  const yes = p.getByRole('button', { name: 'Yes' })
  await expect(yes).toBeFocused()
  await p.keyboard.press('ArrowDown')
  await expect(p.getByRole('button', { name: 'No' })).toBeFocused()
  await p.keyboard.press('ArrowUp')
  await p.keyboard.press('Enter')
  await expect(p.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(p.locator('html')).toHaveClass(/\btv\b/)

  await p.reload()
  await expect(p.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(yes).toHaveCount(0)
})

test('Settings overview: categories, Playback page, expandables, D-pad @shell', async ({
  browser,
}) => {
  const user = await signUp(uniqueEmail('shell'))
  const p = await signedInPage(browser, user, '/settings')
  const h1 = p.getByRole('heading', { level: 1 })
  const rows = p.locator('.categories > li > a, .categories summary')
  await expect(rows).toHaveText([
    'Playback',
    'Display',
    `Account${user.email}`,
    'Diagnostics',
  ])
  await expect(p.locator('details[open]')).toHaveCount(0)
  await expect(p.getByText('These apply to this device only')).toHaveCount(0)

  // D-pad: Down along the rows, OK toggles an expandable, Down from its row
  // reaches the setting at the row's end.
  const playback = p.getByRole('link', { name: 'Playback' })
  await expect(playback).toBeFocused()
  await p.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await p.keyboard.press('Enter')
  const tv = p.getByLabel('TV mode')
  await expect(tv).toBeVisible()
  await p.keyboard.press('ArrowDown')
  await expect(tv).toBeFocused()
  await p.keyboard.press('ArrowDown')
  await expect(rows.nth(2)).toBeFocused()
  await p.keyboard.press('ArrowUp')
  await expect(tv).toBeFocused()
  await p.keyboard.press('ArrowUp')
  await p.keyboard.press('Enter')
  await expect(tv).toBeHidden()

  // OK opens the Playback page; Back returns to the overview.
  await p.keyboard.press('ArrowUp')
  await expect(playback).toBeFocused()
  await p.keyboard.press('Enter')
  await expect(p).toHaveURL(/\/settings\/playback$/)
  await expect(h1).toHaveText('Playback')
  await expect(p.getByText('These apply to this device only.')).toBeVisible()
  await p.goBack() // a TV remote's Back
  await expect(p).toHaveURL(/\/settings$/)
  await p.goto(appUrl('/settings/playback')) // no in-app history
  await p.getByRole('button', { name: 'Back' }).click()
  await expect(p).toHaveURL(/\/settings$/)
  await expect(h1).toHaveText('Settings')
})

// Each toggle once, then a reload: per-device settings live in localStorage.
test('Settings toggles persist across a reload @shell', async ({ browser }) => {
  const p = await signedIn(browser, '/settings')
  const tv = p.getByLabel('TV mode')
  const panel = p.getByLabel('Diagnostics panel')
  const dock = p.getByRole('complementary', { name: 'Diagnostics' })
  const expand = async () => {
    await openCategory(p, 'Display')
    await openCategory(p, 'Diagnostics')
  }
  await expand()
  await expect(dock).toHaveCount(0)
  await tv.check()
  await expect(p.locator('html')).toHaveClass(/\btv\b/)
  await panel.check()
  await expect(dock).toBeVisible()
  await p.reload()
  await expand()
  await expect(tv).toBeChecked()
  await expect(p.locator('html')).toHaveClass(/\btv\b/)
  await expect(panel).toBeChecked()
  await expect(dock).toBeVisible()
})

test('Playback settings persist across a reload @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings/playback')
  const saver = p.getByRole('group', { name: 'Data saver' })
  // Desktop Chrome: no saveData, not cellular, so Automatic is off.
  await expect(
    saver.getByRole('button', { name: 'Automatic' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(p.getByText(/^Off now:/)).toBeVisible()

  await p.getByLabel('Compatible mode').check()
  await saver.getByRole('button', { name: 'On' }).click()
  await expect(p.getByText(/^On now:/)).toBeVisible()
  const speed = p.getByRole('group', { name: 'Measure connection speed' })
  await speed.getByRole('button', { name: 'Every day' }).click()
  await p.getByLabel('Raw quality option').check()

  await p.reload()
  await expect(p.getByLabel('Compatible mode')).toBeChecked()
  await expect(saver.getByRole('button', { name: 'On' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(p.getByText(/^On now:/)).toBeVisible()
  await expect(
    speed.getByRole('button', { name: 'Every day' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(p.getByLabel('Raw quality option')).toBeChecked()

  // Back to Automatic: the line follows.
  await saver.getByRole('button', { name: 'Automatic' }).click()
  await expect(p.getByText(/^Off now:/)).toBeVisible()
})

// The D-pad leaves a checkbox, Left/Right too (no caret to keep
// them), and Down goes on past Data saver and Measure connection speed. Right isn't driven: every Playback
// checkbox ends its row, so Right has no target.
test('Playback D-pad: off a checkbox, Down past Data saver and Measure to Raw @shell', async ({
  browser,
}) => {
  const p = await signedIn(browser, '/settings/playback')
  const compatible = p.getByLabel('Compatible mode')
  await expect(compatible).toBeFocused() // the page's first setting
  await p.keyboard.press('ArrowLeft')
  await expect(compatible).not.toBeFocused()
  await compatible.focus()
  await p.keyboard.press('ArrowDown')
  const saver = p.getByRole('group', { name: 'Data saver' })
  await expect(saver.getByRole('button', { name: 'Off' })).toBeFocused()
  await p.keyboard.press('ArrowDown')
  const speed = p.getByRole('group', { name: 'Measure connection speed' })
  await expect(speed.getByRole('button', { name: 'Off' })).toBeFocused()
  await p.keyboard.press('ArrowDown')
  await expect(p.getByLabel('Raw quality option')).toBeFocused()
})

/** Signs in with Google on p through the Auth emulator's popup: a new account
 * (name, email) the first time, the listed one after that. */
async function google(p: Page, email: string, name: string) {
  // The first popup sign-in loads apis.google.com/js/api.js (even against the
  // emulator); once that failed on CI and newContext's reload dropped the
  // pending sign-in. Click again until a popup opens.
  let g!: Page
  await expect(async () => {
    const popup = p.waitForEvent('popup', { timeout: 5_000 })
    await p.getByRole('button', { name: 'Continue with Google' }).click()
    g = await popup
  }).toPass({ timeout: 30_000 })
  await g.waitForLoadState() // a click before its script runs does nothing
  const listed = g.getByText(email)
  await expect(g.getByText('Add new account').or(listed).first()).toBeVisible()
  if (await listed.isVisible()) return listed.click()
  await g.getByText('Add new account').click()
  await g.getByLabel('Email').fill(email)
  await g.getByLabel('Display name').fill(name)
  await g.getByRole('button', { name: /Sign in with Google/ }).click()
}

test('Google sign-up: picks its alias, prefilled with the Google name @shell', async ({
  browser,
}) => {
  const email = uniqueEmail('google')
  const p = await newPage(browser)
  await p.goto(appUrl())
  await google(p, email, 'Gina Google')
  // Asked like an email sign-up, not handed Google's name silently.
  const alias = p.getByLabel('Your name')
  await expect(alias).toHaveValue('Gina Google')
  // Not chosen yet: a second Google sign-in still asks.
  await p.getByRole('button', { name: 'Sign out' }).click()
  await google(p, email, 'Gina Google')
  await expect(alias).toHaveValue('Gina Google')
  // Continue keeps it: the app opens (no household yet: Google sign-up made
  // none), Settings shows it, no prompt after a reload.
  const app = p.getByRole('heading', { name: "You're not in a household yet" })
  await p.getByRole('button', { name: 'Continue' }).click()
  await expect(app).toBeVisible()
  await p.reload()
  await expect(app).toBeVisible()
  await p.goto(appUrl('/settings'))
  await openCategory(p, 'Account')
  await expect(p.getByText('Your name Gina Google')).toBeVisible()
})
