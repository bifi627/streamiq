// Fixtures every spec imports `test` from (instead of @playwright/test):
// - jellyfin: a Jellyfin for this worker: in CI the one global setup started
//   for it, locally started on first use (stack.ts). Any spec that starts a
//   gateway asks for it; a local run of specs that don't never starts Jellyfin.
// - paired: a signed-in browser paired with its own fresh gateway.
// A serial lane, if one is ever needed: Playwright's own `{ lock: 'jellyfin' }`
// in the test details (no harness code).
import { test as base, type BrowserContext, type Page } from '@playwright/test'
import {
  newContext,
  onboardGateway,
  pair,
  signedInPage,
  signUp,
  uniqueEmail,
  type User,
} from './helpers.ts'
import { startJellyfin } from './stack.ts'

type Paired = {
  user: User
  page: Page // signed in, paired, on /gateways
  gateway: Awaited<ReturnType<typeof onboardGateway>>
  gatewayCtx: BrowserContext // where the local gateway page opens (pair())
}

export const test = base.extend<{ paired: Paired }, { jellyfin: string }>({
  jellyfin: [
    async ({}, use, { parallelIndex }) => {
      // CI: global setup started one per worker (#494); a worker restarted
      // after a failure gets the same one (same parallelIndex).
      const ready = process.env.E2E_JELLYFIN_URLS?.split(',')[parallelIndex]
      if (ready) {
        process.env.E2E_JELLYFIN_URL = ready // startGateway reads it
        return use(ready)
      }
      // One per worker, not one per run: each gateway's Jellyfin login
      // resets the shared streamiq-admin / streamiq-viewer passwords, so two
      // gateways alive on one Jellyfin lock each other out (HTTP 401). The
      // same holds for library state (offline / extras, scans): tests running
      // at the same time never share a Jellyfin. A test that changes it puts it
      // back; the next test in its worker gets the same Jellyfin.
      // Started here, in the worker: testcontainers shares the runner's Ryuk,
      // which reaps it with the rest of the stack if this worker is killed.
      const jf = await startJellyfin({}, undefined, `jellyfin ${parallelIndex}`) // sets E2E_JELLYFIN_URL (startGateway reads it)
      await use(jf.url)
      await jf.container.stop()
    },
    // A worker fixture has its own timeout slot (the project's 180 s), so its
    // startup never eats into the first test's budget (#397).
    { scope: 'worker' },
  ],
  // ponytail: per test (~10 s: a gateway + one pairing). The client key is a
  // non-extractable CryptoKey in IndexedDB, so neither storageState nor the API
  // can carry a pairing; a per-worker live context is the upgrade if this adds up.
  paired: async ({ browser, jellyfin: _ }, use) => {
    const user = await signUp(uniqueEmail('paired'))
    const gateway = await onboardGateway(user)
    const gatewayCtx = await newContext(browser)
    let page: Page | undefined
    try {
      if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only
      page = await signedInPage(browser, user, '/gateways')
      await pair(page, gatewayCtx, gateway.pageUrl)
      await use({ user, page, gateway, gatewayCtx })
    } finally {
      await Promise.all([gatewayCtx.close(), page?.context().close()])
      await gateway.stop()
    }
  },
})
export { expect } from '@playwright/test'
