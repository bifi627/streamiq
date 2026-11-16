// Fixtures every spec imports `test` from (instead of @playwright/test):
// - jellyfin: a Jellyfin for this worker slot, started on first use
//   (global-setup.ts). Any spec that starts a gateway asks for it; a run of
//   specs that don't never starts Jellyfin.
// - paired: a signed-in browser paired with its own fresh gateway.
import { test as base, type BrowserContext, type Page } from '@playwright/test'
import {
  newPage,
  onboardGateway,
  pair,
  signIn,
  signUp,
  uniqueEmail,
  type User,
} from './helpers.ts'

type Paired = {
  user: User
  page: Page // signed in, paired, on /gateways
  gateway: Awaited<ReturnType<typeof onboardGateway>>
  gatewayCtx: BrowserContext // where the local gateway page opens (pair())
}

export const test = base.extend<{ paired: Paired }, { jellyfin: string }>({
  jellyfin: [
    async ({}, use, workerInfo) => {
      // One per parallel slot, not one per run: each gateway's Jellyfin login
      // resets the shared streamiq-admin / streamiq-viewer passwords, so two
      // gateways alive on one Jellyfin lock each other out (HTTP 401). The
      // same holds for library state (offline / extras, scans): tests running
      // at the same time never share a Jellyfin. A test that changes it puts it
      // back; the next test in its slot gets the same Jellyfin.
      // parallelIndex: a restarted worker gets its slot's Jellyfin back.
      const res = await fetch(
        `${process.env.E2E_HARNESS_URL}/jellyfin/${workerInfo.parallelIndex}`,
      )
      if (!res.ok) throw new Error(`Jellyfin: ${await res.text()}`)
      process.env.E2E_JELLYFIN_URL = await res.text() // startGateway reads it
      await use(process.env.E2E_JELLYFIN_URL)
    },
    { scope: 'worker' },
  ],
  // ponytail: per test (~10 s: a gateway + one pairing). The client key is a
  // non-extractable CryptoKey in IndexedDB, so neither storageState nor the API
  // can carry a pairing; a per-worker live context is the upgrade if this adds up.
  paired: async ({ browser, jellyfin: _ }, use) => {
    const user = await signUp(uniqueEmail('paired'))
    const gateway = await onboardGateway(user)
    const gatewayCtx = await browser.newContext()
    const page = await newPage(browser)
    try {
      if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only
      await page.goto(process.env.E2E_APP_URL + '/gateways')
      await signIn(page, user)
      await pair(page, gatewayCtx, gateway.pageUrl)
      await use({ user, page, gateway, gatewayCtx })
    } finally {
      await Promise.all([gatewayCtx.close(), page.context().close()])
      await gateway.stop()
    }
  },
})
export { expect } from '@playwright/test'
