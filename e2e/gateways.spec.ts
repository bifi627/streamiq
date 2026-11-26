// The gateways overview and a gateway's page, on a paired browser with its own
// gateway (fixtures.ts `paired`): the overview's cards (status dot, Add, Pair,
// Test, Switch), the page (menu, banner, Pair, tiles, not found, Libraries on
// e2e's BYO Jellyfin and on one the gateway set up), rename, the
// relay switch, Status paired and unpaired, the shell's
// connection badge (checked, live, offline, names only when there's more than one), paired clients, the member view, the health history, Activity
// read from the gateway (an admin's household, a member's own), Reject on the
// local gateway page, Approve from the web gateway page, It doesn't on the code, a refused broker socket and TV mode.
// Onboarding through the UI is smoke.spec's, restart, backup, a new certificate,
// the removes that end sessions and an evicted key lifecycle.spec's; the offline
// dot (90 s), rejection edge cases and a member's own client list are the Go API
// tests and multi-user.
import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { addLibraries } from './jellyfin.ts'
import { gatewayAdmin, startJellyfin } from './stack.ts'
import {
  appUrl,
  editGateways,
  gatewayTab,
  historyTunnels,
  join,
  newContext,
  openGateway,
  onboardGateway,
  openLibrary,
  pair,
  seedHealth,
  seedTunnels,
  signedInPage,
  signUp,
  tunnelOk,
  uniqueEmail,
  type User,
  openCategory,
  openActivity,
  openHouseholds,
} from './helpers.ts'
import { must } from './must.ts'

const card = (p: Page) => p.locator('li.card')
/** The web gateway page's body (the title row is the shell's). */
const detail = (p: Page) => p.locator('.gateway-page')
/** The web gateway page's tile titled name, opened. */
async function tile(p: Page, name: string) {
  await detail(p).locator('summary', { hasText: name }).click()
  return detail(p).locator('details[open]', { hasText: name })
}
const menu = (p: Page) => p.getByRole('button', { name: 'Gateway actions' })
const title = (p: Page) => p.getByRole('heading', { level: 1 })
/** Another browser of user (own client key), never paired, on Gateways. */
const second = (browser: Browser, user: User) =>
  signedInPage(browser, user, '/gateways')

test('rename from the menu once paired (Pair on the page), Escape cancels, Enter saves a trimmed name @gateways', async ({
  browser,
  paired,
}) => {
  const { user, gateway, gatewayCtx } = paired
  const b = await second(browser, user)
  await openGateway(b)
  const renameItem = b.getByRole('menuitem', { name: 'Rename' })
  const pairBtn = detail(b).getByRole('button', { name: 'Pair this browser' })
  await expect(pairBtn).toBeVisible() // the pin check is done
  // Rename goes over the tunnel: not offered until this browser is paired;
  // Remove is an admin's, paired or not.
  await menu(b).click()
  await expect(b.getByRole('menuitem', { name: 'Remove' })).toBeVisible()
  await expect(renameItem).toHaveCount(0)
  await b.keyboard.press('Escape')
  await expect(b.getByRole('menu')).toHaveCount(0)
  await expect(menu(b)).toBeFocused()
  await pair(b, gatewayCtx, gateway.pageUrl) // the page's Pair this browser
  await expect(pairBtn).toHaveCount(0)

  const input = b.getByRole('textbox', { name: 'Gateway name' })
  const heading = title(b)
  const before = must(await heading.textContent(), 'gateway name heading text')
  await menu(b).click()
  await renameItem.click() // no reload
  await expect(input).toHaveValue(before)
  await input.fill('discarded')
  await b.keyboard.press('Escape') // cancels
  await expect(heading).toHaveText(before)
  await expect(menu(b)).toBeFocused() // D-pad keeps its place
  await menu(b).click()
  await renameItem.click()
  await input.fill('  Living room NAS  ')
  await b.keyboard.press('Enter') // saves
  await expect(heading).toHaveText('Living room NAS')
  await expect(menu(b)).toBeFocused()
  // The gateway owns it: its local page shows it at once, and the API learns
  // it from the early heartbeat (a reload reads the list again).
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  await expect(
    local.getByRole('heading', { name: 'StreamIQ gateway · Living room NAS' }),
  ).toBeVisible()
  await b.reload() // the page reopens from its URL
  await expect(title(b)).toHaveText('Living room NAS')
})

test('not found: an unknown gateway id says so, with a link to Gateways @gateways', async ({
  paired,
}) => {
  const { page } = paired
  await page.goto(appUrl('/gateways/00000000-0000-0000-0000-000000000000'))
  await expect(
    page.getByText("This gateway isn't in the household."),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Go to your gateways' }).click()
  await expect(page).toHaveURL(/\/gateways$/)
})

test('page: the update banner on top, tiles collapsed, Status with Version, the local gateway page link and Connection (#870), Libraries on a BYO Jellyfin (#429) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  await editGateways(page, (list: object[]) =>
    list.map((g) => ({ ...g, update: '99.0.0' })),
  )
  await openGateway(page)
  await expect(detail(page).locator('.notice').first()).toContainText(
    'Update available: 99.0.0.',
  )
  await expect(detail(page).locator('details[open]')).toHaveCount(0)
  await expect(detail(page).locator('details > summary')).toHaveText([
    'Status',
    'Health',
    'Paired clients',
    'Libraries',
  ])
  // e2e's Jellyfin is BYO: the gateway API answers 409.
  const libraries = await tile(page, 'Libraries')
  await expect(libraries.getByRole('status')).toHaveText(
    "Libraries are managed in your Jellyfin's Dashboard.",
  )
  const status = await tile(page, 'Status')
  await expect(status.getByText(/^Version /)).toBeVisible()
  await expect(
    status.getByRole('link', { name: 'Local gateway page' }),
  ).toBeVisible()
  await expect(
    status.getByRole('heading', { name: 'Connection' }),
  ).toBeVisible()
  // On this page only what the gateway is: no Open, no Use as screen.
  await expect(page.getByRole('button', { name: 'Open' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Use as screen' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('relay switch: off over the tunnel, mirrored by the API; direct only after (#785) @gateways', async ({
  paired,
}) => {
  const { page, user } = paired
  await openGateway(page)
  const gatewayUrl = page.url()
  const row = async () =>
    (await user.api<{ id: string; relayOff: boolean }[]>('/gateways'))[0]
  const relay = detail(page).getByRole('checkbox', {
    name: 'Allow the relay (TURN)',
  })
  const status = await tile(page, 'Status')
  await expect(relay).toBeChecked()
  await expect(status.getByText(/strict NAT can't connect/)).toBeVisible() // what off costs, next to the switch
  await relay.click() // the box follows the gateway's answer, not the click
  await expect(relay).not.toBeChecked()
  // The gateway stores it and tells the API with an early heartbeat.
  await expect.poll(async () => (await row()).relayOff).toBe(true)
  await page.reload()
  await tile(page, 'Status')
  await expect(relay).not.toBeChecked()

  // The broker sends STUN only: a forced relay fails and says why.
  await page.goto(appUrl(`/g/${(await row()).id}?relay`))
  await expect(
    page.getByText(/^This gateway allows direct connections only/),
  ).toBeVisible()
  // /diagnostics: the relay is off, the forced-relay test skipped, direct works.
  await page.goto(appUrl('/diagnostics'))
  await expect(
    page.getByText('Relay: off for this gateway (direct connections only)'),
  ).toBeVisible()
  await expect(
    page.getByLabel('Force relay (TURN)', { exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(
    page.locator('pre', { hasText: 'StreamIQ diagnostics' }),
  ).toContainText(
    /relay forced: skipped \(relay off for this gateway\)[\s\S]*relay: off \(this gateway allows direct connections only\)[\s\S]*path: direct/,
    { timeout: 30_000 },
  )

  await page.goto(gatewayUrl)
  await tile(page, 'Status')
  await relay.click()
  await expect(relay).toBeChecked()
  await expect.poll(async () => (await row()).relayOff).toBe(false)
})

// Its own Jellyfin: a managed one belongs to the one gateway that set it up.
test('managed Jellyfin: the gateway sets it up; Libraries lists, Online lookups off survives a reload, Rescan; Status says CPU (#969) @gateways', async ({
  browser,
}) => {
  // CI: global setup started it before any browser opened (retries: 0, so it
  // stays fresh); locally only when this test runs.
  const ready = process.env.E2E_JELLYFIN_MANAGED_URL
  const jf = ready
    ? { url: ready, stop: async () => {} }
    : await startJellyfin({ managed: true }, undefined, 'jellyfin managed')
  const user = await signUp(uniqueEmail('managed'))
  const gateway = await onboardGateway(user, jf.url)
  const gatewayCtx = await newContext(browser)
  try {
    await addLibraries(jf.url, await gatewayAdmin(gateway))
    const page = await signedInPage(browser, user, '/gateways')
    await pair(page, gatewayCtx, gateway.pageUrl)
    await openGateway(page)
    const status = await tile(page, 'Status')
    await expect(status.getByText('Transcoding: CPU')).toBeVisible({
      timeout: 15_000,
    })
    const libraries = await tile(page, 'Libraries')
    await expect
      .poll(async () =>
        (await libraries.locator('.lib-head b').allInnerTexts()).sort(),
      )
      .toEqual(['Movies', 'Shows'])
    const movies = libraries.locator('li', { hasText: 'Movies' })
    const online = movies.getByRole('checkbox', { name: 'Online lookups' })
    await expect(online).toBeChecked()
    await online.click() // the box follows Jellyfin's answer
    await expect(online).not.toBeChecked()
    await page.reload() // read from Jellyfin again
    await tile(page, 'Libraries')
    await expect(online).not.toBeChecked()
    await movies.getByRole('button', { name: 'Rescan' }).click()
    await expect(movies.getByText(/^(Rescan queued…|Scanning)$/)).toBeVisible()
    await expect(movies.getByRole('button', { name: 'Rescan' })).toBeVisible({
      timeout: 60_000,
    })
  } finally {
    await gatewayCtx.close()
    await gateway.stop()
    await jf.stop()
  }
})

test('status, paired: details from the gateway API (#140) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  await openGateway(page)
  await tile(page, 'Status')
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
  await openGateway(b)
  await tile(b, 'Status')
  await expect(b.getByText(/StreamIQ: connected/)).toBeVisible()
  await expect(
    b.getByText('Details: pair this browser to see them'),
  ).toBeVisible({ timeout: 15_000 })
  await expect(b.getByText(/Jellyfin:|Paired browsers/)).toHaveCount(0)
})

// The shell's badge: the active gateway, its dot and the connection type.
const badge = (p: Page) => p.locator('header .chip')

test('connection badge: one check on a fresh load off the library, its tunnel closed, none on navigating (#860) @gateways', async ({
  paired,
}) => {
  const { page, user, gateway } = paired
  const [g] = await user.api<{ name: string }[]>('/gateways')
  const checks = (since: number) =>
    historyTunnels(gateway.stateDir).filter(
      (l) => l.use === 'management' && Date.parse(l.createdAt) >= since,
    )
  const since = Date.now()
  await page.goto(appUrl('/settings'))
  await expect(badge(page).getByRole('img', { name: 'online' })).toBeVisible()
  await expect(
    badge(page).getByRole('button', { name: 'On your network' }), // same host
  ).toBeVisible({ timeout: 30_000 })
  // One gateway, one household: no names in the chip (the popover has them).
  await expect(
    badge(page).getByRole('button', { name: 'On your network' }),
  ).not.toContainText(g.name)
  await expect(badge(page).locator('.initial')).toHaveCount(0)
  // Its tunnel closed once answered: the gateway wrote its line.
  await expect.poll(() => checks(since).length, { timeout: 15_000 }).toBe(1)
  // The household details open no tunnel until their Activity tile is
  // opened (it reads the gateways).
  const sockets: string[] = []
  const tunnels = () => sockets.filter((u) => u.includes('/broker/ws'))
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await openHouseholds(page)
  await page.locator('li.card.hh.active').getByRole('link').click()
  await expect(page.locator('summary', { hasText: 'Activity' })).toBeVisible()
  await expect(
    badge(page).getByRole('button', { name: 'On your network' }),
  ).toBeVisible()
  // oxlint-disable-next-line playwright/no-wait-for-timeout -- proves no check starts: no state to wait on
  await page.waitForTimeout(2_000)
  expect(tunnels()).toEqual([])
  await page.locator('summary', { hasText: 'Activity' }).click()
  await expect.poll(() => tunnels().length).toBeGreaterThan(0)
})

test('connection badge: live from the library tunnel, which replaced its own badge (#860) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  await openLibrary(page)
  await badge(page).getByRole('button', { name: 'On your network' }).click()
  await expect(
    page.getByText(/end-to-end encrypted · never leaves the house/),
  ).toBeVisible()
})

test('connection badge: a browser without a pin shows Not paired and opens no tunnel @gateways', async ({
  browser,
  paired,
}) => {
  const { user } = paired
  const b = await signedInPage(browser, user, '/settings')
  // A tunnel would have been refused: "Can't connect".
  await expect(badge(b).getByRole('link', { name: 'Not paired' })).toBeVisible()
})

test('connection badge: an offline gateway shows offline and opens no tunnel (#860) @gateways', async ({
  paired,
}) => {
  const { page, user } = paired
  const [g] = await user.api<{ name: string }[]>('/gateways')
  await editGateways(page, (list: object[]) =>
    list.map((x) => ({ ...x, online: false })),
  )
  const sockets: string[] = []
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await page.goto(appUrl('/settings'))
  await expect(badge(page)).toContainText('offline')
  await expect(badge(page)).not.toContainText(g.name) // the only one
  await expect(badge(page).getByRole('img', { name: 'offline' })).toBeVisible()
  await expect(badge(page).getByText('Checking…')).toHaveCount(0)
  expect(sockets.filter((u) => u.includes('/broker/ws'))).toEqual([])
})

// A second gateway (a fake, offline, so the real one stays active)
// brings the name; a second household brings its initial, inside the one
// button, whose popover names both.
test('connection badge: the gateway name with 2+ gateways, the household initial with 2+ households, both in the popover (#909) @gateways', async ({
  paired,
}) => {
  const { page, user } = paired
  const [g] = await user.api<{ id: string; name: string }[]>('/gateways')
  await editGateways(page, (list: object[]) => [
    ...list,
    { ...list[0], id: 'fake-2', name: 'Other', online: false },
  ])
  await join(await signUp(uniqueEmail('host')), user)
  const me = await user.api<{
    tenantId: string
    memberships: { id: string; name: string | null }[]
  }>('/me')
  const own = must(
    me.memberships.find((m) => m.id === me.tenantId),
    'own membership',
  )
  const label = own.name ?? `Household …${own.id.slice(-6)}`
  await page.goto(appUrl('/settings'))
  const button = badge(page).getByRole('button', { name: 'On your network' })
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toContainText(g.name)
  const initial = button.locator('.initial')
  await expect(initial).toHaveText(label[0].toUpperCase())
  await expect(badge(page).locator('button, a')).toHaveCount(1) // one focus stop
  await initial.click()
  await expect(badge(page).getByText(`${g.name} in ${label}`)).toBeVisible()
})

test('paired clients: name, list, rename own, remove other (stream stops), remove self (#311, #365) @gateways', async ({
  browser,
  paired,
}) => {
  const { page: a, user, gateway, gatewayCtx } = paired
  const b = await second(browser, user)
  await pair(b, gatewayCtx, gateway.pageUrl, true)
  // Right after pairing, B names itself: prefilled with the paired name.
  const name = b.getByLabel('Name this browser')
  await expect(name).toHaveValue(/ on /) // "Chrome on Linux" etc.
  await name.fill("  B's phone ")
  await b.getByRole('button', { name: 'Save' }).click()
  await expect(name).toBeHidden()
  await b.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await openLibrary(b)
  const movies = b.getByRole('button', { name: /Movies/ })
  await expect(movies).toBeVisible() // B's live session

  await openGateway(a)
  const summary = detail(a).locator('summary', { hasText: 'Paired clients' })
  await summary.click()
  const clients = detail(a).locator('.clients li')
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
  const field = detail(a).getByLabel('Client name')
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
  // B's library opens a new tunnel: refused.
  await expect(b.locator('[role=alert][data-kind="not-paired"]')).toBeVisible()
  await b
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Gateways' })
    .click()
  // B's pin is stale until a tunnel is refused: the overview's Test finds out.
  await card(b).getByRole('button', { name: 'Test' }).click()
  await expect(
    b.getByText('this browser is not paired with the gateway'),
  ).toBeVisible()
  await expect(card(b).getByRole('button', { name: 'Pair' })).toBeVisible()

  // Remove A itself: the reply still arrives, then the page offers Pair.
  const pairA = detail(a).getByRole('button', { name: 'Pair this browser' })
  await expect(pairA).toHaveCount(0)
  a.once('dialog', (d) => d.accept())
  await self.getByRole('button', { name: 'Remove' }).click()
  await expect(
    detail(a).getByText('This browser was removed: pair it again.'),
  ).toBeVisible()
  await expect(summary).toBeFocused()
  await expect(pairA).toBeVisible()
  await pair(a, gatewayCtx, gateway.pageUrl)
  await expect(clients).toHaveCount(1) // the list reloads once paired
  await expect(pairA).toHaveCount(0)
})

test('member view: the same card, no Add gateway, no menu on the page (#190) @gateways', async ({
  browser,
  paired,
}) => {
  const { user } = paired
  const [g] = await user.api<{ name: string }[]>('/gateways')
  const member = await signUp(uniqueEmail('gw-member'))
  await join(user, member)
  const m = await signedInPage(browser, member, '/gateways', user.tenantId)
  const online = card(m).getByRole('img', { name: 'Online' })
  await expect(card(m).getByRole('link', { name: g.name })).toBeVisible()
  await expect(online).toBeVisible() // card loaded
  // The role is in (/me): the households overview shows it. Before that
  // both buttons are hidden for anyone.
  await openHouseholds(m)
  await expect(m.locator('li.card.hh.active')).toContainText('Member')
  await m.getByRole('link', { name: 'Gateways' }).click()
  await expect(online).toBeVisible()
  await expect(m.getByRole('button', { name: 'Add gateway' })).toHaveCount(0)
  // Not paired here: Pair, no Test; Active, as the household's only gateway.
  await expect(card(m).getByText('Active', { exact: true })).toBeVisible()
  await expect(card(m).getByRole('button', { name: 'Pair' })).toBeVisible()
  await expect(card(m).getByRole('button', { name: 'Test' })).toHaveCount(0)
  await openGateway(m)
  await expect(title(m)).toHaveText(g.name)
  await expect(
    detail(m).getByRole('button', { name: 'Pair this browser' }),
  ).toBeVisible() // the pin check is done
  await expect(menu(m)).toHaveCount(0) // neither Rename nor Remove
})

test("health history: an incident, a version change and daily peaks from the gateway's own rows (#424, #781) @gateways", async ({
  paired,
}) => {
  const { page, gateway } = paired
  const base = { jellyfin: '10.11.2', gateway: '1.4.0', tunnels: 0, cpu: 10 }
  // Before the row the gateway recorded at its start: sorted by time on the way out.
  seedHealth(gateway.stateDir, [
    { ...base, minAgo: 9, reachable: true },
    { ...base, minAgo: 7, reachable: false },
    {
      ...base,
      minAgo: 4,
      reachable: true,
      jellyfin: '10.11.3',
      tunnels: 2,
      cpu: 100, // no live reading is higher
    },
    { ...base, minAgo: 1, reachable: true, jellyfin: '10.11.3' },
  ])
  await openGateway(page)
  const c = await tile(page, 'Health')
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
  // The gateway's own row, recorded at its start, follows the seeded ones.
  await expect(
    c.getByRole('table', { name: 'Version changes' }).getByRole('row', {
      name: /Gateway 1\.4\.0 /,
    }),
  ).toBeVisible()
  // The row's local day: whichever it is, its peaks are these.
  await expect(
    c.getByRole('table', { name: 'Daily peaks' }).getByRole('row', {
      name: / 2\s+100%/,
    }),
  ).toBeVisible()
})

test("activity: an admin sees the household, a member only their own, from the gateway's history (#782) @gateways", async ({
  browser,
  paired,
}) => {
  const { page: a, user, gateway, gatewayCtx } = paired
  const [g] = await user.api<{ id: string; name: string }[]>('/gateways')
  const member = await signUp(uniqueEmail('act-member'), { alias: 'Bob' })
  await join(user, member)
  // The old URL: the household details with the Activity tile open.
  const m = await signedInPage(browser, member, '/activity', user.tenantId)
  await expect(m).toHaveURL(/\/settings\/household#activity$/)
  // Not paired with this browser: named, no rows.
  await expect(m.getByText(`${g.name}: history unavailable`)).toBeVisible()
  await m.getByRole('link', { name: 'Gateways', exact: true }).click()
  await pair(m, gatewayCtx, gateway.pageUrl)
  seedTunnels(gateway.stateDir, g.id, [
    { userId: user.userId, use: 'playback', relay: false, bytes: 1000 },
    { userId: member.userId, use: 'playback', relay: true, bytes: 2_000_000 },
  ])
  const playback = new RegExp(`${g.name} Playback`)

  await openActivity(a)
  // Bob's count and failures include his pairing tunnels; only the seeded one was relayed.
  const summary = a.getByRole('table', { name: "Members' activity" })
  await expect(
    summary.getByRole('row', { name: /Bob \d+ \d+ 2 MB/ }),
  ).toBeVisible()
  await expect(summary.getByRole('row', { name: user.email })).toBeVisible() // the admin's own
  const tunnels = a.getByRole('table', { name: 'Tunnels' })
  await expect(
    tunnels.getByRole('row', { name: new RegExp(`Bob ${g.name} Playback`) }),
  ).toBeVisible()
  // A phone: the table scrolls inside the tile, not the page.
  await a.setViewportSize({ width: 360, height: 800 })
  await expect
    .poll(() => a.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(360)
  await a.setViewportSize({ width: 1280, height: 720 })
  await a
    .getByRole('combobox', { name: 'Member' })
    .selectOption({ label: 'Me' })
  await expect(tunnels.getByRole('row', { name: /Bob/ })).toHaveCount(0)
  await expect(tunnels.getByRole('row', { name: playback })).toHaveCount(1)

  await openActivity(m)
  await expect(m.getByRole('row', { name: playback })).toHaveCount(1) // Bob's own
  await expect(m.getByRole('table', { name: "Members' activity" })).toHaveCount(
    0,
  )
  await expect(m.getByRole('combobox', { name: 'Member' })).toHaveCount(0)
})

test('reject on the local gateway page: refused, stays unpaired @gateways', async ({
  browser,
  paired,
}) => {
  const { user, gateway, gatewayCtx } = paired
  const b = await second(browser, user)
  await card(b).getByRole('button', { name: 'Pair' }).click() // starts at once
  const dialog = b.getByRole('dialog')
  const code = must(
    await b.getByLabel('Comparison code').textContent(),
    'comparison code',
  )
  const local = await gatewayTab(gatewayCtx, gateway.pageUrl)
  const request = local.locator('form[action="/decide"]')
  await expect(request).toContainText(code) // page self-refreshes every 3s
  await request.getByRole('button', { name: 'Reject' }).click()
  await expect(
    dialog.getByText('The gateway refused this browser.'),
  ).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Pair this browser' }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(
    dialog.getByText('this browser is not paired with the gateway'),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(card(b).getByRole('button', { name: 'Pair' })).toBeVisible()
})

test("It doesn't: the attempt ends unpaired, pairing again gets a code @gateways", async ({
  browser,
  paired,
}) => {
  const b = await second(browser, paired.user)
  const dialog = b.getByRole('dialog')
  await card(b).getByRole('button', { name: 'Pair' }).click()
  await expect(dialog.getByLabel('Comparison code')).toBeVisible()
  await expect(dialog).toContainText('Does the gateway show this code?')
  await dialog.getByRole('button', { name: "It doesn't" }).click()
  await expect(dialog.getByText("The codes didn't match")).toBeVisible()
  await expect(dialog).toContainText('Paired clients on the web gateway page')
  // The tunnel closed: the user's one pairing slot is free again.
  await dialog.getByRole('button', { name: 'Pair this browser' }).click()
  await expect(dialog.getByLabel('Comparison code')).toBeVisible()
})

test('closing the dialog mid-pairing frees the slot: pairing again gets a code @gateways', async ({
  browser,
  paired,
}) => {
  const { user } = paired
  const b = await second(browser, user)
  const pairBtn = card(b).getByRole('button', { name: 'Pair' })
  await pairBtn.click()
  await expect(b.getByLabel('Comparison code')).toBeVisible()
  await b.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  // One pairing slot per user: a slot still held would make this one "busy".
  await pairBtn.click()
  await expect(b.getByLabel('Comparison code')).toBeVisible()
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
  await openGateway(page)
  const refused = /Couldn't reach StreamIQ\. Wait a minute and try again\./

  const clients = await tile(page, 'Paired clients')
  await expect(clients.getByRole('status')).toHaveText(refused)

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await expect(page).toHaveURL(/\/g\/[^/]+$/) // left the page: not its note
  await expect(page.locator('[data-kind="broker-unreachable"]')).toContainText(
    refused,
  )
})

test('overview: status dots, the active card first, Switch → the Library tab opens that gateway (#869) @gateways', async ({
  paired,
}) => {
  const { page, user } = paired
  const [g] = await user.api<{ id: string; name: string }[]>('/gateways')
  // Three more, only list rows: no pin here, so Pair, not Switch.
  const fake = (id: string, name: string, x: object) => ({
    ...g,
    id,
    name,
    online: false,
    ...x,
  })
  await editGateways(page, ([real]: object[]) => [
    fake('update-gw', 'Office', { online: true, update: '99.0.0' }),
    fake('old-gw', 'Attic', { upgradeRequired: true }),
    real,
    fake('offline-gw', 'Cabin', {}),
  ])
  // Cabin was the last opened on this device: the active one.
  await page.evaluate(() =>
    localStorage.setItem('streamiq.lastGateway', 'offline-gw'),
  )
  await page.goto(appUrl('/gateways'))
  const cards = card(page)
  await expect(cards).toHaveCount(4)
  await expect(cards.first()).toContainText('Cabin')
  await expect(cards.first().getByText('Active', { exact: true })).toBeVisible()
  await expect(
    cards.first().getByRole('button', { name: 'Pair' }),
  ).toBeVisible()
  const byName = (n: string) => cards.filter({ hasText: n })
  for (const [n, dot] of [
    [g.name, 'Online'],
    ['Cabin', 'Offline'],
    ['Office', 'Update available'],
    ['Attic', 'Update required'],
  ])
    await expect(byName(n).getByRole('img', { name: dot })).toBeVisible()
  await expect(byName('Attic')).toContainText(/Update required: rerun/)

  // Switch: it moves first, Cabin offers Pair again, the page stays.
  await byName(g.name).getByRole('button', { name: 'Switch' }).click()
  await expect(cards.first()).toContainText(g.name)
  await expect(cards.first().getByText('Active', { exact: true })).toBeVisible()
  await expect(
    byName('Cabin').getByRole('button', { name: 'Pair' }),
  ).toBeVisible()
  await expect(page).toHaveURL(/\/gateways$/)

  // Test: today's connection test, its route on the card (same host: LAN).
  await cards.first().getByRole('button', { name: 'Test' }).click()
  await expect(
    cards.first().getByRole('button', { name: 'On your network' }),
  ).toBeVisible({ timeout: 30_000 })

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/g/${g.id}$`))
  await page.unrouteAll({ behavior: 'ignoreErrors' }) // the library still polls
})

test('overview: Add gateway opens the install commands in a dialog; a click on the card opens its page (#869) @gateways', async ({
  paired,
}) => {
  const { page, user } = paired
  const [g] = await user.api<{ id: string }[]>('/gateways')
  await page.getByRole('button', { name: 'Add gateway' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a gateway' })
  await expect(dialog.locator('pre').first()).toContainText('STREAMIQ_API_URL=')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  // Outside the buttons: the card's link covers it.
  const c = card(page)
  const box = must(await c.boundingBox(), 'card box')
  await page.mouse.click(box.x + box.width - 8, box.y + 8)
  await expect(page).toHaveURL(new RegExp(`/gateways/${g.id}$`))
})

test('TV mode: the overview keeps Active and Test, no Add; a web gateway page hands off (#663) @gateways', async ({
  paired,
}) => {
  const { page } = paired
  const add = page.getByRole('button', { name: 'Add gateway' })
  await expect(add).toBeVisible() // an admin
  await openGateway(page)
  const gatewayUrl = page.url()
  await page.goto(appUrl('/settings'))
  await openCategory(page, 'Display')
  await page.getByLabel('TV mode').check()
  await page.goto(appUrl('/gateways'))
  await expect(card(page).getByText('Active', { exact: true })).toBeVisible()
  await expect(card(page).getByRole('button', { name: 'Test' })).toBeVisible()
  await expect(add).toBeHidden()
  await page.goto(gatewayUrl)
  await expect(
    page.getByRole('heading', { name: 'Do this on your phone or PC' }),
  ).toBeVisible()
})

test('TV mode: the pairing code names the local gateway page URL (#676) @gateways', async ({
  browser,
  paired,
}) => {
  const b = await second(browser, paired.user)
  const box = b.getByRole('dialog').locator('.pair-box')
  const pairCode = async () => {
    await card(b).getByRole('button', { name: 'Pair' }).click()
    await expect(box.getByLabel('Comparison code')).toBeVisible()
  }
  await pairCode() // no reload before: too soon lands on the sign-in page
  await expect(
    box.getByRole('link', { name: 'local gateway page' }),
  ).toBeVisible()
  await b.goto(appUrl('/settings'))
  await openCategory(b, 'Display')
  await b.getByLabel('TV mode').check()
  await b.goto(appUrl('/gateways'))
  await pairCode()
  await expect(box).toContainText(
    /Open the local gateway page \(https?:\/\/\S+\) on your home network/,
  )
  await expect(box.getByRole('link')).toHaveCount(0)
})

test('an admin approves a pairing request from the web gateway page (#956) @gateways', async ({
  browser,
  paired,
}) => {
  const { user, page: a, gateway, gatewayCtx } = paired
  await openGateway(a)
  const b = await second(browser, user)
  await card(b).getByRole('button', { name: 'Pair' }).click()
  const code = await b.getByLabel('Comparison code').textContent()
  const local = (await gatewayTab(gatewayCtx, gateway.pageUrl)).locator(
    'form[action="/decide"]',
  )
  await expect(local).toContainText('Compare this code with theirs')
  const request = a.getByRole('region', { name: 'Pairing requests' })
  await expect(request.getByLabel('Comparison code')).toHaveText(code ?? '')
  await expect(request).toContainText('Compare this code with theirs')
  await request.getByRole('button', { name: 'Approve' }).click()
  await expect(request).toHaveCount(0)
  await b.getByRole('button', { name: 'It matches' }).click()
  await tunnelOk(b)
})
