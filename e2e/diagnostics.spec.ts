// Diagnostics, on a paired browser with its own gateway
// (fixtures.ts `paired`): the dock on the library (bar, request table + log,
// stays open), the /diagnostics report with its probe and connection test (direct
// with its line in the gateway's history, forced relay), the dock's Force relay over
// a real library tunnel with the badge, Copy report, a never-paired browser's report. The panel flag is
// arranged in localStorage (its Settings toggle is shell.spec's); the tunnel
// report's edge cases are gateway/internal/sessions and history.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  openActivity,
  openDock,
  openLibrary,
  historyTunnels,
  signedInPage,
} from './helpers.ts'

const report = (p: Page) =>
  p.locator('pre', { hasText: 'StreamIQ diagnostics' })

/** /diagnostics' Test connection: waits for its throughput line and its line in
 * the gateway's tunnel history (stateDir); the line. */
async function testConnection(page: Page, stateDir: string) {
  const diagnostics = () =>
    historyTunnels(stateDir).filter((l) => l.use === 'diagnostics')
  const before = diagnostics().length
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(report(page)).toContainText(
    /throughput: [\d.]+ Mbps \(median of 3 ~2 s bursts after a warm-up; Auto caps at [\d.]+ Mbps\)/,
    { timeout: 30_000 },
  )
  // The line: written by the gateway when the browser's socket closed (the
  // broker's bye), with its route and bytes.
  await expect
    .poll(() => diagnostics().length, { timeout: 15_000 })
    .toBe(before + 1)
  const line = diagnostics()[before]
  expect(line, JSON.stringify(line)).toMatchObject({
    endedAt: expect.any(String),
    bytesSent: expect.any(Number),
  })
  return line
}

test('dock (#71, #230): bar, request table + log, stays open, links the report @diagnostics', async ({
  paired,
}) => {
  const { page } = paired
  await page.addInitScript(() => localStorage.setItem('streamiq.debug', '1'))
  await page.reload()
  await openLibrary(page)
  const dock = page.getByRole('complementary', { name: 'Diagnostics' })
  const bar = dock.getByRole('button', { name: /^Diagnostics peer:/ })
  await expect(bar).toContainText('peer: connected / connected')
  await expect(bar.locator('.dock-last')).toHaveText(/\S/) // the last event

  await openDock(page)
  await expect(
    dock.getByRole('row', { name: /opened.*HTTP 200.*\/UserViews/ }).first(), // newest first
  ).toBeVisible()
  await expect(dock.locator('pre.dock-log')).toContainText('pc connected')

  await page.reload() // remembered per device
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  await dock
    .getByRole('link', { name: 'Client info + connection test' })
    .click()
  await expect(page).toHaveURL(/\/diagnostics$/)
  await expect(report(page)).toBeVisible()
})

test('report, direct (#90, #115): probe, throughput, path, history line, no email @diagnostics', async ({
  paired,
}) => {
  const { page, user, gateway } = paired
  await page.goto(appUrl('/diagnostics'))
  await expect(report(page)).toContainText(/codecs: h264 .* L\d/) // the capability probe
  const row = await testConnection(page, gateway.stateDir)
  await expect(report(page)).toContainText('paired: yes')
  await expect(report(page)).toContainText(/path: direct .* RTT \d+ ms/)
  expect(row, JSON.stringify(row)).toMatchObject({
    relay: false,
    failure: null,
  })
  expect(row.bytesSent).toBeGreaterThan(0)
  expect(row.bytesReceived).toBeGreaterThan(0)
  await expect(report(page)).not.toContainText(user.email)
  // Activity hides the test's Diagnostics tunnel until the box is ticked, then remembers it.
  await openActivity(page)
  const diag = page.getByRole('cell', { name: 'Diagnostics', exact: true })
  await expect(page.getByRole('table', { name: 'Tunnels' })).toBeVisible()
  await expect(diag).toHaveCount(0)
  await page.getByLabel('Show management and diagnostics connections').check()
  await expect(diag).toHaveCount(1)
  // The measured throughput, kept with the gateway's history line.
  await expect(
    page.getByRole('row', { name: /Diagnostics .* [\d.,]+\s?[kMG]b/ }),
  ).toBeVisible()
  await page.reload() // remembered in this browser
  await page.locator('summary', { hasText: 'Activity' }).click()
  await expect(diag).toHaveCount(1)
})

test('report, forced relay: relayed (TURN), relay row @diagnostics', async ({
  paired,
}) => {
  const { page, gateway } = paired
  await page.goto(appUrl('/diagnostics'))
  await page.getByLabel('Force relay (TURN)', { exact: true }).check()
  const row = await testConnection(page, gateway.stateDir)
  await expect(report(page)).toContainText(
    // over udp: the e2e coturn is UDP-only; the prod smoke checks `over tls`
    /relay forced: yes[\s\S]*relay: available[\s\S]*path: relayed \(TURN\) over udp/,
  )
  expect(row, JSON.stringify(row)).toMatchObject({ relay: true, failure: null })
})

// Buttons, not ?relay / ?debug: a TV can't edit the URL.
test('dock Force relay: the library tunnels over TURN, the badge says so @diagnostics', async ({
  paired,
}) => {
  const { page } = paired
  await page.addInitScript(() => localStorage.setItem('streamiq.debug', '1'))
  await page.reload()
  await openDock(page)
  await page.getByLabel('Force relay (TURN) on next connect').check()
  await openLibrary(page) // a tunnel request made it
  await page
    .getByRole('button', { name: 'Relayed · encrypted' })
    .click({ timeout: 30_000 })
  await expect(
    page.getByText(/encrypted relay that can't see it · [\d.,]+ MB relayed/),
  ).toBeVisible()
})

test('Copy report: the clipboard holds the report @diagnostics', async ({
  paired,
}) => {
  const { page } = paired
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(appUrl('/diagnostics'))
  await expect(report(page)).toContainText(/codecs: h264 .* L\d/) // probe done: the report is final
  await page.getByRole('button', { name: 'Copy report' }).click()
  await expect(page.getByText('Copied.', { exact: true })).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  // A Windows clipboard holds CRLF line ends.
  expect(copied.replaceAll('\r\n', '\n')).toBe(await report(page).textContent())
})

test('unpaired: a never-paired browser of the same user fails at connect @diagnostics', async ({
  browser,
  paired,
}) => {
  const b = await signedInPage(browser, paired.user, '/diagnostics')
  await b.getByRole('button', { name: 'Test connection' }).click()
  await expect(report(b)).toContainText(
    /paired: no\s+failed at connect .*not paired/,
  )
  await b.context().close()
})
