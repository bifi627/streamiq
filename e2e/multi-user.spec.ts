// Two users of one household over the real tunnel: B joins over the API
// (the invite UI is households.spec.ts), each plays as their own Jellyfin viewer,
// and switching accounts in one tab reloads, so no open tunnel carries
// the old user into the new one (App.tsx).
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  join,
  newPage,
  openGateway,
  openLibrary,
  pair,
  signIn,
  signUp,
  uniqueEmail,
  videoTime,
  openCategory,
} from './helpers.ts'
import { jellyfinAdminGet } from './jellyfin.ts'
import { envVar } from './must.ts'

/** Plays the fixture from the library home to sec, then leaves (saves it). */
async function playTo(p: Page, sec: number) {
  await p.getByRole('button', { name: /Movies/ }).click()
  await p.getByRole('button', { name: /streamiq e2e clip/ }).click()
  await p.getByRole('button', { name: /^(Play|Resume)$/ }).click() // movie page
  await expect.poll(() => videoTime(p), { timeout: 30_000 }).toBeGreaterThan(0)
  await p
    .locator('video')
    .evaluate((v: HTMLVideoElement, s) => (v.currentTime = s), sec)
  await expect.poll(() => videoTime(p)).toBeGreaterThan(sec)
  await p.goBack() // leaving the player saves the position
  await p.goBack() // movie page → folder
  await p.goBack() // folder → library home
}

test(
  'two users: own Jellyfin viewers, account switch reloads',
  {
    tag: ['@gateways', '@player'],
  },
  async ({ browser, paired }) => {
    // A: signed in, paired with A's own gateway (fixtures.ts).
    const { user: A, page: a, gateway, gatewayCtx } = paired
    const B = await signUp(uniqueEmail('multi-b'))
    const connect = async (p: Page) => {
      await p.goto(appUrl('/gateways'))
      if (p !== a) await pair(p, gatewayCtx, gateway.pageUrl)
      await openLibrary(p) // a live session
    }
    const b = await newPage(browser) // own client key

    // B joins A's household over the API (the invite UI: households.spec.ts).
    await join(A, B)
    await b.goto(appUrl('/gateways'))
    await signIn(b, B, A.tenantId)
    await connect(a)
    await connect(b)

    await test.step('A and B play to different positions: one Jellyfin viewer each (#195)', async () => {
      await playTo(a, 5)
      await playTo(b, 15)
      const jf = (p: string) => jellyfinAdminGet(envVar('E2E_JELLYFIN_URL'), p)
      const position = async (u: typeof A) => {
        const users: { Name: string; Id: string }[] = await jf('/Users')
        const viewer = users.find((x) => x.Name === `streamiq-${u.userId}`)
        if (!viewer) return -1
        const items = await jf(
          `/Items?userId=${viewer.Id}&recursive=true&includeItemTypes=Movie`,
        )
        return items.Items[0].UserData.PlaybackPositionTicks / 1e7
      }
      await expect.poll(() => position(A)).toBeGreaterThanOrEqual(5)
      await expect.poll(() => position(B)).toBeGreaterThanOrEqual(15)
      expect(await position(A)).toBeLessThan(15)
      // Own viewers: no guest-mode banner (/streamiq/status "viewer").
      await expect(a.getByText(/guest mode/)).toHaveCount(0)
      await expect(b.getByText(/guest mode/)).toHaveCount(0)
    })

    await test.step("A signs out, B signs in on A's tab: reload, B's resume", async () => {
      // The Resume spot's progress: the saved position.
      const resume = (re: RegExp) =>
        expect(
          a.getByRole('progressbar', { name: /streamiq e2e clip/ }),
        ).toHaveAttribute('aria-valuetext', new RegExp(`^${re.source} of`))
      await resume(/0:0[5-9]/) // A's, over A's open tunnel
      await a.evaluate(() => ((window as { mark?: 1 }).mark = 1))
      await a.getByRole('link', { name: 'Settings' }).click() // sign out lives there
      await openCategory(a, 'Account')
      await a.getByRole('button', { name: 'Sign out' }).click()
      await expect(a.getByLabel('Email')).toBeVisible()
      expect(
        await a.evaluate(() => (window as { mark?: 1 }).mark),
      ).toBeUndefined() // reloaded
      await signIn(a, B, A.tenantId) // same URL: Settings
      await a.goBack() // the gateway's library home, freshly loaded
      await resume(/0:1[5-9]/)
    })

    // The one test with a paired member: its card lists only itself (the 403 on another's key: pairing/api_test.go).
    await test.step('B (member) unpairs its own browser from the card (#341)', async () => {
      await b.goto(appUrl('/gateways'))
      await openGateway(b)
      const card = b.locator('li.card')
      await card.getByText('Paired clients', { exact: true }).click()
      const clients = card.locator('.clients li')
      await expect(clients).toHaveCount(1)
      await expect(clients).toContainText('(this browser)')
      b.once('dialog', (d) => d.accept())
      await clients.getByRole('button', { name: 'Remove' }).click()
      await expect(
        card.getByText('This browser was removed: pair it again.'),
      ).toBeVisible()
    })
  },
)
