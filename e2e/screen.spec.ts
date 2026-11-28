// Screen mode, on a paired browser with its own gateway
// (fixtures.ts `paired`): the entry, Play on…, the phone remote's commands, two
// phones, jump scares (marks, hint, list), the Now playing bar, closing, the D-pad after Leave. TV = the fixture's page; phones = more tabs of the same
// paired browser (each its own tunnel session). Refusals, another user's screen
// and the relay between sessions are Go tests (screen/screen_test.go,
// sessions_test.go); the TV mode toggle is shell.spec's, the player's own
// controls player.spec's.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  keepPcs,
  openGateway,
  openLibrary,
  pitch,
  videoTime,
  viaTunnel,
} from './helpers.ts'
import { must } from './must.ts'

const CLIP = 'streamiq e2e clip' // 30 s, English 440 Hz + German 880 Hz, .en.srt

// The diagnostics dock, open, on the TV and the phones (diag.ts; one context,
// one localStorage): a failure's trace shows their event log, pc state and why
// a screen ended.
test.beforeEach(async ({ paired: { page } }) => {
  await page.context().addInitScript(() => {
    localStorage.setItem('streamiq.debug', '1')
    localStorage.setItem('streamiq.dock', '1')
  })
  await page.reload()
})

/** TV on its gateway's library → the screen route (TV mode's top bar link,
 * without TV mode: the phones share its localStorage); the screen's name. */
async function useAsScreen(tv: Page) {
  await openLibrary(tv)
  await tv.goto(`${tv.url()}/screen`)
  const waiting = tv.getByRole('heading', { name: /^Screen: / })
  await expect(waiting).toBeVisible()
  return must(await waiting.textContent(), 'screen heading text').replace(
    'Screen: ',
    '',
  )
}

/** A phone: a new tab on the TV's gateway library, Movies, the clip's page. */
async function phoneAt(tv: Page) {
  const phone = await tv.context().newPage()
  await keepPcs(phone) // viaTunnel
  await phone.goto(tv.url().replace(/\/screen$/, ''))
  await phone.getByRole('button', { name: /Movies/ }).click()
  await phone.getByRole('button', { name: /streamiq e2e clip/ }).click()
  return phone
}

/** Play on…'s native picker on the phone's title page. */
const playOn = (phone: Page) =>
  phone.getByRole('combobox', { name: 'Play on…' })

/** The TV as a screen, a phone playing the clip on it: the phone's Remote open. */
async function cast(tv: Page) {
  const name = await useAsScreen(tv)
  const phone = await phoneAt(tv)
  await playOn(phone).selectOption({ label: name })
  await expect(
    phone.getByRole('heading', { name: `Remote: ${name}` }),
  ).toBeVisible()
  await expect.poll(() => videoTime(tv), { timeout: 30_000 }).toBeGreaterThan(1)
  return { name, phone }
}

/** A second phone on the playing screen: Play on… → its Remote. */
async function secondPhone(tv: Page, name: string) {
  const phone = await phoneAt(tv)
  await playOn(phone).selectOption({ label: `Remote: ${name}` })
  return phone
}

const paused = (tv: Page) =>
  tv.locator('video').evaluate((v: HTMLVideoElement) => v.paused)

/** The TV's showing subtitle cues, joined. */
const cue = (tv: Page) =>
  tv.locator('video').evaluate((v: HTMLVideoElement) =>
    [...v.textTracks]
      .filter((t) => t.mode === 'showing')
      .flatMap((t) => [...(t.activeCues ?? [])])
      .map((c) => (c as VTTCue).text)
      .join(),
  )

test('entry (#248, #872, #870): the top bar in TV mode only, not on the web gateway page @player', async ({
  paired,
}) => {
  const { page } = paired
  const bar = page.getByRole('banner').getByRole('link', {
    name: 'Use as screen',
  })
  await openLibrary(page)
  await expect(page.getByRole('link', { name: 'Use as screen' })).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Gateways' })
    .click()
  await openGateway(page)
  await expect(page.getByRole('link', { name: 'Use as screen' })).toHaveCount(0)
  await page.addInitScript(() =>
    localStorage.setItem('streamiq.settings.tv', '1'),
  )
  await page.reload()
  await page.getByRole('link', { name: 'Settings' }).click()
  await bar.click() // every page, on the active gateway
  await expect(page.getByRole('heading', { name: /^Screen: / })).toBeVisible()
  await expect(bar).toHaveCount(0)
})

test('Play on… (#180): the waiting screen, a phone plays on it @player', async ({
  paired,
}) => {
  const { page: tv } = paired
  const name = await useAsScreen(tv)
  await expect(tv.getByText(`Play on ${name}`)).toBeVisible()
  const phone = await phoneAt(tv)
  await playOn(phone).selectOption({ label: name })
  await expect(
    phone.getByRole('heading', { name: `Remote: ${name}` }),
  ).toBeVisible()
  await expect(tv.getByText('Controlled from your phone')).toBeVisible()
  await expect.poll(() => videoTime(tv), { timeout: 30_000 }).toBeGreaterThan(1)
  // The TV's state reaches the phone: title, playing.
  await expect(phone.getByRole('heading', { name: CLIP })).toBeVisible()
  await expect(phone.getByRole('button', { name: 'Pause' })).toBeVisible()
})

test('remote commands (#181): play / pause, audio, subtitles, position, ±10 s, stop @player', async ({
  paired,
}) => {
  const { page: tv } = paired
  const { phone } = await cast(tv)
  const button = (name: string) =>
    phone.getByRole('button', { name, exact: true })
  // A failed command's error shows until a command works: the next
  // command channel throws once; the poll's (req:/streamiq/screens) doesn't.
  await phone.evaluate(() => {
    const p = RTCPeerConnection.prototype
    const create = p.createDataChannel
    p.createDataChannel = function (label, ...rest) {
      if (!label.startsWith('req:/streamiq/screens/'))
        return create.call(this, label, ...rest)
      p.createDataChannel = create
      throw new Error('e2e: command lost')
    }
  })
  const lost = phone.getByRole('main').getByText(/e2e: command lost/) // not the open dock's copy
  await button('Pause').click()
  await expect(lost).toBeVisible()
  expect(await paused(tv)).toBe(false)
  await button('Pause').click()
  await expect.poll(() => paused(tv)).toBe(true)
  await expect(lost).toBeHidden()
  await expect(button('Play')).toBeVisible() // the poll has the paused state
  // An outage: poll and command both fail; once the gateway is back, the
  // command's error doesn't show up under a working remote.
  await phone.evaluate(() => {
    const p = RTCPeerConnection.prototype
    const create = p.createDataChannel
    const w = window as { e2eDown?: boolean }
    w.e2eDown = true
    p.createDataChannel = function (label, ...rest) {
      if (!w.e2eDown || !label.startsWith('req:/streamiq/screens'))
        return create.call(this, label, ...rest)
      throw new Error('e2e: gateway down')
    }
  })
  const down = phone.getByRole('main').getByText(/e2e: gateway down/)
  await expect(down).toBeVisible() // the poll's
  await button('Play').click()
  await phone.evaluate(
    () => ((window as { e2eDown?: boolean }).e2eDown = false),
  )
  await expect(down).toBeHidden()
  expect(await paused(tv)).toBe(true)
  await button('Play').click()
  await expect.poll(() => paused(tv)).toBe(false)
  await expect(button('Pause')).toBeVisible()
  // Audio while playing, early in the 30 s clip: German = 880 Hz on the TV.
  const de = await phone.evaluate(
    () =>
      new Intl.DisplayNames(undefined, { type: 'language' }).of('deu') ?? 'deu',
  )
  const audio = phone.getByLabel('Audio')
  await audio.selectOption(
    must(
      await audio.locator('option', { hasText: de }).getAttribute('value'),
      `${de} audio option value`,
    ),
  )
  await expect.poll(() => pitch(tv), { timeout: 30_000 }).toBeCloseTo(880, -2)
  // From here paused: a track pick keeps a paused TV paused, and seeks move
  // the playhead by the command alone.
  await button('Pause').click()
  await expect.poll(() => paused(tv)).toBe(true)
  // Subtitles: the clip's cue (0–30 s) shows on the TV.
  await phone.getByLabel('Subtitles').selectOption({ index: 1 })
  await expect
    .poll(() => cue(tv), { timeout: 15_000 })
    .toBe('streamiq e2e subtitle')
  expect(await paused(tv)).toBe(true)
  await phone.getByLabel('Position').fill('20')
  await expect.poll(() => videoTime(tv)).toBeGreaterThan(19.5)
  await expect(phone.getByText(/^0:2\d \/ 0:30$/)).toBeVisible()
  await button('−10 s').click()
  await expect.poll(() => videoTime(tv)).toBeLessThan(11)
  await button('+10 s').click()
  await expect.poll(() => videoTime(tv)).toBeGreaterThan(19.5)
  await button('Stop').click()
  await expect(tv.getByRole('heading', { name: /^Screen: / })).toBeVisible()
  await expect(phone.getByText('Nothing playing.')).toBeVisible()
})

test("two phones (#181): either one's command reaches the TV, both show it; so does the TV's own key @player", async ({
  paired,
}) => {
  const { page: tv } = paired
  const { name, phone } = await cast(tv)
  const phone2 = await secondPhone(tv, name)
  const both = (name: string, timeout?: number) =>
    Promise.all(
      [phone, phone2].map((p) =>
        expect(p.getByRole('button', { name, exact: true })).toBeVisible({
          timeout,
        }),
      ),
    )
  await both('Pause')
  await phone.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(() => paused(tv)).toBe(true)
  await both('Play')
  await phone2.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => paused(tv)).toBe(false)
  await both('Pause')
  // The TV's own remote (K = play/pause) shows on the phones within ~2.5 s.
  await tv.keyboard.press('k')
  await expect.poll(() => paused(tv)).toBe(true)
  await both('Play', 2_500)
  // Tracks and position from the second phone: the TV's state shows on the
  // first one too (not just the sender's own optimistic view).
  await phone2.getByLabel('Subtitles').selectOption({ index: 1 })
  await expect.poll(() => cue(tv), { timeout: 15_000 }).not.toBe('')
  for (const p of [phone, phone2])
    await expect(p.getByLabel('Subtitles')).not.toHaveValue('-1')
  await phone2.getByLabel('Position').fill('20')
  await expect.poll(() => videoTime(tv)).toBeGreaterThan(19.5)
  await expect(phone.getByText(/^0:2\d \/ 0:30$/)).toBeVisible()
})

test('jump scares: a whenjumpscare .srt on the remote marks the seek bar, the TV shows nothing @player', async ({
  paired,
}) => {
  const { page: tv } = paired
  const { phone } = await cast(tv)
  await phone.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(() => paused(tv)).toBe(true) // the clip doesn't end under the test
  const srt = (text: string) => ({
    name: 'warnings.srt',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(text),
  })
  // The button opens the device's file picker (the hidden input's chooser).
  const pick = async (f: ReturnType<typeof srt>) => {
    const chooser = phone.waitForEvent('filechooser')
    await phone
      .getByRole('button', { name: 'Jump scares', exact: true })
      .click()
    await (await chooser).setFiles(f)
  }
  const marks = phone.locator('.jumpscare-marks i')
  await pick(srt('1\n00:00:01,000 --> 00:00:02,000\nhello\n'))
  await expect(
    phone.getByText('No jump scares found in this file'),
  ).toBeVisible()
  await expect(marks).toHaveCount(0)
  await pick(
    srt(
      [
        '1',
        '00:00:15,000 --> 00:00:19,000',
        '⚠️ Major jumpscare approaching at 00:00:20',
        '',
        '2',
        '00:00:20,000 --> 00:00:24,000',
        '⚠️ Minor jumpscare approaching at 00:00:25',
      ].join('\r\n'),
    ),
  )
  await expect(marks).toHaveCount(2)
  await expect(phone.locator('.jumpscare-marks i.major')).toHaveCount(1)
  const hint = phone.getByText(/^Next jump scare in 0:\d\d \(major\)$/)
  await expect(hint).toBeVisible()
  await expect(
    phone.getByText('No jump scares found in this file'),
  ).toBeHidden()
  const rows = phone.locator('.jumpscare-list li')
  await expect(rows.first()).toBeHidden() // closed at first
  await phone.getByText('All jump scares (2)').click()
  await expect(rows).toHaveText(['0:20 · major', '0:25 · minor'])
  // Past the first scare (paused at ~2 s, +10 s twice): it reads as passed.
  for (let i = 0; i < 2; i++)
    await phone.getByRole('button', { name: '+10 s', exact: true }).click()
  await expect(rows).toHaveText(['0:20 · major · passed', '0:25 · minor'], {
    timeout: 10_000,
  })
  // Kept on this device: a reloaded remote still has them.
  await phone.reload()
  await expect(
    phone.getByText(/^Next jump scare in 0:\d\d \(minor\)$/), // past the major one
  ).toBeVisible()
  await expect(marks).toHaveCount(2)
  await expect(tv.locator('.jumpscare-marks')).toHaveCount(0)
  await expect(tv.getByText(/jump scare/i)).toHaveCount(0)
})

/** A phone's Now playing bar (NowPlaying.tsx) and its entries. */
const nowPlaying = (p: Page) =>
  p.getByRole('navigation', { name: 'Now playing' })
const entries = (p: Page) => nowPlaying(p).getByRole('link')

test('Now playing (#1029): one entry per playing screen back to its remote; not on the remote, screen, player or in TV mode @player', async ({
  paired,
}) => {
  const { page: tv } = paired
  const { name, phone } = await cast(tv)
  await expect(nowPlaying(phone)).toHaveCount(0) // the remote
  await expect(nowPlaying(tv)).toHaveCount(0) // the screen
  await phone.goBack() // the clip's page
  await expect(entries(phone)).toHaveCount(1)
  await expect(entries(phone)).toContainText(`${CLIP}on ${name}`)
  await entries(phone).click()
  await expect(
    phone.getByRole('heading', { name: `Remote: ${name}` }),
  ).toBeVisible()
  // A second screen plays too, arranged over the tunnel.
  const tv2 = await tv.context().newPage()
  await tv2.goto(tv.url()) // the screen route
  await expect(tv2.getByRole('heading', { name: /^Screen: / })).toBeVisible()
  await phone.goBack() // the clip's page again
  const itemId = must(
    phone.url().match(/\/i\/([^/?]+)/),
    'item id in the URL',
  )[1]
  const screens = JSON.parse(
    (await viaTunnel(phone, '/streamiq/screens')).body,
  ) as { id: string; state: { itemId: string } | null }[]
  const idle = must(
    screens.find((s) => !s.state?.itemId),
    'the second screen',
  )
  await viaTunnel(phone, `/streamiq/screens/${idle.id}`, {
    type: 'play',
    itemId,
  })
  await expect(entries(phone)).toHaveCount(2, { timeout: 15_000 }) // the 10 s poll
  await viaTunnel(phone, `/streamiq/screens/${idle.id}`, { type: 'stop' })
  await expect(entries(phone)).toHaveCount(1, { timeout: 15_000 })
  // The full-screen player (TV mode's route; inline play elsewhere keeps the bar).
  await phone.goto(phone.url().replace(/\/i\/.*$/, `/play/${itemId}`))
  await expect(phone.locator('video')).toBeVisible()
  await expect(nowPlaying(phone)).toHaveCount(0)
  await phone.goBack()
  await expect(entries(phone)).toHaveCount(1)
  await phone.evaluate(() => localStorage.setItem('streamiq.settings.tv', '1'))
  await phone.reload()
  await expect(
    phone.getByRole('button', { name: /^(Play|Resume)$/ }),
  ).toBeVisible()
  await expect(nowPlaying(phone)).toHaveCount(0)
})

test('closing: Back on the TV ends screen mode; the phones say so, Play on… is gone @player', async ({
  paired,
}) => {
  const { page: tv } = paired
  const { name, phone } = await cast(tv)
  const phone2 = await secondPhone(tv, name)
  const browsing = await phoneAt(tv) // a third tab on the clip's page
  await expect(playOn(browsing)).toBeVisible()
  // Arranged over the tunnel: back to the waiting screen.
  const screen = must(
    phone.url().match(/\/remote\/([^/]+)$/),
    'screen id in the URL',
  )[1]
  await viaTunnel(phone, `/streamiq/screens/${screen}`, { type: 'stop' })
  await expect(tv.getByRole('heading', { name: /^Screen: / })).toBeVisible()
  await tv.keyboard.press('Escape') // back where it was opened: the library
  await expect(tv).toHaveURL(/\/g\/[^/]+$/)
  for (const p of [phone, phone2])
    await expect(p.getByText('Screen closed.')).toBeVisible()
  expect(
    JSON.parse((await viaTunnel(phone, '/streamiq/screens')).body),
  ).toEqual([])
  // The open title page's poll (10 s) drops the closed screen.
  await expect(playOn(browsing)).toHaveCount(0, { timeout: 15_000 })
  await phone.getByRole('alert').getByRole('link', { name: 'Library' }).click() // not the nav's
  await phone.getByRole('button', { name: /Movies/ }).click()
  await phone.getByRole('button', { name: /streamiq e2e clip/ }).click()
  await expect(
    phone.getByRole('button', { name: /^(Play|Resume)$/ }),
  ).toBeVisible()
})

// Leave unmounts the focused button: focus falls to <body>, outside every
// D-pad container; the next arrow recovers it (focus.ts recoverFocus). The
// screen opens in-app from Gateways (TV mode's top bar), a page without
// autofocus to come back to.
test('Leave: the D-pad still works on the page it returns to @player', async ({
  paired,
}) => {
  const { page: tv } = paired
  await tv.addInitScript(() =>
    localStorage.setItem('streamiq.settings.tv', '1'),
  )
  await tv.reload()
  await openLibrary(tv) // the active gateway: the top bar's link
  await tv.goto(appUrl('/gateways'))
  await tv
    .getByRole('banner')
    .getByRole('link', { name: 'Use as screen' })
    .click()
  await expect(tv.getByRole('button', { name: 'Leave' })).toBeFocused()
  await tv.keyboard.press('Enter')
  await expect(tv.getByRole('heading', { level: 1 })).toHaveText('Gateways')
  const onBody = () =>
    tv.evaluate(() => document.activeElement === document.body)
  expect(await onBody()).toBe(true)
  await tv.keyboard.press('ArrowDown')
  await expect.poll(onBody).toBe(false)
})
