// The player (#410), on a paired browser with its own gateway (fixtures.ts
// `paired`): the privacy badge, the profile line, the deep link + Back key,
// the bar's controls, volume, quality, compatible mode, Auto on a slow link, data
// saver, audio, auto audio, subtitles and next episode. Per-device settings
// are arranged in localStorage before the app loads (the Settings toggles are
// shell.spec's). Movies → clip → Play and the Resume spot are the golden path's;
// Play on TV is the screen spec's, rung choice and decisions profile.test.ts's.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  openDock,
  openLibrary,
  pitch,
  videoTime,
  type User,
} from './helpers.ts'

const CLIP = 'streamiq e2e clip' // 30 s, 360p H.264, English 440 Hz + German 880 Hz, .en.srt
/** The diagnostics panel's flag (diag.ts): the dock with the player's log. */
const DIAG = { 'streamiq.debug': '1' }

/** Sets localStorage before every load of p (settings.ts / diag.ts keys), then
 * reloads it: the next playback reads them. */
async function arrange(p: Page, items: Record<string, string>) {
  await p.addInitScript((s) => {
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v)
  }, items)
  await p.reload()
}

/** From /gateways: library → Movies → name → Play, until it plays past secs. */
async function play(p: Page, name = CLIP, secs = 1) {
  await openLibrary(p)
  await p.getByRole('button', { name: /Movies/ }).click()
  await p.getByRole('button', { name }).click()
  await p.getByRole('button', { name: /^(Play|Resume)$/ }).click()
  await expect
    .poll(() => videoTime(p), { timeout: 30_000 })
    .toBeGreaterThan(secs)
}

/** Pins the gateway → client link at mbps before p's next load: the bursts
 * fail, so Auto uses the stored hint (speed.ts's key) instead of a measurement
 * that load can slow down (#486). */
async function pinLink(p: Page, user: User, mbps: number) {
  const [g] = await user.api<{ id: string }[]>('/gateways')
  await p.addInitScript(
    ([id, v]) => {
      const create = RTCPeerConnection.prototype.createDataChannel
      RTCPeerConnection.prototype.createDataChannel = function (label, o) {
        if (label.startsWith('req:/streamiq/burst')) throw new Error('pinned')
        return create.call(this, label, o)
      }
      const type = (navigator as { connection?: { type?: string } }).connection
        ?.type
      localStorage.setItem(`streamiq.speed:${id}:direct:${type ?? '?'}`, v)
    },
    [g.id, String(mbps)],
  )
}

const menu = (p: Page) =>
  p.getByRole('button', { name: 'Playback options' }).click()

/** The browser's name for a language code (labels use its locale). */
const language = (p: Page, code: string) =>
  p.evaluate(
    (c) => new Intl.DisplayNames(undefined, { type: 'language' }).of(c)!,
    code,
  )

test('privacy badge (#205, #428): On your network, never leaves the house @player', async ({
  paired,
}) => {
  const { page } = paired
  await play(page)
  await page.getByRole('button', { name: 'On your network' }).click()
  await expect(
    page.getByText(/end-to-end encrypted · never leaves the house/),
  ).toBeVisible() // same host: the gateway sees the browser on its own subnet (#428)
})

test("profile line (#115): the probe and Jellyfin's decision in the dock @player", async ({
  paired,
}) => {
  const { page } = paired
  await arrange(page, DIAG)
  await play(page)
  await openDock(page)
  await expect(page.getByText(/probe: h264 .* L\d/)).toBeVisible()
  await expect(
    page.getByText(/jellyfin: video remux \(h264\) · audio copy/),
  ).toBeVisible()
})

test('deep link: /play/<id> reloads at the saved position; Back key in a new tab @player', async ({
  paired,
}) => {
  const { page } = paired
  await play(page, CLIP, 3)
  await expect(page).toHaveURL(/\/play\/[^/]+$/) // the player has its own route
  // Pause and a seek to a later second save the position (each a
  // `req:/UserItems/<id>/UserData` channel; the seek's second is always new, so
  // at least one saves): wait for one, or the reload could cut it off. Either
  // one saved 3 s or later. Answered = the response's EOF message arrived; not
  // the channel's `close`, which sometimes never fired (#566; cause unproven).
  await page.evaluate(() => {
    const w = window as unknown as { saved: number }
    w.saved = 0
    const make = RTCPeerConnection.prototype.createDataChannel
    RTCPeerConnection.prototype.createDataChannel = function (l, o) {
      const dc = make.call(this, l, o)
      if (l.endsWith('/UserData'))
        dc.addEventListener('message', (e) => {
          if (typeof e.data === 'string' && JSON.parse(e.data).eof) w.saved++
        })
      return dc
    }
  })
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.pause()
    v.currentTime = Math.floor(v.currentTime) + 2
  })
  await page.waitForFunction(
    () => (window as unknown as { saved: number }).saved > 0,
    undefined,
    { timeout: 15_000 },
  )
  // Deep link: tunnel → item by ID → its first frame at the saved position.
  await page.reload()
  await expect
    .poll(() => videoTime(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(0)
  expect(await videoTime(page)).toBeGreaterThan(2.5)

  // Opened in a new tab (no in-app history): Back goes to the item's folder.
  const tab = await page.context().newPage()
  await tab.goto(page.url())
  await expect(tab.getByRole('heading', { name: CLIP })).toBeVisible() // item loaded: Back knows its folder
  // The Back key (Escape / TV remote) hides a shown bar first, then exits.
  await expect(async () => {
    await tab.keyboard.press('Escape')
    await expect(tab).toHaveURL(/\/i\/[^/]+$/, { timeout: 1000 })
  }).toPass()
  await expect(tab.getByRole('button', { name: CLIP })).toBeVisible()
})

test('controls: ±10 s and Play / Pause, by button and by key @player', async ({
  paired,
}) => {
  const { page } = paired
  await play(page)
  const video = page.locator('video')
  const paused = () => video.evaluate((v: HTMLVideoElement) => v.paused)
  const at = () => video.evaluate((v: HTMLVideoElement) => v.currentTime)
  // Paused while seeking: the playhead moves by the skip alone.
  // Keys first: focus outside the bar (←/→ seek, Space play-pause).
  await page.keyboard.press('Space')
  await expect.poll(paused).toBe(true)
  let t = await at()
  await page.keyboard.press('ArrowRight')
  await expect.poll(at).toBeCloseTo(t + 10, 0)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(at).toBeCloseTo(t, 0)
  await page.keyboard.press('Space')
  await expect.poll(paused).toBe(false)
  // #549: Ctrl+K is the browser's (no toggle), so the plain K after it pauses;
  // a held K (keydown repeats) toggles once, so it plays again.
  await page.keyboard.press('Control+k')
  await page.keyboard.press('k')
  await expect.poll(paused).toBe(true)
  for (let i = 0; i < 3; i++) await page.keyboard.down('k') // 2nd on: repeat
  await page.keyboard.up('k')
  await expect.poll(paused).toBe(false)
  // The bar's buttons.
  const button = (name: string) =>
    page.getByRole('button', { name, exact: true })
  await button('Pause').click()
  await expect.poll(paused).toBe(true)
  t = await at()
  await button('Forward 10 seconds').click()
  await expect.poll(at).toBeCloseTo(t + 10, 0)
  await button('Rewind 10 seconds').click()
  await expect.poll(at).toBeCloseTo(t, 0)
  await button('Play').click()
  await expect.poll(paused).toBe(false)
})

test('volume (#479): 50 % at first; slider, ↓ key and mute kept across a reload @player', async ({
  paired,
}) => {
  const { page } = paired
  await play(page)
  const video = page.locator('video')
  const vol = () =>
    video.evaluate((v: HTMLVideoElement) => [v.volume, v.muted] as const)
  await expect.poll(vol).toEqual([0.5, false])
  await page.getByRole('slider', { name: 'Volume' }).fill('0.3')
  await page.getByRole('slider', { name: 'Volume' }).press('ArrowDown') // −10 %
  await expect.poll(async () => (await vol())[0]).toBeCloseTo(0.2, 2)
  await page.reload() // the deep link plays it again
  await expect.poll(async () => (await vol())[0]).toBeCloseTo(0.2, 2)
  await page.keyboard.press('m')
  await expect.poll(async () => (await vol())[1]).toBe(true)
  await page.reload()
  await expect.poll(async () => (await vol())[1]).toBe(true)
  expect((await vol())[0]).toBeCloseTo(0.2, 2) // mute keeps the level
  // 100 % is the element's own default (no volumechange on restore): the
  // slider still shows it.
  const slider = page.getByRole('slider', { name: 'Volume' })
  await slider.fill('1') // unmutes too
  await expect.poll(vol).toEqual([1, false])
  await page.reload()
  await expect.poll(vol).toEqual([1, false])
  await expect(slider).toHaveValue('1')
  // Dragged to 0 = muted; it comes back muted at 50 %, so unmuting is audible.
  await slider.fill('0')
  await expect.poll(vol).toEqual([0, true])
  await page.reload()
  await expect.poll(vol).toEqual([0.5, true])
})

test('quality (#108, #161): Auto and Source only; Source reloads at the playhead, remembered @player', async ({
  paired,
}) => {
  const { page, user } = paired
  await pinLink(page, user, 100) // Auto's pick must not depend on load (#486)
  await arrange(page, DIAG)
  await play(page, CLIP, 3) // the switch below logs @3 or later
  await openDock(page)
  // Rungs that would not scale the 360p clip down are hidden (480p too).
  // Auto (#162): the pinned 100 Mbps link fits the clip.
  await menu(page)
  await page
    .getByRole('menuitem', {
      name: /^Quality.*Auto \(your connection ~100 Mbps\) · Original 360p/,
    })
    .click()
  await expect(page.getByRole('menuitemradio')).toHaveText([
    /Auto/, // ✓ Auto
    /^Source360p, [\d.,]+ Mbps$/, // the clip's size + bitrate
  ])
  await page.getByRole('menuitemradio', { name: /^Source/ }).click()
  await expect(
    page.getByText(
      /jellyfin: video remux \(h264\)[\s\S]*quality: Source \(no limit\)[\s\S]*quality: switch to Source @([3-9]|[1-9]\d)\./, // reloaded at the playhead
    ),
  ).toBeVisible()
  await expect.poll(() => videoTime(page)).toBeGreaterThan(2.5) // and plays on there
  await page.reload()
  await menu(page)
  await expect(
    page.getByRole('menuitem', { name: /^Quality.*Source · Original 360p/ }),
  ).toBeVisible() // remembered
})

test('compatible mode (#113): an H.264 + AAC file still remuxes @player', async ({
  paired,
}) => {
  const { page } = paired
  await arrange(page, { ...DIAG, 'streamiq.settings.compatible': '1' })
  await play(page)
  await openDock(page)
  await expect(
    page.getByText(
      // newest first: this playback's decision, after its mode line
      /jellyfin: video remux \(h264\) · audio copy[\s\S]*compatible mode: on/,
    ),
  ).toBeVisible()
})

test('Auto on a slow link (#162): capped at 480p, Source warns @player', async ({
  paired,
}) => {
  const { page, user } = paired
  // A slow home upload, simulated: 0.1 Mbps (the clip is ~0.2).
  await pinLink(page, user, 0.1)
  await arrange(page, DIAG)
  await play(page)
  await openDock(page)
  await expect(
    page.getByText(
      // newest first: Jellyfin's decision, the limit, Auto's pick
      /jellyfin: video transcode[\s\S]*quality: Auto \(≤480p, 0\.07 Mbps\)[\s\S]*auto: link ~0\.1 Mbps \(stored hint\) → cap 0\.1 Mbps, source [\d.]+ Mbps → 480p/,
    ),
  ).toBeVisible()
  await menu(page)
  await page
    .getByRole('menuitem', {
      name: /^Quality.*Auto · 480p \(your connection ~0\.1 Mbps\) · Transcoded to 360p/,
    })
    .click()
  await expect(
    page.getByRole('menuitemradio', { name: /^Source/ }),
  ).toContainText('faster than your connection, may stutter')
})

test('data saver (#291): a small measurement, Auto at 480p @player', async ({
  paired,
}) => {
  const { page } = paired
  await arrange(page, { ...DIAG, 'streamiq.settings.dataSaver': 'on' })
  await play(page)
  await openDock(page)
  await expect(
    page.getByText(
      /speed: ~[\d.]+ Mbps \(median of [\d. /]+, data saver: 3 × 1 MiB, not kept/,
    ),
  ).toBeVisible()
  await expect(
    page.getByText(
      /quality: Auto \(≤480p[\s\S]*auto: link .*data saver on → 480p/,
    ),
  ).toBeVisible()
  await menu(page)
  await expect(
    page.getByRole('menuitem', { name: /^Quality.*Auto · 480p \(data saver/ }),
  ).toBeVisible()
})

test('audio (#109): English first; German reloads at the playhead @player', async ({
  paired,
}) => {
  const { page } = paired
  await arrange(page, DIAG)
  await play(page)
  await openDock(page)
  const [en, de] = [await language(page, 'eng'), await language(page, 'deu')]
  // Jellyfin's default track (English, 440 Hz) first.
  await page.evaluate(() => (document.querySelector('video')!.currentTime = 1)) // room left in the 30 s clip
  await expect.poll(() => pitch(page), { timeout: 30_000 }).toBeCloseTo(440, -2)
  // A switch reloads at the playhead with AudioStreamIndex; the remux
  // carries the German track (880 Hz).
  await menu(page)
  await page
    .getByRole('menuitem', { name: new RegExp(`^Audio.*${en}`) })
    .click()
  await page
    .getByRole('menuitemradio', { name: new RegExp(`^${de}.*AAC mono`) })
    .click()
  // The reload shows the last frame meanwhile, not a black, resized box.
  expect(
    await page.locator('video').evaluate((v: HTMLVideoElement) => v.poster),
  ).toMatch(/^data:image\/jpeg/)
  await expect.poll(() => pitch(page), { timeout: 30_000 }).toBeCloseTo(880, -2)
  await expect(
    page.getByText(
      /jellyfin: video remux \(h264\) · audio copy \(aac 1ch, stream (\d+)\)[\s\S]*audio: switch to stream \1 @\d/,
    ),
  ).toBeVisible()
})

test('auto audio (#252): a decodable track instead of an MP2 default @player', async ({
  paired,
}) => {
  const { page } = paired
  await arrange(page, DIAG)
  await play(page, 'streamiq e2e mp2 default', 0)
  await openDock(page)
  await expect.poll(() => pitch(page), { timeout: 30_000 }).toBeCloseTo(880, -2)
  // Newest first: this load's decision, then the pick before it. Video may
  // transcode (the mkv has no bitrate); the audio is copied.
  await expect(
    page.getByText(
      /jellyfin: video \w+ \(h264\) · audio copy \(aac 1ch, stream (\d+)\)[\s\S]*audio: default not decodable, stream \1 instead/,
    ),
  ).toBeVisible()
  // The audio menu shows it as the one playing.
  await menu(page)
  await page.getByRole('menuitem', { name: /^Audio/ }).click()
  await expect(
    page.getByRole('menuitemradio', { name: /AAC mono/, checked: true }),
  ).toBeVisible()
})

test('subtitles (#136, #269): off at first; the SRT cue at its own time; Off clears it @player', async ({
  paired,
}) => {
  const { page } = paired
  await play(page, CLIP, 3)
  const [en, de] = [await language(page, 'eng'), await language(page, 'deu')]
  // Mid-clip first (#269: cues landed seconds off after a start past 0): an
  // audio switch restarts the stream at the playhead.
  await menu(page)
  await page
    .getByRole('menuitem', { name: new RegExp(`^Audio.*${en}`) })
    .click()
  await page
    .getByRole('menuitemradio', { name: new RegExp(`^${de}.*AAC mono`) })
    .click()
  await expect.poll(() => pitch(page), { timeout: 30_000 }).toBeCloseTo(880, -2)
  const cue = () =>
    page.evaluate(() =>
      [...document.querySelector('video')!.textTracks]
        .filter((t) => t.mode === 'showing')
        .flatMap((t) => [...(t.activeCues ?? [])])
        .map((c) => (c as VTTCue).text)
        .join(),
    )
  expect(await cue()).toBe('')
  await menu(page)
  await page.getByRole('menuitem', { name: /^Subtitles.*Off/ }).click()
  await page
    .getByRole('menuitemradio', { name: new RegExp(`^${en}.*SRT`) })
    .click()
  await expect.poll(cue, { timeout: 15_000 }).toBe('streamiq e2e subtitle')
  // At its own time (0–30 s), not shifted by the mid-clip start (#269).
  expect(
    await page.evaluate(() =>
      [...document.querySelector('video')!.textTracks]
        .filter((t) => t.mode === 'showing')
        .flatMap((t) => [...(t.cues ?? [])])
        .map((c) => [c.startTime, c.endTime]),
    ),
  ).toEqual([[0, 30]])
  await menu(page)
  await page
    .getByRole('menuitem', { name: new RegExp(`^Subtitles.*${en}`) })
    .click()
  await page.getByRole('menuitemradio', { name: /^Off/ }).click()
  await expect.poll(cue).toBe('')
})

test('next episode (#205, #344, #378): the following one, across seasons; none after the last @player', async ({
  paired,
}) => {
  const { page: a } = paired
  await openLibrary(a)
  await a.getByRole('button', { name: /Shows/ }).click()
  await a.getByRole('button', { name: /StreamIQ Test Series/ }).click()
  const now = (ep: string) => a.locator('.now p', { hasText: ep })
  const playing = (secs = 0) =>
    expect.poll(() => videoTime(a), { timeout: 30_000 }).toBeGreaterThan(secs)
  // The focused primary button names the episode to play; OK plays it.
  const primary = a.locator('button.primary')
  await expect(primary).toBeFocused()
  expect(await primary.textContent()).toContain('S1 · E1')
  await a.keyboard.press('Enter')
  await expect(now('S1 · E1')).toBeVisible()
  await playing()
  await a.evaluate(() => {
    const v = document.querySelector('video')!
    v.currentTime = v.duration - 0.5
  })
  await a.waitForFunction(() => document.querySelector('video')!.ended)
  // Finished episode → back (#378): the first primary button shown already
  // names the next one (no stale "S1 · E1").
  await a.goBack()
  await expect(primary).toBeFocused()
  expect(await primary.textContent()).toContain('S1 · E2')
  await a.keyboard.press('Enter')
  await expect(now('S1 · E2')).toBeVisible()
  // Season 1's last episode leads to season 2's first.
  await a.getByRole('button', { name: 'Next episode' }).click()
  await expect(now('S2 · E1')).toBeVisible()
  await playing(1)
  await a.getByRole('button', { name: 'Next episode' }).click()
  await expect(now('S2 · E2')).toBeVisible()
  await playing(1)
  // The series' last episode: no button.
  await expect(a.getByRole('button', { name: 'Next episode' })).toHaveCount(0)
})
