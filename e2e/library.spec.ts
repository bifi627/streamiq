// The library, on a paired browser with its own gateway (fixtures.ts
// `paired`): `/` → the active gateway's library (one gateway; with two, the
// online one, then the last opened), the nav's Library link, the
// shared session, folder deep links (title row + Back) + cache, Recently added,
// Continue watching's order (the spot; a phone's row) and click-through guard, season tabs
// (with the title page's D-pad order)
// and watched marks (the end stops inline playback), inline playback (an episode from Continue
// watching on its series' page, Back stops and stays, a phone), no speed test while browsing. Folder → movie → Play and the Resume spot are
// smoke.spec's; `/` with no gateway, artwork caching and the guest banner
// are elsewhere (shell spec, FE / Go tests).
import type { Page, WebSocket } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  bursts,
  countBursts,
  keepPcs,
  openLibrary as open,
  videoTime,
  viaTunnel,
} from './helpers.ts'
import { must } from './must.ts'

const movies = (p: Page) => p.getByRole('button', { name: /Movies/ })
const recent = (p: Page) =>
  p.locator('section.shelf', {
    has: p.getByRole('heading', { name: 'Recently added' }),
  })
/** From a title page: Play (or Resume), plays past `secs`, back to the title
 * page. Leaving the player saves the position (whole seconds, the
 * click-through guard off unless the test sets it). */
async function play(p: Page, secs = 2) {
  await p.getByRole('button', { name: /^(Play|Resume)$/ }).click()
  await expect
    .poll(() => videoTime(p), { timeout: 30_000 })
    .toBeGreaterThan(secs)
  await p.goBack()
}

test('home: with one gateway, / opens its library (#225) @library', async ({
  paired,
}) => {
  const { page, user } = paired
  const [g] = await user.api<{ id: string }[]>('/gateways')
  await page.goto(appUrl('/'))
  await expect(page).toHaveURL(appUrl(`/g/${g.id}`))
  await expect(movies(page)).toBeVisible()
})

test('home: with two gateways, / opens the online one, then the last opened (#861) @library', async ({
  paired,
}) => {
  const { page, user } = paired
  const list = await user.api<{ id: string }[]>('/gateways')
  const g = list[0]
  const away = '00000000-0000-4000-8000-000000000861'
  // A second, offline gateway, listed first. A fixed list: a fetch through
  // the route races the navigations below (its response gets disposed).
  await page.route('**/api/gateways', (route) =>
    route.fulfill({
      json: [{ ...g, id: away, name: 'Away', online: false }, ...list],
    }),
  )
  // None opened on this device yet.
  await page.evaluate(() => localStorage.removeItem('streamiq.lastGateway'))
  await page.goto(appUrl('/'))
  await expect(page).toHaveURL(appUrl(`/g/${g.id}`))
  await expect(movies(page)).toBeVisible()
  await page.goto(appUrl(`/g/${away}`))
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('streamiq.lastGateway')),
    )
    .toBe(away)
  await page.goto(appUrl('/'))
  await expect(page).toHaveURL(appUrl(`/g/${away}`))
})

test("nav: the Library link leads back to the gateway's library @library", async ({
  paired,
}) => {
  const { page } = paired
  const id = await open(page)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(appUrl('/settings'))
  await nav.getByRole('link', { name: 'Library' }).click()
  await expect(page).toHaveURL(appUrl(`/g/${id}`))
  await expect(movies(page)).toBeVisible()
})

test('library → back → library within 30 s: one shared session (#152) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  let rows = 0 // one broker socket per tunnel
  const count = (ws: WebSocket) => ws.url().endsWith('/broker/ws') && rows++
  // A fresh page: pairing left the card's own shared session open. Counted
  // once the shell badge's own check tunnel has answered.
  await a.reload()
  await expect(
    a.locator('header .chip').getByRole('button', { name: 'On your network' }),
  ).toBeVisible()
  a.on('websocket', count)
  await a.getByRole('button', { name: 'Open' }).click()
  await expect(movies(a)).toBeVisible()
  await a
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Gateways' })
    .click()
  await a.getByRole('button', { name: 'Open' }).click()
  await expect(movies(a)).toBeVisible()
  a.off('websocket', count)
  expect(rows).toBe(1)
})

test('folders: a deep link that survives a reload, back from the cache (#360) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  const id = await open(a)
  await movies(a).click()
  await expect(a).toHaveURL(/\/g\/[^/]+\/i\/[^/]+$/) // folder deep link
  await a.reload() // restores the folder: item loaded by ID over a new tunnel
  // Title row: the folder's name + Back (to the library home), no breadcrumb.
  await expect(
    a.getByRole('heading', { level: 1, name: 'Movies' }),
  ).toBeVisible()
  await expect(a.getByRole('link', { name: 'Movies' })).toHaveCount(0)
  await a.getByRole('button', { name: 'Back' }).click()
  await expect(a).toHaveURL(appUrl(`/g/${id}`))
  await movies(a).click()
  await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
  // Back to a folder seen < 5 min ago: from the query cache, no "Loading…"
  // and no tunnel request on the way.
  await a.getByRole('button', { name: /^(Play|Resume)$/ }).waitFor()
  await a.evaluate(() => {
    const w = window as unknown as { seen: string[] }
    w.seen = []
    const make = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (l, o) {
      w.seen.push(l)
      return make.call(this, l, o)
    }
    new MutationObserver(
      () =>
        document.querySelector('[aria-label=Loading]') &&
        w.seen.push('Loading'),
    ).observe(document.body, { childList: true, subtree: true })
  })
  await a.goBack()
  await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
  const seen = await a.evaluate(
    () => (window as unknown as { seen: string[] }).seen,
  )
  expect(
    seen.filter((l) => /Loading|req:\/Items(\?|\/[^/]+$)/.test(l)),
  ).toEqual([])
})

test('recently added: the fixture items; a movie opens its page (#204) @library', async ({
  paired,
}) => {
  const { page } = paired
  await open(page)
  const row = recent(page)
  for (const name of [
    'streamiq e2e clip',
    'streamiq e2e mp2 default',
    'StreamIQ Test Series',
  ])
    await expect(row.getByRole('button', { name })).toBeVisible()
  await row.getByRole('button', { name: 'streamiq e2e clip' }).click()
  await expect(page).toHaveURL(/\/g\/[^/]+\/i\/[^/]+$/) // not the player
  await expect(
    page.getByRole('heading', { level: 1, name: 'streamiq e2e clip' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible()
})

test('continue watching: newest first; the click-through guard keeps the order (#330) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  await keepPcs(a) // viaTunnel
  await a.reload()
  await open(a)
  const tile = (name: string) => recent(a).getByRole('button', { name }).click()
  const spot = a.locator('.spot h2')
  // Arrange over the tunnel, no player exit save to race: both
  // part-played, the mp2 one played last, so it is the spot although the clip
  // sorts first by name.
  const { Items } = JSON.parse(
    (
      await viaTunnel(
        a,
        '/Items?searchTerm=streamiq%20e2e&recursive=true&includeItemTypes=Movie',
      )
    ).body,
  ) as { Items: { Id: string; Name: string }[] }
  const id = (name: string) =>
    must(
      Items.find((i) => i.Name === name),
      name,
    ).Id
  for (const [name, at] of [
    ['streamiq e2e clip', '2026-01-01T00:00:00Z'],
    ['streamiq e2e mp2 default', '2026-01-02T00:00:00Z'],
  ]) {
    const r = await viaTunnel(a, `/UserItems/${id(name)}/UserData`, {
      PlaybackPositionTicks: 20_000_000,
      LastPlayedDate: at,
    })
    expect(r.status).toBe(200)
  }
  await a.reload()
  await expect(spot).toHaveText('streamiq e2e mp2 default')
  // The guard: a playback shorter than 60 s saves nothing, so the clip
  // doesn't move up. Each save is a `req:/UserItems/<id>/UserData` channel:
  // record them, so a late exit save can't land after the reload below.
  await a.evaluate(() => {
    localStorage.setItem('streamiq.watchMin', '60')
    const w = window as unknown as { saves: string[] }
    w.saves = []
    const make = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (l, o) {
      if (l.endsWith('/UserData')) w.saves.push(l)
      return make.call(this, l, o)
    }
  })
  await tile('streamiq e2e clip')
  await play(a, 5)
  // The movie page's button waits for its refetch after the exit save.
  await expect(a.getByRole('button', { name: 'Resume' })).toBeVisible()
  expect(
    await a.evaluate(() => (window as unknown as { saves: string[] }).saves),
  ).toEqual([])
  await a.goBack()
  await a.evaluate(() => localStorage.setItem('streamiq.watchMin', '0'))
  await a.reload()
  await expect(spot).toHaveText('streamiq e2e mp2 default')
  // A phone: a row of cards in the same order, no spot.
  await a.setViewportSize({ width: 400, height: 800 })
  const row = a.locator('section.shelf', {
    has: a.getByRole('heading', { name: 'Continue watching' }),
  })
  const cards = row.getByRole('button')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveAccessibleName('streamiq e2e mp2 default')
  await expect(cards.nth(1)).toHaveAccessibleName('streamiq e2e clip')
  await expect(spot).toBeHidden()
})

test('seasons: tabs, Season 1 first with its episodes, D-pad hero → tabs → episodes, Season 2 on a click @library', async ({
  paired,
}) => {
  const { page } = paired
  await open(page)
  await recent(page)
    .getByRole('button', { name: 'StreamIQ Test Series' })
    .click()
  const tabs = page.getByRole('tablist', { name: 'Seasons' })
  const episodes = page.getByRole('tabpanel').getByRole('listitem')
  await expect(tabs.getByRole('tab')).toHaveText(['Season 1', 'Season 2'])
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('Season 1')
  await expect(episodes).toHaveText([/S01E01/, /S01E02/])
  // D-pad: the hero card has first focus; Down → the season tabs → episodes.
  await expect(page.locator('button.hero')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(tabs.getByRole('tab', { selected: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(episodes.first().getByRole('button').first()).toBeFocused()
  await tabs.getByRole('tab', { name: 'Season 2' }).click()
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('Season 2')
  await expect(episodes).toHaveText([/S02E01/, /S02E02/])
})

test('watched marks: a finished episode reads Watched, a part-played one its time left @library', async ({
  paired,
}) => {
  const { page: a } = paired
  await open(a)
  await recent(a).getByRole('button', { name: 'StreamIQ Test Series' }).click()
  const episodes = a.getByRole('tabpanel').getByRole('listitem')
  const [first, second] = [episodes.nth(0), episodes.nth(1)]
  // Arrange over the tunnel: E1 to its end, E2 part-played.
  await first.getByRole('button').first().click()
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(0)
  await a
    .locator('video')
    .evaluate((v: HTMLVideoElement) => (v.currentTime = v.duration - 0.5))
  // The end stops inline playback: the hero card is back.
  await expect(a.locator('button.hero')).toBeVisible()
  await second.getByRole('button').first().click()
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(2)
  await a.goBack()

  await expect(first.getByText('Watched', { exact: true })).toBeVisible()
  await expect(first.getByRole('progressbar')).toHaveCount(0)
  await expect(second.getByText(/ left$/)).toBeVisible()
  await expect(
    second.getByRole('progressbar', { name: / watched$/ }),
  ).toBeVisible()
})

test('inline playback: in the hero box, Back stops and stays; an episode from Continue watching plays on its series page, also on a phone @library', async ({
  paired,
}) => {
  const { page: a } = paired
  const id = await open(a)
  await recent(a).getByRole('button', { name: 'StreamIQ Test Series' }).click()
  const tabs = a.getByRole('tablist', { name: 'Seasons' })
  const selected = tabs.getByRole('tab', { selected: true })
  const hero = a.locator('button.hero')
  const inline = a.locator('.hero-player video')
  await tabs.getByRole('tab', { name: 'Season 2' }).click()
  await a.getByRole('tabpanel').getByRole('button').first().click()
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(2)
  await expect(a).toHaveURL(/\/i\/[^/]+\?play=/)
  // In the hero's box, the info column beside it, the title row kept.
  const box = must(await a.locator('.hero-player').boundingBox(), 'hero box')
  const video = must(await inline.boundingBox(), 'inline video box')
  expect(video.y + video.height).toBeLessThanOrEqual(box.y + box.height + 1)
  // The name only in the title row; the overlay: the episode's line, no
  // Back button or badge (the title row's Back and the shell's badge).
  await expect(a.locator('.title-info')).toBeVisible()
  const overlay = a.locator('.player')
  await expect(overlay.getByRole('heading')).toBeHidden()
  await expect(overlay.locator('.now p')).toHaveText(/^S2 · E1 /)
  await expect(
    overlay.getByRole('button', { name: 'Back', exact: true }),
  ).toHaveCount(0)
  await expect(overlay.locator('.badge')).toBeHidden()
  // Keys as before (focus on the page): Escape hides a shown bar, then stops.
  await a.evaluate(() => (document.activeElement as HTMLElement).blur())
  await expect(async () => {
    await a.keyboard.press('Escape')
    await expect(hero).toBeVisible({ timeout: 1000 })
  }).toPass()
  await a.goForward() // playing again: the step Play pushed
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(3)
  await expect(
    a.getByRole('heading', { level: 1, name: 'StreamIQ Test Series' }),
  ).toBeVisible()
  await a.goBack() // stops, stays on the page
  await expect(hero).toBeVisible()
  await expect(inline).toHaveCount(0)
  await expect(a).toHaveURL(/\/i\/[^/?]+$/)
  await a.goBack() // leaves it
  await expect(a).toHaveURL(appUrl(`/g/${id}`))

  // A phone: Continue watching's card → the series page playing that
  // episode on its season's tab; a reload keeps it playing; Back → home.
  await a.setViewportSize({ width: 400, height: 800 })
  await a.reload()
  await a
    .locator('section.shelf', {
      has: a.getByRole('heading', { name: 'Continue watching' }),
    })
    .getByRole('button', { name: /StreamIQ Test Series/ })
    .click()
  await expect(a).toHaveURL(/\/i\/[^/]+\?play=/)
  await expect(selected).toHaveText('Season 2')
  await expect(inline).toBeVisible()
  await expect(a.locator('.now p', { hasText: 'S2 · E1' })).toBeVisible()
  await a.reload()
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(selected).toHaveText('Season 2')
  await a.goBack()
  await expect(a).toHaveURL(appUrl(`/g/${id}`))
})

test('browsing sends no speed test burst @library', async ({ paired }) => {
  const { page } = paired
  await countBursts(page)
  await page.reload()
  await open(page)
  await movies(page).click()
  await page.getByRole('button', { name: 'streamiq e2e clip' }).click()
  await expect(
    page.getByRole('button', { name: /^(Play|Resume)$/ }),
  ).toBeVisible()
  expect(await bursts(page)).toBe(0)
})
