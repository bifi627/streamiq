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
      // CI: global setup started one per worker; a worker restarted
      // after a failure gets the same one (same parallelIndex).
      const ready = process.env.E2E_JELLYFIN_URLS?.split(',')[parallelIndex]
      if (ready) {
        process.env.E2E_JELLYFIN_URL = ready // startGateway reads it
        return use(ready)
      }
      // One per worker: each gateway's Jellyfin login resets the shared
      // streamiq-admin / streamiq-viewer passwords (two gateways on one Jellyfin
      // lock each other out, HTTP 401), and library state (offline / extras, scans)
      // is shared too; a test that changes it puts it back. Started in the worker:
      // testcontainers' Ryuk reaps it with the stack if this worker is killed.
      const jf = await startJellyfin({}, undefined, `jellyfin ${parallelIndex}`) // sets E2E_JELLYFIN_URL (startGateway reads it)
      await use(jf.url)
      await jf.container.stop()
    },
    // A worker fixture has its own timeout slot (the project's 180 s), so its
    // startup never eats into the first test's budget.
    { scope: 'worker' },
  ],
  // ponytail: per test (4–7 s in CI: a gateway + one pairing). The client key is
  // a non-extractable CryptoKey in IndexedDB, so neither storageState nor the API
  // can carry a pairing. A per-worker live context measured 1.7–3.3 s per test
  // (page load, Jellyfin re-login) plus a pairing per worker, ~5–9 s of CI saved:
  // dropped; the timing line below shows if that changes.
  paired: async ({ browser, jellyfin: _ }, use, testInfo) => {
    const t0 = Date.now()
    const user = await signUp(uniqueEmail('paired'))
    const t1 = Date.now()
    const gateway = await onboardGateway(user)
    const t2 = Date.now()
    const gatewayCtx = await newContext(browser)
    let page: Page | undefined
    let t3 = 0 // paired at
    try {
      if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only
      page = await signedInPage(browser, user, '/gateways')
      await pair(page, gatewayCtx, gateway.pageUrl)
      t3 = Date.now()
      await use({ user, page, gateway, gatewayCtx })
    } finally {
      const t4 = Date.now()
      await Promise.all([gatewayCtx.close(), page?.context().close()])
      await gateway.stop()
      // One line per test: what this fixture costs, summed from the CI log.
      if (t3) {
        const t5 = Date.now()
        const s = (ms: number) => (ms / 1000).toFixed(1)
        console.log(
          `paired: signup ${s(t1 - t0)}s gateway ${s(t2 - t1)}s signin+pair ${s(t3 - t2)}s teardown ${s(t5 - t4)}s total ${s(t3 - t0 + t5 - t4)}s :: ${testInfo.titlePath.slice(1).join(' > ')}`,
        )
      }
    }
  },
})
export { expect } from '@playwright/test'
