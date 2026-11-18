// Fixtures every spec imports `test` from (instead of @playwright/test):
// - jellyfin: a Jellyfin for this worker: in CI the one global setup started
//   for it, locally started on first use (stack.ts). Any spec that starts a
//   gateway asks for it; a local run of specs that don't never starts Jellyfin.
// - paired: a signed-in browser paired with its own fresh gateway.
// - sharedPaired: the same, but one user, gateway and paired context per worker
//   (#506); each test gets a fresh page with localStorage cleared. Only for
//   tests that read: they don't play (resume and watched state are per user in
//   Jellyfin), pair, unpair, rename or remove anything, and change no gateway
//   state. Anything else uses `paired`.
// A serial lane, if one is ever needed: Playwright's own `{ lock: 'jellyfin' }`
// in the test details (no harness code).
import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import {
  appUrl,
  newContext,
  onboardGateway,
  pair,
  signedInPage,
  signUp,
  uniqueEmail,
  type User,
} from './helpers.ts'
import { jellyfinLogin, startJellyfin } from './stack.ts'

type Paired = {
  user: User
  page: Page // signed in, paired, on /gateways
  gateway: Awaited<ReturnType<typeof onboardGateway>>
  gatewayCtx: BrowserContext // where the local gateway page opens (pair())
}
type Pairing = Omit<Paired, 'page'> & { ctx: BrowserContext }
const secs = (ms: number) => (ms / 1000).toFixed(1)

export const test = base.extend<
  { paired: Paired; sharedPaired: Paired },
  { jellyfin: string; pairing: Pairing }
>({
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
      // gateways alive on one Jellyfin lock each other out (HTTP 401; the
      // sharedPaired gateway outlives tests, so it logs in again before each
      // of its own). The
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
  // Per test (~5 s in CI: a gateway + one pairing, #506). The client key is a
  // non-extractable CryptoKey in IndexedDB, so neither storageState nor the API
  // can carry a pairing; tests that only read share one (sharedPaired below).
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
      // One line per test (#506): what this fixture costs, summed from the CI log.
      if (t3) {
        const t5 = Date.now()
        console.log(
          `paired: signup ${secs(t1 - t0)}s gateway ${secs(t2 - t1)}s pairing ${secs(t3 - t2)}s teardown ${secs(t5 - t4)}s total ${secs(t3 - t0 + t5 - t4)}s :: ${testInfo.titlePath.slice(1).join(' > ')}`,
        )
      }
    }
  },
  // One pairing per worker (#506): the client key lives in this context's
  // IndexedDB, so the context stays open for the worker's tests. A worker
  // restarted after a failure pairs anew.
  pairing: [
    async ({ browser, jellyfin: _ }, use) => {
      const t0 = Date.now()
      const user = await signUp(uniqueEmail('shared'))
      const gateway = await onboardGateway(user)
      const gatewayCtx = await newContext(browser)
      let page: Page | undefined
      try {
        if (gateway.pageCookie)
          await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only
        page = await signedInPage(browser, user, '/gateways')
        await pair(page, gatewayCtx, gateway.pageUrl)
        await page.close() // each test opens its own
        console.log(`pairing (worker): total ${secs(Date.now() - t0)}s`)
        await use({ user, gateway, gatewayCtx, ctx: page.context() })
      } finally {
        await Promise.all([gatewayCtx.close(), page?.context().close()])
        await gateway.stop()
      }
    },
    { scope: 'worker' },
  ],
  sharedPaired: async ({ pairing }, use, testInfo) => {
    const t0 = Date.now()
    const { ctx, ...rest } = pairing
    // A `paired` test since the last one started a gateway on this worker's
    // Jellyfin, whose login reset the shared viewer and admin passwords: log
    // this gateway in again, as a person would on its local page.
    await jellyfinLogin(rest.gateway.pageUrl, rest.gateway.pageCookie)
    const t1 = Date.now()
    let t2 = 0 // page ready at
    try {
      const page = await ctx.newPage()
      await page.goto(appUrl('/gateways'))
      // Per-device settings (quality, data saver, compatible mode, the speed
      // hint, …) start clean; sign-in and the client key are in IndexedDB.
      await page.evaluate(() => localStorage.clear())
      await page.reload()
      await expect(
        page.locator('li.card').getByRole('button', { name: 'Open' }),
      ).toBeVisible()
      t2 = Date.now()
      await use({ ...rest, page })
    } finally {
      const t3 = Date.now()
      await Promise.all(ctx.pages().map((p) => p.close())) // a test's tabs too
      await ctx.clearPermissions()
      if (t2) {
        const t4 = Date.now()
        console.log(
          `sharedPaired: login ${secs(t1 - t0)}s page ${secs(t2 - t1)}s teardown ${secs(t4 - t3)}s total ${secs(t2 - t0 + t4 - t3)}s :: ${testInfo.titlePath.slice(1).join(' > ')}`,
        )
      }
    }
  },
})
export { expect }
