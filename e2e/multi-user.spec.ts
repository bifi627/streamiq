// Two users of one household over the real tunnel (#243): each plays as their own
// Jellyfin viewer (#195), and switching accounts in one tab reloads, so no open
// tunnel carries the old user into the new one (App.tsx).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  invite,
  keepPcs,
  newPage,
  pair,
  signIn,
  signUp,
  videoTime,
  viaTunnel,
} from './helpers.ts'
import { jellyfinAdminGet } from './jellyfin.ts'
import { startGateway } from './stack.ts'

const app = () => process.env.E2E_APP_URL!

/** Plays the fixture from the library home to sec, then leaves (saves it). */
async function playTo(p: Page, sec: number) {
  await p.getByRole('button', { name: /Movies/ }).click()
  await p.getByRole('button', { name: /streamiq e2e clip/ }).click()
  await p.getByRole('button', { name: /^(Play|Resume)$/ }).click() // movie page (#204)
  await expect.poll(() => videoTime(p), { timeout: 30_000 }).toBeGreaterThan(0)
  await p.evaluate(
    (s) => (document.querySelector('video')!.currentTime = s),
    sec,
  )
  await expect.poll(() => videoTime(p)).toBeGreaterThan(sec)
  await p.goBack() // leaving the player saves the position
  await p.goBack() // movie page → folder
  await p.goBack() // folder → library home
}

test('two users: own Jellyfin viewers, account switch reloads', async ({
  browser,
}) => {
  const run = test.info().repeatEachIndex
  const A = await signUp(`e2e-multi-a-${run}@streamiq.test`)
  const B = await signUp(`e2e-multi-b-${run}@streamiq.test`)
  await invite(A, B)

  // A's gateway, onboarded the way "Add gateway" does (the golden path drives that UI).
  const { token } = await A.api('/gateways/enrollment-tokens', {
    method: 'POST',
  })
  const gateway = await startGateway(
    fs.mkdtempSync(path.join(os.tmpdir(), 'streamiq-e2e-gateway-')),
    {
      STREAMIQ_API_URL: process.env.E2E_API_URL!,
      STREAMIQ_ENROLL_TOKEN: token,
    },
  )
  try {
    await expect
      .poll(async () => (await A.api('/gateways'))[0]?.online, {
        timeout: 60_000,
      })
      .toBe(true)
    const gatewayCtx = await browser.newContext()
    if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only

    // Each in their own browser (own client key), each paired.
    const open = async (user: typeof A) => {
      const p = await newPage(browser) // own client key
      await keepPcs(p)
      await p.goto(app() + '/gateways')
      await signIn(p, user, A.tenantId)
      await pair(p, gatewayCtx, gateway.pageUrl)
      await p.getByRole('button', { name: 'Open' }).click()
      await expect(p.getByRole('button', { name: /Movies/ })).toBeVisible() // a live session
      return p
    }
    const a = await open(A)
    const b = await open(B)

    await test.step('paired clients: a member sees and removes only itself (#311, #341)', async () => {
      type Client = { keyFp: string; self: boolean }
      const list = await viaTunnel(a, '/streamiq/clients')
      expect(list.status).toBe(200)
      const clients: Client[] = JSON.parse(list.body)
      expect(clients.map((c) => c.self).sort()).toEqual([false, true])
      const own = await viaTunnel(b, '/streamiq/clients')
      expect(own.status).toBe(200)
      const bs: Client[] = JSON.parse(own.body)
      expect(bs.map((c) => c.self)).toEqual([true])
      const aKey = clients.find((c) => c.self)!.keyFp
      const remove = await viaTunnel(b, '/streamiq/clients/remove', {
        keyFp: aKey,
      })
      expect(remove.status).toBe(403)
    })

    await test.step('A and B play to different positions: one Jellyfin viewer each (#195)', async () => {
      await playTo(a, 5)
      await playTo(b, 15)
      const jf = (p: string) =>
        jellyfinAdminGet(process.env.E2E_JELLYFIN_URL!, p)
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
      // Own viewers: no guest-mode banner (#242; /streamiq/status "viewer").
      await expect(a.getByText(/guest mode/)).toHaveCount(0)
      await expect(b.getByText(/guest mode/)).toHaveCount(0)
    })

    await test.step("A signs out, B signs in on A's tab: reload, B's resume", async () => {
      // The Resume spot's progress (#203): the saved position.
      const resume = (re: RegExp) =>
        expect(
          a.getByRole('progressbar', { name: /streamiq e2e clip/ }),
        ).toHaveAttribute('aria-valuetext', new RegExp(`^${re.source} of`))
      await resume(/0:0[5-9]/) // A's, over A's open tunnel
      await a.evaluate(() => ((window as { mark?: 1 }).mark = 1))
      await a.getByRole('link', { name: 'Settings' }).click() // sign out lives there (#201)
      await a.getByRole('button', { name: 'Sign out' }).click()
      await expect(a.getByLabel('Email')).toBeVisible()
      expect(
        await a.evaluate(() => (window as { mark?: 1 }).mark),
      ).toBeUndefined() // reloaded
      await signIn(a, B, A.tenantId) // same URL: Settings (#201)
      await a.goBack() // the gateway's library home, freshly loaded
      await resume(/0:1[5-9]/)
    })

    await test.step('B (member) unpairs its own browser from the card (#341)', async () => {
      await b.goto(app() + '/gateways')
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
  } finally {
    await gateway.stop()
  }
})
