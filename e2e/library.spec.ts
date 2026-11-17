// The library (#409), on a paired browser with its own gateway (fixtures.ts
// `paired`): `/` → the one gateway's library (#225), the nav's Library link, the
// shared session (#152), folder deep links + cache (#360), Recently added
// (#204), Continue watching's order and click-through guard (#330), season tabs
// and watched marks. Folder → movie → Play and the Resume spot are the golden
// path's; `/` with no gateway or several, artwork caching and the guest banner
// are elsewhere (shell spec, FE / Go tests).
import type { Page, WebSocket } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { appUrl, videoTime } from './helpers.ts'

const movies = (p: Page) => p.getByRole('button', { name: /Movies/ })
const recent = (p: Page) =>
  p.locator('section.shelf', {
    has: p.getByRole('heading', { name: 'Recently added' }),
  })
/** Opens the gateway's library from the Gateways card; its id. */
async function open(p: Page) {
  await p.locator('li.card').getByRole('button', { name: 'Open' }).click()
  await expect(movies(p)).toBeVisible()
  return p.url().match(/\/g\/([^/]+)$/)![1]
}
/** From a title page: Play (or Resume), plays past `secs`, back to the title
 * page. Leaving the player saves the position (whole seconds, #330's guard
 * off unless the test sets it). */
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
  a.on('websocket', count)
  // A fresh page: pairing left the card's own shared session open.
  await a.reload()
  await a.getByRole('button', { name: 'Open' }).click()
  await expect(movies(a)).toBeVisible()
  await a.getByRole('link', { name: '← Gateways' }).click()
  await a.getByRole('button', { name: 'Open' }).click()
  await expect(movies(a)).toBeVisible()
  a.off('websocket', count)
  expect(rows).toBe(1)
})

test('folders: a deep link that survives a reload, back from the cache (#360) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  await open(a)
  await movies(a).click()
  await expect(a).toHaveURL(/\/g\/[^/]+\/i\/[^/]+$/) // folder deep link
  await a.reload() // restores the folder: item loaded by ID over a new tunnel
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
  await open(a)
  const tile = (name: string) => recent(a).getByRole('button', { name }).click()
  const spot = a.locator('.spot h2')
  // The clip sorts first by name; played second, the mp2 one is the spot.
  for (const name of ['streamiq e2e clip', 'streamiq e2e mp2 default']) {
    await tile(name)
    await play(a) // → movie page
    await a.goBack() // → library home
  }
  // The exit save is fire-and-forget: a reload can close the tunnel first.
  await expect(async () => {
    await a.reload()
    await expect(spot).toHaveText('streamiq e2e mp2 default', {
      timeout: 3000,
    })
  }).toPass()
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
  // The movie page's button waits for its refetch after the exit save (#378).
  await expect(a.getByRole('button', { name: 'Resume' })).toBeVisible()
  expect(
    await a.evaluate(() => (window as unknown as { saves: string[] }).saves),
  ).toEqual([])
  await a.goBack()
  await a.evaluate(() => localStorage.setItem('streamiq.watchMin', '0'))
  await a.reload()
  await expect(spot).toHaveText('streamiq e2e mp2 default')
})

test('seasons: tabs, Season 1 first with its episodes, Season 2 on a click @library', async ({
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
  await a.evaluate(() => {
    const v = document.querySelector('video')!
    v.currentTime = v.duration - 0.5
  })
  await a.waitForFunction(() => document.querySelector('video')!.ended)
  await a.goBack()
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
