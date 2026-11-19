// The last released gateway against this commit's API (#459): installed gateways
// keep running the last release until their owner updates, while the API deploys on
// merge. Every other spec builds the gateway from this commit, so only this one
// catches an API-side change (broker messages, /api/gateways/ws, enrollment) that
// cuts installed gateways off. Online → a short smoke; upgradeRequired → a
// deliberate MinGatewayProtocol bump, the web app says "Update required"; neither →
// an accidental break, the test fails.
//
// The launch below is what the release expects, not startGateway's. A `!` change
// to gateway.env or the CLI still passes here in its own PR (the old release, the
// old launch); once release-gateway ships it, this fails on every PR and on main
// (installed gateways break the same way). So: in the `!` PR, give the launch both
// forms where it can (an unknown env var is harmless); otherwise fix the launch in
// a follow-up PR right after that release ships.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import {
  newContext,
  pair,
  signedInPage,
  signUp,
  uniqueEmail,
  videoTime,
} from './helpers.ts'
import { JELLYFIN_ADMIN } from './jellyfin.ts'
import { asset, download } from './release.ts'
import { freePort, root, start, waitHttp } from './stack.ts'

test('the last released gateway works with this API, or is told to update @compat', async ({
  browser,
  jellyfin,
}) => {
  // A fixed path, overwritten each run: on Windows a new exe path means a new
  // firewall prompt (and a stale rule) per run.
  const dir = path.join(import.meta.dirname, '.bin', 'release')
  fs.rmSync(dir, { recursive: true, force: true })
  const bin = download(dir)
  test.skip(!bin, `no ${asset} in a gateway release: nothing to test against`)
  fs.chmodSync(bin!, 0o755)

  const user = await signUp(uniqueEmail('compat'))
  const { token } = await user.api('/gateways/enrollment-tokens', {
    method: 'POST',
  })
  const port = await freePort()
  const pageUrl = `http://127.0.0.1:${port}`
  const gateway = start(`gateway-release-${port}`, bin!, [], {
    cwd: root,
    env: {
      STREAMIQ_STATE_DIR: fs.mkdtempSync(
        path.join(os.tmpdir(), 'streamiq-e2e-compat-'),
      ),
      STREAMIQ_PAGE_PORT: String(port),
      STREAMIQ_LAN_URL: pageUrl,
      STREAMIQ_ORIGIN: jellyfin,
      STREAMIQ_API_URL: process.env.E2E_API_URL!,
      STREAMIQ_ENROLL_TOKEN: token,
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

    let outcome = ''
    await expect
      .poll(
        async () => {
          const [g] = await user.api('/gateways')
          outcome = g?.online ? 'online' : g?.upgradeRequired ? 'upgrade' : ''
          return outcome
        },
        {
          timeout: 60_000,
          message: 'the release is neither online nor told to update',
        },
      )
      .not.toBe('')

    const page = await signedInPage(browser, user, '/gateways')
    ctxs.push(page.context())
    if (outcome === 'upgrade') {
      await expect(page.getByText('Update required')).toBeVisible()
      return
    }
    const gatewayCtx = await newContext(browser)
    ctxs.push(gatewayCtx)
    await pair(page, gatewayCtx, pageUrl)
    await page.getByRole('button', { name: 'Open' }).click()
    await page.getByRole('button', { name: /Movies/ }).click()
    await page.getByRole('button', { name: /streamiq e2e clip/ }).click()
    await page.getByRole('button', { name: /^(Play|Resume)$/ }).click()
    await expect
      .poll(() => videoTime(page), { timeout: 30_000 })
      .toBeGreaterThan(2)
  } finally {
    await Promise.allSettled(ctxs.map((c) => c.close()))
    await gateway.stop()
  }
})
