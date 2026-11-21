// The gateways page, on a paired browser with its own gateway (fixtures.ts
// `paired`): rename, Status paired and unpaired, the nav chip's
// dot, paired clients, the member view, health sharing, the health history, Reject on the
// local gateway page, a refused broker socket and TV mode.
// Onboarding, Approve, Test connection and the removes that end sessions are
// the golden path's; the offline dot (90 s), rejection edge cases and a
// member's own client list are backend / Go / multi-user.
import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  gatewayTab,
  join,
  pair,
  seedHealth,
  signedInPage,
  signUp,
  uniqueEmail,
  type User,
} from './helpers.ts'
import { must } from './must.ts'

const card = (p: Page) => p.locator('li.card')
/** Another browser of user (own client key), never paired, on Gateways. */
const second = (browser: Browser, user: User) =>
  signedInPage(browser, user, '/gateways')

test('rename: shown once paired, Escape cancels, Enter saves a trimmed name @gateways', async ({
  browser,
  paired,
}) => {
  const { user, gateway, gatewayCtx } = paired
  const b = await second(browser, user)
  const renameBtn = card(b).getByRole('button', { name: 'Rename' })
  // Rename goes over the tunnel: not offered until this browser is paired.
  await expect(
    card(b).getByRole('button', { name: 'Pair this browser' }),
  ).toBeVisible() // the pin check is done
  await expect(renameBtn).toHaveCount(0)
  await pair(b, gatewayCtx, gateway.pageUrl)
  await expect(renameBtn).toBeVisible() // no reload

  const input = card(b).getByRole('textbox', { name: 'Gateway name' })
  const heading = card(b).getByRole('heading', { level: 2 })
  const before = must(await heading.textContent(), 'gateway name heading text')
  await renameBtn.click()
  await input.fill('discarded')
  await b.keyboard.press('Escape') // cancels
  await expect(heading).toHaveText(before)
  await expect(renameBtn).toBeFocused() // D-pad keeps its place
  await b.keyboard.press('Enter') // reopens from the keyboard
  await input.fill('  Living room NAS  ')
  await b.keyboard.press('Enter') // saves
  await expect(heading).toHaveText('Living room NAS')
  await expect(renameBtn).toBeFocused()
  // The gateway owns it: its local page shows it at once, and the API learns
  // it from the early heartbeat (a reload reads the list again).
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  await expect(
    local.getByRole('heading', { name: 'StreamIQ gateway · Living room NAS' }),
  ).toBeVisible()
  await b.reload()
  await expect(
    b.getByRole('heading', { level: 2, name: 'Living room NAS' }),
  ).toBeVisible()
})

test('status, paired: details from the gateway API (#140) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  await card(page).getByText('Status', { exact: true }).click()
  // e2e's Jellyfin was set up by the test (wizard), not the gateway.
  await expect(
    page.getByText('Transcoding: not managed by StreamIQ'),
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText(/Jellyfin: reachable, version .* · token set/),
  ).toBeVisible()
  await expect(
    page.getByText(/Paired browsers: 1 · open sessions/),
  ).toBeVisible()
  // CPU needs the gateway's first 10 s sample; memory is there at once.
  await expect(page.getByText(/^Load: .*memory .* of /)).toBeVisible()
})

test('status, unpaired: liveness only, details need pairing (#140) @gateways', async ({
  browser,
  paired,
}) => {
  const b = await second(browser, paired.user)
  await card(b).getByText('Status', { exact: true }).click()
  await expect(b.getByText(/StreamIQ: connected/)).toBeVisible()
  await expect(
    b.getByText('Details: pair this browser to see them'),
  ).toBeVisible({ timeout: 15_000 })
  await expect(b.getByText(/Jellyfin:|Paired browsers/)).toHaveCount(0)
})

test("status dot: a gateway route's nav chip shows its name, online (#206) @gateways", async ({
  paired,
}) => {
  const { page, user } = paired
  const [g] = await user.api<{ name: string }[]>('/gateways')
  await card(page).getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/g\/[^/]+$/)
  const chip = page.locator('header .status .chip')
  await expect(chip).toContainText(g.name)
  await expect(chip.getByRole('img', { name: 'online' })).toBeVisible()
})

test('paired clients: name, list, rename own, remove other (stream stops), remove self (#311, #365) @gateways', async ({
  browser,
  paired,
}) => {
  const { page: a, user, gateway, gatewayCtx } = paired
  const b = await second(browser, user)
  await pair(b, gatewayCtx, gateway.pageUrl)
  // Right after pairing, B names itself: prefilled with the paired name.
  const name = b.getByLabel('Name this browser')
  await expect(name).toHaveValue(/ on /) // "Chrome on Linux" etc.
  await name.fill("  B's phone ")
  await b.getByRole('button', { name: 'Save' }).click()
  await expect(name).toBeHidden()
  await card(b).getByRole('button', { name: 'Open' }).click()
  const movies = b.getByRole('button', { name: /Movies/ })
  await expect(movies).toBeVisible() // B's live session

  const summary = card(a).getByText('Paired clients', { exact: true })
  await summary.click()
  const clients = card(a).locator('.clients li')
  await expect(clients).toHaveCount(2)
  const self = clients.filter({ hasText: '(this browser)' })
  await expect(self).toHaveCount(1)
  await expect(self).toContainText(
    `paired ${await a.evaluate(() => new Date().toLocaleDateString())}`,
  )
  await expect(clients.filter({ hasText: "B's phone" })).toHaveCount(1)

  // Rename the own row. The form replaces the row's text (and its
  // "(this browser)"): find it by label.
  await self.getByRole('button', { name: 'Rename' }).click()
  const field = card(a).getByLabel('Client name')
  await expect(field).toHaveAccessibleDescription('') // only the gateway keeps it
  await field.fill('Desk')
  await field.press('Enter')
  await expect(field).toBeHidden()
  await expect(self).toContainText('Desk (this browser)')
  await expect(self.getByRole('button', { name: 'Rename' })).toBeFocused()

  // Remove B: the gateway closes B's PeerConnection.
  a.once('dialog', (d) => d.accept())
  await clients
    .filter({ hasNotText: '(this browser)' })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(clients).toHaveCount(1)
  await expect(summary).toBeFocused() // the D-pad keeps its place
  await movies.click()
  await expect(b.locator('[role=alert][data-kind="tunnel-lost"]')).toBeVisible()
  await b.getByRole('link', { name: '← Gateways' }).click()
  await card(b).getByRole('button', { name: 'Test connection' }).click()
  await expect(
    b.getByText('this browser is not paired with the gateway'),
  ).toBeVisible()

  // Remove A itself: the reply still arrives, then the card offers Pair.
  a.once('dialog', (d) => d.accept())
  await self.getByRole('button', { name: 'Remove' }).click()
  await expect(
    card(a).getByText('This browser was removed: pair it again.'),
  ).toBeVisible()
  await expect(summary).toBeFocused()
  await pair(a, gatewayCtx, gateway.pageUrl)
  await expect(clients).toHaveCount(1) // the list reloads once paired
  await expect(card(a).getByRole('button', { name: 'Open' })).toBeVisible()
})

test('member view: the gateway, no Add gateway, no Remove (#190) @gateways', async ({
  browser,
  paired,
}) => {
  const { user } = paired
  const [g] = await user.api<{ name: string }[]>('/gateways')
  const member = await signUp(uniqueEmail('gw-member'))
  await join(user, member)
  const m = await signedInPage(browser, member, '/gateways', user.tenantId)
  await expect(
    card(m).getByRole('heading', { level: 2, name: g.name }),
  ).toBeVisible()
  await expect(card(m).getByText('Online', { exact: true })).toBeVisible() // card loaded
  // The role is in (/me): the switcher shows the joined household. Before that
  // both buttons are hidden for anyone.
  await expect(m.getByLabel('Switch household')).toHaveValue(user.tenantId)
  await expect(m.getByRole('button', { name: 'Add gateway' })).toHaveCount(0)
  await expect(card(m).getByRole('button', { name: 'Remove' })).toHaveCount(0)
  // Health sharing: the level, no switch.
  await expect(card(m).getByText('Health sharing: off.')).toBeVisible()
  await expect(card(m).getByRole('button', { name: 'Turn on' })).toHaveCount(0)
})

test('health sharing: an admin turns it on and off over the tunnel (#423) @gateways', async ({
  paired,
}) => {
  const c = card(paired.page)
  // The level comes back with the gateway's next heartbeat (sent at once),
  // then the list's 5 s poll.
  await expect(c.getByText('Health sharing: off.')).toBeVisible()
  await c.getByRole('button', { name: 'Turn on' }).click()
  await expect(c.getByText('Health sharing: on.')).toBeVisible({
    timeout: 15_000,
  })
  await c.getByRole('button', { name: 'Turn off' }).click()
  await expect(c.getByText('Health sharing: off.')).toBeVisible({
    timeout: 15_000,
  })
})

test('health history: an incident, a version change and daily peaks from stored rows (#424) @gateways', async ({
  paired,
}) => {
  const { user, page } = paired
  const [g] = await user.api<{ id: string }[]>('/gateways')
  const base = { jellyfin: '10.11.2', gateway: '1.4.0', tunnels: 0, cpu: 10 }
  seedHealth(user.tenantId, g.id, [
    { ...base, minAgo: 9, reachable: true },
    { ...base, minAgo: 7, reachable: false },
    {
      ...base,
      minAgo: 4,
      reachable: true,
      jellyfin: '10.11.3',
      tunnels: 2,
      cpu: 55,
    },
    { ...base, minAgo: 1, reachable: true, jellyfin: '10.11.3' },
  ])
  const c = card(page)
  await c.getByText('Health, last 7 days').click()
  await expect(
    c.getByRole('table', { name: 'Incidents' }).getByRole('row', {
      name: /Jellyfin down .* 3 min/,
    }),
  ).toBeVisible()
  await expect(
    c.getByRole('table', { name: 'Version changes' }).getByRole('row', {
      name: /Jellyfin 10\.11\.2 10\.11\.3/,
    }),
  ).toBeVisible()
  // The row's local day: whichever it is, its peaks are these.
  await expect(
    c.getByRole('table', { name: 'Daily peaks' }).getByRole('row', {
      name: / 2\s+55%/,
    }),
  ).toBeVisible()
})

test('reject on the local gateway page: refused, stays unpaired @gateways', async ({
  browser,
  paired,
}) => {
  const { user, gateway, gatewayCtx } = paired
  const b = await second(browser, user)
  const pairBtn = card(b).getByRole('button', { name: 'Pair this browser' })
  await pairBtn.click()
  const code = must(
    await b.getByLabel('Comparison code').textContent(),
    'comparison code',
  )
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  const request = local.locator('form[action="/decide"]')
  await expect(request).toContainText(code) // page self-refreshes every 3s
  await request.getByRole('button', { name: 'Reject' }).click()
  await expect(b.getByText('The gateway refused this browser.')).toBeVisible()
  await expect(pairBtn).toBeVisible()
  await card(b).getByRole('button', { name: 'Test connection' }).click()
  await expect(
    b.getByText('this browser is not paired with the gateway'),
  ).toBeVisible()
})

test('a refused broker socket shows an error, not "loading…" (#403) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  // A 429'd handshake (STREAMIQ_SIGNALING_PER_MINUTE) is invisible to JS: the
  // socket errors and closes without ever opening. Port 1 (Chrome blocks it)
  // does the same, without using up the shared per-IP budget.
  await page.addInitScript(() => {
    const Real = WebSocket
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(
          String(url).endsWith('/broker/ws') ? 'ws://127.0.0.1:1/' : url,
          protocols,
        )
      }
    }
  })
  await page.reload() // drops the fixture's shared session
  const card = page.locator('li.card')
  const refused = /Couldn't reach StreamIQ: too many attempts or offline/

  await card.getByText('Paired clients', { exact: true }).click()
  await expect(card.getByRole('status')).toHaveText(refused)

  await card.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/g\/[^/]+$/) // left the card: not its note
  await expect(page.locator('[data-kind="broker-unreachable"]')).toContainText(
    refused,
  )
})

test('TV mode: the card keeps Open, Use as screen and Status; managing is hidden (#663) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  const c = card(page)
  const managing = [
    c.getByRole('button', { name: 'Rename' }),
    c.getByRole('button', { name: 'Remove' }),
    c.getByRole('link', { name: 'Gateway page' }),
    c.getByText('Paired clients', { exact: true }),
  ]
  for (const l of managing) await expect(l).toBeVisible() // an admin, paired
  await page.goto(appUrl('/settings'))
  await page.getByLabel('TV mode').check()
  await page.goto(appUrl('/gateways'))
  await expect(c.getByRole('button', { name: 'Open' })).toBeVisible()
  await expect(c.getByRole('link', { name: 'Use as screen' })).toBeVisible()
  await expect(c.getByText('Status', { exact: true })).toBeVisible()
  for (const l of managing) await expect(l).toBeHidden()
})

test('TV mode: no update notice, the pairing code names the gateway page URL (#676) @gateways', async ({
  browser,
  paired,
}) => {
  const b = await second(browser, paired.user)
  // signed in for good: a reload sooner lands on the sign-in page
  await expect(
    card(b).getByRole('button', { name: 'Pair this browser' }),
  ).toBeVisible()
  await b.route('**/api/gateways', async (r) => {
    const res = await r.fetch()
    const gs = (await res.json()) as object[]
    await r.fulfill({
      response: res,
      json: gs.map((g) => ({ ...g, update: '99.0.0' })),
    })
  })
  const box = card(b).locator('.pair-box')
  const pairCode = async () => {
    await b.goto(appUrl('/gateways'))
    await card(b).getByRole('button', { name: 'Pair this browser' }).click()
    await expect(box.getByLabel('Comparison code')).toBeVisible()
  }
  await pairCode()
  await expect(card(b).getByText('Update available')).toBeVisible()
  await expect(box.getByRole('link', { name: 'gateway page' })).toBeVisible()
  await b.goto(appUrl('/settings'))
  await b.getByLabel('TV mode').check()
  await pairCode()
  await expect(card(b).getByText('Update available')).toHaveCount(0) // not mounted: no status call
  await expect(box).toContainText(
    /Open the gateway page \(https?:\/\/\S+\) on your home network/,
  )
  await expect(box.getByRole('link')).toHaveCount(0)
})
