// The library, on a paired browser with its own gateway (fixtures.ts
// `paired`): `/` → the active gateway's library (one gateway; with two, the
// online one, then the last opened), the nav's Library link, the
// shared session, search, cards (one height, title + year line, the folder grid's
// watched bar), folder deep links (title row + Back) + cache, Recently added,
// Continue watching's order (the spot, also on a phone) and click-through guard, Next up, season tabs
// (with the title page's D-pad order)
// and watched marks (the end stops inline playback), inline playback (an episode from Continue
// watching on its series' page, Back leaves and exit stays, page keys stay the page's, a phone), no speed test while browsing. Folder → movie → Play and the Resume spot are
// smoke.spec's; `/` with no gateway, artwork caching and the guest banner
// are elsewhere (shell spec, FE / Go tests). Favorites: the heart (also in TV mode) and its shelf;
// per user: multi-user.spec. Watch history: a view per playback after 10 s (a replay within 3 h
// is the same one), its page (also TV mode). Tags: chips, add/remove, TV mode read-only; seen by
// another member: multi-user.spec.
import type { Page, WebSocket } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  bursts,
  countBursts,
  exitInline,
  keepPcs,
  openCategory,
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
/** From a title page: Play (or Resume), plays past `secs`, exits back to
 * the title page. Leaving the player saves the position (whole seconds, the
 * click-through guard off unless the test sets it). */
async function play(p: Page, secs = 2) {
  await p.getByRole('button', { name: /^(Play|Resume)$/ }).click()
  await expect
    .poll(() => videoTime(p), { timeout: 30_000 })
    .toBeGreaterThan(secs)
  await exitInline(p)
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
  await open(a)
  await expect(movies(a)).toBeVisible()
  await a
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Gateways' })
    .click()
  await open(a)
  a.off('websocket', count)
  expect(rows).toBe(1)
})

test('cards: one height, a one-line title and a year line; the folder grid shows the watched bar, no Play line (#994) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  await keepPcs(a) // viaTunnel
  await a.reload()
  await open(a)
  const { Items } = JSON.parse(
    (
      await viaTunnel(
        a,
        '/Items?searchTerm=streamiq%20e2e&recursive=true&includeItemTypes=Movie',
      )
    ).body,
  ) as { Items: { Id: string; Name: string; ProductionYear?: number }[] }
  const by = (name: string) =>
    must(
      Items.find((i) => i.Name === name),
      name,
    )
  // No year in the fixtures' metadata: an empty line that keeps its height.
  const year = (name: string) => String(by(name).ProductionYear ?? ' ')
  const clip = 'streamiq e2e clip'
  const mp2 = 'streamiq e2e mp2 default'
  await expect(
    recent(a).getByRole('button', { name: clip }).locator('small.card-line'),
  ).toHaveText(year(clip))
  // Unstarted: no bar.
  await movies(a).click()
  const tile = (name: string) => a.locator('.poster-tile', { hasText: name })
  await expect(tile(mp2)).toBeVisible()
  await expect(a.locator('.poster-grid progress')).toHaveCount(0)
  // Arrange: the clip part-played, the mp2 one watched; the reload skips the
  // folder's cached listing.
  for (const [name, data] of [
    [clip, { PlaybackPositionTicks: 20_000_000 }],
    [mp2, { Played: true }],
  ] as const)
    expect(
      (await viaTunnel(a, `/UserItems/${by(name).Id}/UserData`, data)).status,
    ).toBe(200)
  await a.reload()
  await expect(tile(clip).locator('small.card-line')).toHaveText(year(clip))
  await expect(tile(clip).getByRole('progressbar')).toBeVisible()
  await expect(tile(mp2).getByRole('progressbar')).toHaveJSProperty(
    'position',
    1,
  )
  await expect(a.locator('.poster-grid')).not.toContainText(
    /\b(Play|Resume|Watched)\b/,
  )
  await expectFullPosters(a)
  // A title too long for the card is cut off, and every card is one height.
  await tile(clip)
    .locator('span.card-line')
    .evaluate((e) => (e.textContent = 'An overly long title '.repeat(8)))
  const heights = await a
    .locator('.poster-tile')
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height))
  // Whole px: a phone's fluid columns differ by a fraction of a pixel.
  expect(new Set(heights.map(Math.round)).size).toBe(1)
  const line = tile('An overly long title').locator('span.card-line')
  expect(await line.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
  await expect(line).toHaveCSS('text-overflow', 'ellipsis')
  // A phone's two columns stay one width with that title in one of them.
  await a.setViewportSize({ width: 390, height: 844 })
  const widths = await a
    .locator('.poster-tile')
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().width))
  expect(new Set(widths.map(Math.round)).size).toBe(1)
  await expectFullPosters(a)
})

/** Every grid card's poster spans its card's width at 2:3 (not a
 * thin strip in a padded pill button). */
async function expectFullPosters(p: Page) {
  const boxes = await p.locator('.poster-tile').evaluateAll((es) =>
    es.map((e) => {
      const t = e.getBoundingClientRect()
      const r = (e.querySelector('.poster') ?? e).getBoundingClientRect()
      return { tile: t.width, w: r.width, h: r.height }
    }),
  )
  for (const b of boxes) {
    expect(b.w).toBeCloseTo(b.tile, 0)
    expect(b.w / b.h).toBeCloseTo(2 / 3, 1)
  }
}

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

test('search: results replace the shelves, ?q= survives Back, an episode names its series, no match says so (#993) @library', async ({
  paired,
}) => {
  const { page } = paired
  await open(page)
  const field = page.getByRole('searchbox', { name: 'Search' })
  await page.getByRole('button', { name: 'Search' }).click()
  const results = page.getByRole('region', { name: 'Search results' })
  await field.fill('Test Series')
  await expect(page).toHaveURL(/\?q=Test(\+|%20)Series$/)
  await expect(recent(page)).toBeHidden()
  await expect(
    results.getByRole('list', { name: 'Episodes' }).getByRole('button', {
      name: /S01E01.*StreamIQ Test Series · Season 1$/,
    }),
  ).toBeVisible()
  await results
    .getByRole('list', { name: 'Shows' })
    .getByRole('button', { name: /^StreamIQ Test Series(?!.*S0)/ })
    .click()
  await expect(page.getByRole('tablist', { name: 'Seasons' })).toBeVisible()
  await page.goBack()
  await expect(field).toHaveValue('Test Series')
  await expect(results).toBeVisible()
  // A section's heading folds it.
  const episodes = results.getByRole('list', { name: 'Episodes' })
  await results.locator('summary', { hasText: 'Episodes' }).click()
  await expect(episodes).toBeHidden()
  await results.locator('summary', { hasText: 'Episodes' }).click()
  await expect(episodes).toBeVisible()
  // An episode plays on its series' page, as from Recently added.
  await results.getByRole('button', { name: /S02E01/ }).click()
  await expect(page).toHaveURL(/\/i\/[^/?]+\?play=/)
  await page.goBack()
  await field.fill('zzzz-nothing')
  await expect(
    page.getByText('Nothing found for “zzzz-nothing”.'),
  ).toBeVisible()
  await field.fill('')
  await expect(recent(page)).toBeVisible()
  await expect(page).not.toHaveURL(/\?q=/)
  await field.fill('Test')
  await expect(page).toHaveURL(/\?q=Test$/)
  // The button closes it again and drops the term.
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(field).toBeHidden()
  await expect(recent(page)).toBeVisible()
  await expect(page).not.toHaveURL(/\?q=/)
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
  // A phone: the same spot, full width, with its meta and progress,
  // the rest below it.
  await a.setViewportSize({ width: 400, height: 800 })
  await expect(spot).toHaveText('streamiq e2e mp2 default')
  const box = must(await a.locator('.spot').boundingBox(), 'spot box')
  expect(box.width).toBeGreaterThan(300)
  await expect(a.locator('.spot-meta')).toHaveText(/left/)
  await expect(a.locator('.spot > progress')).toBeVisible()
  await expect(a.locator('.more b')).toHaveText(['streamiq e2e clip'])
  await expect(a.locator('.more progress')).toBeVisible()
})

test('search: a failed request shows the error, the field keeps focus when the term clears @library', async ({
  paired,
}) => {
  const { page } = paired
  await page.addInitScript(() => {
    const make = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (l, o) {
      if (l.startsWith('req:/Items?searchTerm=nope'))
        throw new Error('e2e: no search')
      return make.call(this, l, o)
    }
  })
  await page.reload() // the init script runs on a load
  await open(page)
  const field = page.getByRole('searchbox', { name: 'Search' })
  await page.getByRole('button', { name: 'Search' }).click()
  await field.fill('nope')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(recent(page)).toBeHidden()
  await field.fill('')
  await expect(recent(page)).toBeVisible()
  await expect(field).toBeFocused()
})

test('continue watching: its error shows on a phone and a desktop @library', async ({
  paired,
}) => {
  const { page: a } = paired
  await a.addInitScript(() => {
    const make = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (l, o) {
      if (l.startsWith('req:/UserItems/Resume'))
        throw new Error('e2e: no resume')
      return make.call(this, l, o)
    }
  })
  await a.reload() // the init script runs on a load
  await open(a)
  const row = a.locator('section.shelf', {
    has: a.getByRole('heading', { name: 'Continue watching' }),
  })
  await expect(row).toBeVisible()
  await expect(a.locator('.spot')).toHaveCount(0)
  await a.setViewportSize({ width: 400, height: 800 })
  await expect(row).toBeVisible()
})

test('seasons: tabs, Season 1 first with its episodes, D-pad hero → tabs → episodes (subtle ring outside TV mode), Season 2 on a click @library', async ({
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
  const tab = tabs.getByRole('tab', { selected: true })
  await expect(tab).toBeFocused()
  // A keyboard focus (:focus-visible): a subtle ring, 3 px in TV mode.
  const ring = () => tab.evaluate((el) => getComputedStyle(el).outlineWidth)
  expect(await ring()).toBe('2px')
  await page.evaluate(() => document.documentElement.classList.add('tv'))
  expect(await ring()).toBe('3px')
  await page.evaluate(() => document.documentElement.classList.remove('tv'))
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
  await exitInline(a)

  await expect(first.getByText('Watched', { exact: true })).toBeVisible()
  await expect(first.getByRole('progressbar')).toHaveCount(0)
  await expect(second.getByText(/ left$/)).toBeVisible()
  await expect(
    second.getByRole('progressbar', { name: / watched$/ }),
  ).toBeVisible()
})

test('inline playback: in the hero box, Back leaves the page, exit stops and stays (#925); an episode from Continue watching plays on its series page, also on a phone @library', async ({
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
  // Focus on the page: Space, ↓ and Escape stay the page's (not
  // prevented, playback goes on, focus stays); K is still the player's.
  await a.evaluate(() => {
    ;(document.activeElement as HTMLElement).blur()
    const w = window as unknown as { prevented: boolean[] }
    w.prevented = []
    window.addEventListener('keydown', (e) =>
      w.prevented.push(e.defaultPrevented),
    )
  })
  for (const key of ['Space', 'ArrowDown', 'Escape', 'k'])
    await a.keyboard.press(key)
  expect(
    await a.evaluate(
      () => (window as unknown as { prevented: boolean[] }).prevented,
    ),
  ).toEqual([false, false, false, true])
  expect(await a.evaluate(() => document.activeElement === document.body)).toBe(
    true,
  )
  await expect(hero).toBeHidden()
  await expect
    .poll(() => inline.evaluate((v: HTMLVideoElement) => v.paused))
    .toBe(true)
  // Fullscreen (F from the page, focus still on the body): Space is the
  // player's again.
  await a.keyboard.press('f')
  await expect
    .poll(() => a.evaluate(() => !!document.fullscreenElement))
    .toBe(true)
  await a.keyboard.press('Space')
  await expect
    .poll(() => inline.evaluate((v: HTMLVideoElement) => v.paused))
    .toBe(false)
  await a.evaluate(() => document.exitFullscreen())
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(3)
  await expect(
    a.getByRole('heading', { level: 1, name: 'StreamIQ Test Series' }),
  ).toBeVisible()
  // Play added no history step: one Back leaves the page.
  await a.goBack()
  await expect(a).toHaveURL(appUrl(`/g/${id}`))
  // Play again, then the player's exit: stops, stays on the page.
  await a.goForward()
  await expect(a).toHaveURL(/\/i\/[^/]+\?play=/)
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(0)
  await exitInline(a)
  await expect(hero).toBeVisible()
  await expect(inline).toHaveCount(0)
  await expect(a).toHaveURL(/\/i\/[^/?]+$/)
  await a.goBack() // still one step: leaves it
  await expect(a).toHaveURL(appUrl(`/g/${id}`))

  // A phone: Continue watching's Resume → the series page playing that
  // episode on its season's tab; a reload keeps it playing; Back → home.
  await a.setViewportSize({ width: 400, height: 800 })
  await a.reload()
  await expect(a.locator('.spot h2')).toHaveText('StreamIQ Test Series')
  await a.locator('.spot').getByRole('button', { name: 'Resume' }).click()
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

test('next up: the next unstarted episode, right after Continue watching; an in-progress one stays out; a tile plays it (#998) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  const row = a.locator('section.shelf', {
    has: a.getByRole('heading', { name: 'Next up' }),
  })
  await keepPcs(a) // viaTunnel
  await a.reload()
  await open(a)
  await expect(row).toHaveCount(0) // nothing watched yet
  const { Items } = JSON.parse(
    (
      await viaTunnel(
        a,
        '/Items?recursive=true&includeItemTypes=Episode&sortBy=ParentIndexNumber,IndexNumber',
      )
    ).body,
  ) as { Items: { Id: string }[] }
  const e2 = Items[1]
  const save = async (id: string, data: object) =>
    expect((await viaTunnel(a, `/UserItems/${id}/UserData`, data)).status).toBe(
      200,
    )
  // E1 played to its end in the player (the end's save is what NextUp reads).
  await recent(a).getByRole('button', { name: 'StreamIQ Test Series' }).click()
  await a
    .getByRole('tabpanel')
    .getByRole('listitem')
    .first()
    .getByRole('button')
    .first()
    .click()
  await expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(0)
  await a
    .locator('video')
    .evaluate((v: HTMLVideoElement) => (v.currentTime = v.duration - 0.5))
  await expect(a.locator('button.hero')).toBeVisible()
  await open(a)
  await expect(row.getByRole('button')).toHaveText([/StreamIQ Test Series/])
  // E2 part-played: Continue watching's, not Next up's.
  await save(e2.Id, { PlaybackPositionTicks: 20_000_000 })
  await a.reload()
  await expect(a.locator('.spot h2')).toHaveText('StreamIQ Test Series')
  await expect(row).toHaveCount(0)
  // E2 not started: Next up, the first row after Continue watching.
  await save(e2.Id, { PlaybackPositionTicks: 0 })
  await a.reload()
  await expect(row.getByRole('button')).toHaveText([/StreamIQ Test Series/])
  await expect(a.locator('section.shelf h2').first()).toHaveText('Next up')
  await row.getByRole('button').click()
  await expect(a).toHaveURL(new RegExp(`\\?play=${e2.Id}`))
})

test('favorites: the heart on a movie and a series page, the Favorites shelf before Recently added (#1001) @library', async ({
  paired,
}) => {
  const { page } = paired
  const heart = page.getByRole('button', { name: 'Favorite' })
  const shelf = page.locator('section.shelf', {
    has: page.getByRole('heading', { name: 'Favorites' }),
  })
  const home = async () => {
    await page.goBack()
    await expect(recent(page)).toBeVisible()
  }
  await open(page)
  await expect(shelf).toHaveCount(0) // none yet: hidden
  for (const name of ['streamiq e2e clip', 'StreamIQ Test Series']) {
    await recent(page).getByRole('button', { name }).click()
    await expect(heart).toHaveAttribute('aria-pressed', 'false')
    await heart.click()
    await expect(heart).toHaveAttribute('aria-pressed', 'true')
    await home()
  }
  await expect(shelf.getByRole('button')).toHaveText([
    /streamiq e2e clip/,
    /StreamIQ Test Series/,
  ])
  await expect(page.locator('section.shelf h2').first()).toHaveText('Favorites')
  // Saved in Jellyfin: still pressed after a reload; un-favoriting takes it off the shelf.
  await shelf.getByRole('button', { name: 'streamiq e2e clip' }).click()
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
  await heart.click()
  await expect(heart).toHaveAttribute('aria-pressed', 'false')
  await home()
  await expect(shelf.getByRole('button')).toHaveText([/StreamIQ Test Series/])
})

test('favorites: TV mode reaches the heart with the D-pad; first focus stays on the hero (#1001) @library', async ({
  paired,
}) => {
  const { page } = paired
  await page.goto(appUrl('/settings'))
  await openCategory(page, 'Display')
  await page.getByLabel('TV mode').check()
  await open(page)
  await recent(page).getByRole('button', { name: 'streamiq e2e clip' }).click()
  await expect(page.locator('button.hero')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  const heart = page.getByRole('button', { name: 'Favorite' })
  await expect(heart).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
})

test('tags: chips on a movie, a series and an episode page; add with a suggestion, remove; TV mode shows them without controls (#1038) @library', async ({
  paired,
}) => {
  const { page } = paired
  const chips = page.getByRole('list', { name: 'Tags' }).getByRole('listitem')
  const field = page.getByRole('combobox', { name: 'Add a tag' })
  const add = async (t: string) => {
    await field.fill(t)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await open(page)
  await recent(page).getByRole('button', { name: 'streamiq e2e clip' }).click()
  await expect(field).toBeVisible()
  await expect(chips).toHaveCount(0)
  await add(' funny ')
  await add('Cozy')
  await expect(chips).toHaveText(['Cozy×', 'funny×']) // by name
  await page.getByRole('button', { name: 'Remove tag Cozy' }).click()
  await expect(chips).toHaveText(['funny×'])
  await page.goBack()
  await recent(page)
    .getByRole('button', { name: 'StreamIQ Test Series' })
    .click()
  // The gateway's tags are the suggestions; a differently cased one keeps their spelling.
  await expect(
    page.locator('#tag-suggestions option[value="funny"]'),
  ).toHaveCount(1)
  await add('FUNNY')
  await expect(chips).toHaveText(['funny×'])
  // An episode's own page (a deep link: a click plays it on its series' page).
  await page.locator('.episode').first().click()
  await expect(page).toHaveURL(/\?play=/)
  const ep = new URL(page.url()).searchParams.get('play')
  await page.goto(page.url().replace(/\/i\/[^?]+.*$/, `/i/${ep}`))
  await expect(field).toBeVisible()
  await add('scary')
  await expect(chips).toHaveText(['scary×'])
  await page.reload()
  await expect(chips).toHaveText(['scary×'])

  await page.goto(appUrl('/settings'))
  await openCategory(page, 'Display')
  await page.getByLabel('TV mode').check()
  await open(page)
  await recent(page).getByRole('button', { name: 'streamiq e2e clip' }).click()
  await expect(chips).toHaveText(['funny'])
  await expect(field).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remove tag/ })).toHaveCount(0)
})

test('search: in TV mode Back from a result puts the D-pad on the first result @library', async ({
  paired,
}) => {
  const { page } = paired
  await page.goto(appUrl('/settings'))
  await openCategory(page, 'Display')
  await page.getByLabel('TV mode').check()
  await open(page)
  await expect(page.getByRole('searchbox')).toBeHidden()
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox', { name: 'Search' }).fill('Test Series')
  const shows = page.getByRole('list', { name: 'Shows' })
  await shows.getByRole('button', { name: /^StreamIQ Test Series/ }).click()
  await expect(page.getByRole('tablist', { name: 'Seasons' })).toBeVisible()
  await page.goBack()
  const first = shows.getByRole('button').first()
  await expect(first).toBeFocused()
  await page.keyboard.press('ArrowUp') // the section's heading, then the field
  await expect(page.locator('summary', { hasText: 'Shows' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('searchbox', { name: 'Search' })).toBeFocused()
})

test('watch history: 10 s really played is one entry per playback, under 10 s none, a replay within 3 h none (#1023), the resume save keeps its 60 s; TV mode starts on the newest (#1012); the item page counts them (#1013) @library', async ({
  paired,
}) => {
  const { page: a } = paired
  await a.evaluate(() => {
    localStorage.setItem('streamiq.watchMin', '60') // the default: no resume save under 60 s
    const w = window as unknown as { saves: string[] }
    w.saves = []
    const make = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (l, o) {
      if (l.endsWith('/UserData')) w.saves.push(l)
      return make.call(this, l, o)
    }
  })
  await open(a)
  const history = () => a.getByRole('button', { name: 'Watch history' }).click()
  await history()
  await expect(a.getByText('Nothing watched here yet.')).toBeVisible()
  await a.goBack()
  await recent(a).getByRole('button', { name: 'streamiq e2e clip' }).click()
  await play(a, 4)
  await expect(a.getByRole('button', { name: /^(Play|Resume)$/ })).toBeVisible()
  await expect(a.getByText(/^Watched (once|\d+ times)$/)).toHaveCount(0)
  await play(a, 12)
  await expect(a.getByText('Watched once')).toBeVisible()
  // Left and played again within 3 h: the same watch.
  await play(a, 12)
  expect(
    await a.evaluate(() => (window as unknown as { saves: string[] }).saves),
  ).toEqual([])
  await a.reload()
  await expect(a.getByText('Watched once')).toBeVisible()
  await a.goBack()
  await history()
  const entries = a.getByRole('list', { name: 'Watch history' })
  await expect(entries.getByRole('button')).toHaveCount(1)
  await expect(entries.getByRole('button').first()).toContainText(
    'streamiq e2e clip',
  )
  await entries.getByRole('button').first().click()
  await expect(a.getByRole('button', { name: /^(Play|Resume)$/ })).toBeVisible()

  await a.goto(appUrl('/settings'))
  await openCategory(a, 'Display')
  await a.getByLabel('TV mode').check()
  await open(a)
  await history()
  await expect(entries.getByRole('button').first()).toBeFocused()
})
