// A paired gateway's lifecycle (fixtures.ts `paired`): restart, backup → restore,
// a new certificate, Remove on the local gateway page, an evicted client key and
// Remove in the web app (revoke), each on its own paired gateway; the gateways
// page itself is gateways.spec.ts.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  gatewayTab,
  openDock,
  openGateway,
  openLibrary,
  pair,
  password,
  restartGateway,
  videoTime,
} from './helpers.ts'
import { envVar, must } from './must.ts'

const open = async (a: Page) => {
  await openLibrary(a)
  const movies = a.getByRole('button', { name: /Movies/ })
  await expect(movies).toBeVisible()
  return movies
}
const refused = (a: Page) =>
  expect(a.getByText('this browser is not paired with the gateway'))

test('restart: the library opens right away (#172) @gateways', async ({
  paired,
}) => {
  // Pairing left the card's shared session open; it still looks connected for
  // ~5–30 s. The broker closing it (gateway socket closed) evicts it, so this
  // Open makes a fresh one.
  const { page: a, gateway, gatewayCtx } = paired
  await restartGateway(gateway)
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  await expect(local.getByText('StreamIQ: connected')).toBeVisible() // back on the broker
  await open(a)
})

test('backup → wiped state → restore: same gateway, no new pairing (#52) @gateways', async ({
  paired,
}) => {
  const { page: a, gateway, gatewayCtx } = paired
  const { stateDir } = gateway
  const zip = path.join(os.tmpdir(), `streamiq-e2e-backup-${Date.now()}.zip`)
  // A free page port: the CLI's "is it running?" check must not hit an installed gateway.
  const cli = (...args: string[]) => {
    const r = spawnSync(envVar('E2E_GATEWAY_BIN'), args, {
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
  const history = path.join(stateDir, 'history')
  const days = fs.readdirSync(history) // the gateway's own history
  expect(days.length).toBeGreaterThan(0)
  for (const f of fs.readdirSync(stateDir))
    fs.rmSync(path.join(stateDir, f), { recursive: true })
  cli('restore', zip)
  expect(fs.readdirSync(history)).toEqual(days)
  fs.rmSync(zip)
  await restartGateway(gateway)
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  await expect(local.getByText('StreamIQ: connected')).toBeVisible()
  await open(a)
})

test('new gateway certificate → red warning → re-pair @gateways', async ({
  paired,
}) => {
  const { page: a, gateway, gatewayCtx } = paired
  await gateway.stop()
  fs.rmSync(path.join(gateway.stateDir, 'cert.pem'))
  await restartGateway(gateway)
  await a.getByRole('button', { name: 'Test' }).click()
  await expect(
    a.locator('[role=alert][data-kind="pin-mismatch"]'),
  ).toContainText('Refused: this is not the gateway you paired with.')
  await pair(a, gatewayCtx, gateway.pageUrl)
})

test("Remove on the local gateway page: the open session dies, then it's refused @gateways", async ({
  paired,
}) => {
  const { page: a, gateway, gatewayCtx } = paired
  const movies = await open(a) // a live tunnel session, opened before Remove
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  const clients = local.locator('form[action="/remove"]')
  await expect(clients).toHaveCount(1)
  await clients.getByRole('button', { name: 'Remove' }).click()
  await expect(clients).toHaveCount(0)
  // The gateway closed the PeerConnection: the next request on it fails.
  await movies.click()
  await expect(a.locator('[role=alert][data-kind="tunnel-lost"]')).toBeVisible()
  await a
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Gateways' })
    .click()
  await a.getByRole('button', { name: 'Test' }).click()
  await refused(a).toBeVisible()
})

test('evicted client key (#174): message → re-pair right there → stream @gateways', async ({
  paired,
}) => {
  const { page: a, user, gateway, gatewayCtx } = paired
  await a.addInitScript(() => localStorage.setItem('streamiq.debug', '1')) // the dock's log
  const id = must(
    await a.locator('li code').first().textContent(),
    'gateway id',
  )
  // What Safari's 7-day cap or disk pressure does: all IndexedDB gone (client
  // key, pins, and Firebase's sign-in with them).
  const cdp = await a.context().newCDPSession(a)
  await cdp.send('Storage.clearDataForOrigin', {
    origin: new URL(appUrl()).origin,
    storageTypes: 'indexeddb',
  })
  // Firebase's IndexedDB poll sees the sign-in gone and the app reloads
  // (App.tsx onAuthStateChanged). Wait for that reload to land on the sign-in
  // form, or it aborts / overtakes the goto below.
  await expect(a.getByLabel('Email')).toBeVisible()
  await a.goto(appUrl(`/g/${id}`))
  await a.getByLabel('Email').fill(user.email)
  await a.getByLabel('Password', { exact: true }).fill(password)
  await a.getByRole('button', { name: 'Sign in' }).click()
  const alert = a.locator('[role=alert][data-kind="not-paired"]')
  await expect(alert).toContainText(
    "This browser isn't paired with this gateway (anymore). Pair it again.",
  )
  await expect(alert).toContainText(
    'this browser is not paired with the gateway',
  )
  await alert.getByRole('button', { name: 'Pair this browser' }).click()
  const code = must(
    await alert.getByLabel('Comparison code').textContent(),
    'comparison code',
  )
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  const request = local.locator('form[action="/decide"]')
  await expect(request).toContainText(code)
  await request.getByRole('button', { name: 'Approve' }).click()
  // Paired → the library reconnects on a fresh session.
  await a.getByRole('button', { name: /Movies/ }).click()
  await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
  await a.getByRole('button', { name: /^(Play|Resume)$/ }).click()
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(0)
  // The pairing asked for persistent storage; the result is in the log.
  await openDock(a)
  await expect(
    a.getByText(/storage: (persist\(\) (granted|denied)|already persistent)/),
  ).toBeVisible()
})

test('Remove in the web app: the gateway is revoked and disconnected @gateways', async ({
  paired,
}) => {
  const { page: a, gateway } = paired
  let out = ''
  gateway.proc.stderr.on('data', (d) => (out += d))
  await openGateway(a)
  a.once('dialog', (d) => d.accept())
  await a.getByRole('button', { name: 'Remove' }).click()
  await expect(a.getByText('No gateways yet.')).toBeVisible() // back on the overview
  // Its socket was closed and the reconnect is refused (401). A miss shows the
  // gateway's stderr since Remove: the reconnecting / dial control lines.
  await expect(() =>
    expect(
      out.includes('credential revoked or unknown'),
      `gateway stderr since Remove:\n${out}`,
    ).toBe(true),
  ).toPass({ timeout: 60_000 })
})
