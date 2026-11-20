// Diagnostics (#71, #90, #230), on a paired browser with its own gateway
// (fixtures.ts `paired`): the dock on the library, the /diagnostics report with
// its connection test (direct, forced relay), Copy report, a never-paired
// browser's report. The panel flag is arranged in localStorage (its Settings
// toggle is shell.spec's); relay fallback itself stays in the golden path;
// telemetry edge cases are backend TunnelTelemetry.feature.
import type { Page, WebSocket } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  openDock,
  openLibrary,
  signedInPage,
  tunnelRow,
} from './helpers.ts'

const report = (p: Page) =>
  p.locator('pre', { hasText: 'StreamIQ diagnostics' })

/** /diagnostics' Test connection: waits for its throughput line, its PATCH and
 * its ended `tunnels` row (#390); the PATCH body and the row. */
async function testConnection(page: Page) {
  // This test's tunnel id arrives in its broker `answer` (#390); other
  // sessions (the pairing's) PATCH theirs too.
  const tunnel = new Promise<string>((resolve) => {
    const onWs = (ws: WebSocket) => {
      if (!ws.url().endsWith('/broker/ws')) return
      page.off('websocket', onWs)
      ws.on('framereceived', (f) => {
        const m = JSON.parse(String(f.payload))
        if (m.type === 'answer') resolve(m.tunnel)
      })
    }
    page.on('websocket', onWs)
  })
  // Closing the test's session sends its measurement to telemetry (#162).
  const end = page.waitForRequest(
    async (r) =>
      r.method() === 'PATCH' && r.url().endsWith(`/tunnels/${await tunnel}`),
  )
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(report(page)).toContainText(
    /throughput: [\d.]+ Mbps \(median of 3 ~2 s bursts after a warm-up; Auto caps at [\d.]+ Mbps\)/,
    { timeout: 30_000 },
  )
  const patch = (await end).postDataJSON()
  // The row: written by the broker, ended when the browser's socket closed,
  // route + bytes from the gateway's report (#390).
  const id = await tunnel
  await expect
    .poll(() => tunnelRow(id), { timeout: 15_000 })
    .toMatchObject({
      EndedAt: expect.any(String),
      BytesSent: expect.any(Number),
    })
  return { patch, row: tunnelRow(id)! }
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

test('report, direct (#90, #115): probe, throughput, path, telemetry, no email @diagnostics', async ({
  paired,
}) => {
  const { page, user } = paired
  // The broker and the gateway record tunnels; the browser never creates one (#390).
  let posts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/tunnels')) posts++
  })
  await page.goto(appUrl('/diagnostics'))
  await expect(report(page)).toContainText(/codecs: h264 .* L\d/) // the #115 probe
  const { patch, row } = await testConnection(page)
  expect(patch.throughputKbps).toBeGreaterThan(0)
  await expect(report(page)).toContainText('paired: yes')
  await expect(report(page)).toContainText(/path: direct .* RTT \d+ ms/)
  expect(row, JSON.stringify(row)).toMatchObject({
    Relay: false,
    Failure: null,
    ThroughputKbps: expect.any(Number),
  })
  expect(row.BytesSent).toBeGreaterThan(0)
  expect(row.BytesReceived).toBeGreaterThan(0)
  expect(posts).toBe(0)
  await expect(report(page)).not.toContainText(user.email)
  // Activity hides the test's Diagnostics tunnel until the box is ticked.
  await page.getByRole('link', { name: 'Activity' }).click()
  const diag = page.getByRole('cell', { name: 'Diagnostics', exact: true })
  await expect(page.getByRole('table')).toBeVisible()
  await expect(diag).toHaveCount(0)
  await page.getByLabel('Show management and diagnostics connections').check()
  await expect(diag).toHaveCount(1)
})

test('report, forced relay: relayed (TURN), Relay row @diagnostics', async ({
  paired,
}) => {
  const { page } = paired
  await page.goto(appUrl('/diagnostics'))
  await page.getByLabel('Force relay (TURN)', { exact: true }).check()
  const { row } = await testConnection(page)
  await expect(report(page)).toContainText(
    // over udp: the e2e coturn is UDP-only; the prod smoke checks `over tls` (#576)
    /relay forced: yes[\s\S]*relay: available[\s\S]*path: relayed \(TURN\) over udp/,
  )
  expect(row, JSON.stringify(row)).toMatchObject({ Relay: true, Failure: null })
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
