// THE golden path (dev-env spec: exactly one E2E; edge cases belong in the
// integration layer). Real browser → broker → gateway → Jellyfin: onboard, pair,
// install check, browse, play, resume, re-pair, re-pair after an evicted key,
// remove (kills open sessions).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  expect,
  test,
  type Browser,
  type Page,
  type Request,
} from '@playwright/test'
import { gatewayTab, pair, password, tunnelOk, videoTime } from './helpers.ts'
import { startGateway } from './stack.ts'

// One account per repeat: the Auth emulator lives for the whole run.
const email = () => `e2e-${test.info().repeatEachIndex}@streamiq.test`

async function signIn(browser: Browser, create = false, path = '/') {
  const page = await (await browser.newContext()).newPage() // own IndexedDB = own client key
  await page.goto(process.env.E2E_APP_URL! + path)
  await page.getByPlaceholder('email').fill(email())
  await page.getByPlaceholder('password').fill(password)
  await page
    .getByRole('button', { name: create ? 'Create account' : 'Sign in' })
    .click()
  if (path === '/')
    await expect(page.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  return page
}

// Dominant frequency (Hz) of the <video>'s audio: tells the fixture's 440 Hz
// English track from its 880 Hz German one (#109).
const pitch = (p: Page) =>
  p.locator('video').evaluate((v: HTMLVideoElement & { an?: AnalyserNode }) => {
    if (!v.an) {
      const ctx = new AudioContext()
      v.an = ctx.createAnalyser()
      ctx.createMediaElementSource(v).connect(v.an).connect(ctx.destination)
    }
    const bins = new Float32Array(v.an.frequencyBinCount)
    v.an.getFloatFrequencyData(bins)
    return (
      (bins.indexOf(Math.max(...bins)) * v.an.context.sampleRate) / v.an.fftSize
    )
  })

/**
 * A raw tunnel request from page p's open session (docs/protocol.md framing).
 * Needs keepPcs(p).
 */
const viaTunnel = (p: Page, url: string, body?: object) =>
  p.evaluate(
    ([url, body]) =>
      new Promise<string>((resolve, reject) => {
        const pcs = (window as { pcs?: RTCPeerConnection[] }).pcs!
        const pc = pcs.findLast((x) => x.connectionState === 'connected')!
        const dc = pc.createDataChannel(`req:${url}`)
        dc.binaryType = 'arraybuffer'
        let out = ''
        dc.onopen = () =>
          dc.send(
            JSON.stringify({
              method: body ? 'POST' : 'GET',
              url,
              headers: {},
              ...(body && { body: JSON.stringify(body) }),
            }),
          )
        dc.onmessage = (e) => {
          if (typeof e.data !== 'string')
            out += new TextDecoder().decode(e.data)
          else if (JSON.parse(e.data).eof) {
            dc.onclose = null
            dc.close()
            resolve(out)
          }
        }
        dc.onclose = () => reject(new Error(`closed: ${url}`))
      }),
    [url, body] as const,
  )
const keepPcs = (p: Page) =>
  p.addInitScript(() => {
    const P = RTCPeerConnection
    const w = window as { pcs?: RTCPeerConnection[] }
    w.pcs = []
    window.RTCPeerConnection = class extends P {
      constructor(c?: RTCConfiguration) {
        super(c)
        w.pcs!.push(this)
      }
    } as typeof P
  })

test('onboard gateway, pair, pin, re-pair after cert swap, remove, revoke', async ({
  browser,
}) => {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'streamiq-e2e-gateway-'),
  )
  const a = await signIn(browser, true)

  await test.step('installable as a PWA (manifest + icons)', async () => {
    const cdp = await a.context().newCDPSession(a)
    const { installabilityErrors } = await cdp.send(
      'Page.getInstallabilityErrors',
    )
    // Playwright contexts are always incognito: that error is the harness, not the app.
    expect(
      installabilityErrors.filter((e) => e.errorId !== 'in-incognito'),
    ).toEqual([])
    expect((await cdp.send('Page.getAppManifest')).errors).toEqual([])
  })

  // Onboarding: Add gateway → run the shown install command.
  await a.getByRole('button', { name: 'Add gateway' }).click()
  const cmd = (await a.locator('pre').first().textContent())!
  const env = Object.fromEntries(
    [...cmd.matchAll(/(STREAMIQ_\w+)=(\S+)/g)].map((m) => [m[1], m[2]]),
  )
  // The gateway refuses to start without an API URL; it must point at this stack.
  expect(env.STREAMIQ_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:/)
  let gateway = await startGateway(stateDir, env)
  try {
    await expect(
      a.getByRole('listitem').filter({ hasText: '●' }),
    ).toContainText('online')
    const gatewayCtx = await browser.newContext()
    if (gateway.pageCookie) await gatewayCtx.addCookies([gateway.pageCookie]) // docker mode only

    await test.step('browser A pairs; codes match on both sides', () =>
      pair(a, gatewayCtx, gateway.pageUrl))

    await test.step('library → back → library within 30 s: one shared session (#152)', async () => {
      let rows = 0 // connection telemetry: one POST per session attempt
      const count = (r: Request) =>
        r.method() === 'POST' && r.url().endsWith('/connections') && rows++
      a.on('request', count)
      await a.getByRole('button', { name: 'Open' }).click()
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByRole('button', { name: 'Open' }).click()
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      a.off('request', count)
      expect(rows).toBe(1)
    })

    await test.step('browse → play through the tunnel → resume', async () => {
      await a.getByRole('button', { name: /Movies/ }).click()
      await expect(a).toHaveURL(/\/g\/[^/]+\/i\/[^/]+$/) // folder deep link
      await a.reload() // restores the folder: item loaded by ID over a new tunnel
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(3)
      await expect(
        a.getByText(/end-to-end encrypted · direct · StreamIQ carried 0 bytes/),
      ).toBeVisible() // same host: host candidates, no relay
      // Device profile (#115): probe + Jellyfin's decision in the diagnostics.
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await expect(a.getByText(/probe: h264 .* L\d/)).toBeVisible()
      await expect(a.getByText(/hls subtitles: (?!none)/)).toBeVisible() // sidecar .srt → HLS rendition
      await expect(
        a.getByText(/jellyfin: video remux \(h264\) · audio copy/),
      ).toBeVisible()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      await a.goBack() // leaving the player saves the position
      await a.goBack() // browser history: folder → library home
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      await a.reload()
      const resume = a.getByRole('button', {
        name: /streamiq e2e clip.*Resume 0:0[3-9]/,
      })
      await resume.click() // "Continue watching" row
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5) // starts there, not at 0
      await expect(a).toHaveURL(/\/play\/[^/]+$/) // the player has its own route
      await a.reload() // player deep link: tunnel → item by ID → saved position
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5)
      // Compatible mode (#113): Settings view → next playback uses the
      // restricted profile; an H.264 + AAC file still remuxes.
      await a.getByRole('button', { name: 'Settings' }).click()
      await a.getByLabel('Compatible mode').check()
      await a.getByRole('button', { name: 'Back' }).click() // player remounts
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5)
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await expect(
        a.getByText(
          // newest first: this playback's decision, after its mode line
          /jellyfin: video remux \(h264\) · audio copy[\s\S]*compatible mode: on/,
        ),
      ).toBeVisible()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      await a.getByRole('button', { name: 'Settings' }).click()
      await a.getByLabel('Compatible mode').uncheck()
      await a.getByRole('button', { name: 'Back' }).click()
      // Quality (#108, #161): the picker says what plays and hides rungs that
      // would not scale the 360p clip down (480p too); a switch reloads at the
      // playhead. Remembered. Auto (#162): localhost is fast, so the clip fits
      // under the measured link and remuxes.
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5)
      await a.getByRole('button', { name: 'Playback options' }).click()
      await a
        .getByRole('menuitem', {
          name: /^Quality.*Auto \(your connection ~[\d.,]+ Mbps\) · Original 360p/,
        })
        .click()
      await expect(a.getByRole('menuitemradio')).toHaveText([
        /Auto/, // ✓ Auto
        /^Source360p, [\d.,]+ Mbps$/, // the clip's size + bitrate
      ])
      await a.getByRole('menuitemradio', { name: /^Source/ }).click()
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await expect(
        a.getByText(
          /jellyfin: video remux \(h264\)[\s\S]*quality: Source \(no limit\)[\s\S]*quality: switch to Source @([3-9]|[1-9]\d)\./, // reloaded at the playhead
        ),
      ).toBeVisible()
      await expect.poll(() => videoTime(a)).toBeGreaterThan(2.5) // and plays on there
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      await a.reload()
      await a.getByRole('button', { name: 'Playback options' }).click()
      await a
        .getByRole('menuitem', { name: /^Quality.*Source · Original 360p/ }) // remembered
        .click()
      await a.getByRole('menuitemradio', { name: /^Auto/ }).click()
      // Audio (#109): Jellyfin's default track (English, 440 Hz) first; a
      // switch reloads at the playhead with AudioStreamIndex, and the remux
      // carries the German track (880 Hz). Labels use the browser's locale.
      const [en, de] = await a.evaluate(() =>
        ['eng', 'deu'].map((c) =>
          new Intl.DisplayNames(undefined, { type: 'language' }).of(c)!,
        ),
      )
      await a.evaluate(() => (document.querySelector('video')!.currentTime = 1)) // room left in the 30 s clip
      await expect
        .poll(() => pitch(a), { timeout: 30_000 })
        .toBeCloseTo(440, -2)
      await a.getByRole('button', { name: 'Playback options' }).click()
      await a
        .getByRole('menuitem', { name: new RegExp(`^Audio.*${en}`) })
        .click()
      await a
        .getByRole('menuitemradio', { name: new RegExp(`^${de}.*AAC mono`) })
        .click()
      // The reload shows the last frame meanwhile, not a black, resized box.
      expect(
        await a.locator('video').evaluate((v: HTMLVideoElement) => v.poster),
      ).toMatch(/^data:image\/jpeg/)
      await expect
        .poll(() => pitch(a), { timeout: 30_000 })
        .toBeCloseTo(880, -2)
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await expect(
        a.getByText(
          /jellyfin: video remux \(h264\) · audio copy \(aac 1ch, stream (\d+)\)[\s\S]*audio: switch to stream \1 @\d/,
        ),
      ).toBeVisible()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      // Subtitles (#136): off at first; the sidecar .srt's cue shows once
      // picked, and goes away with Off.
      const cue = () =>
        a.evaluate(() =>
          [...document.querySelector('video')!.textTracks]
            .filter((t) => t.mode === 'showing')
            .flatMap((t) => [...(t.activeCues ?? [])])
            .map((c) => (c as VTTCue).text)
            .join(),
        )
      expect(await cue()).toBe('')
      await a.getByRole('button', { name: 'Playback options' }).click()
      await a.getByRole('menuitem', { name: /^Subtitles.*Off/ }).click()
      await a
        .getByRole('menuitemradio', { name: new RegExp(`^${en}.*SRT`) })
        .click()
      await expect.poll(cue, { timeout: 15_000 }).toBe('streamiq e2e subtitle')
      await a.getByRole('button', { name: 'Playback options' }).click()
      await a
        .getByRole('menuitem', { name: new RegExp(`^Subtitles.*${en}`) })
        .click()
      await a.getByRole('menuitemradio', { name: /^Off/ }).click()
      await expect.poll(cue).toBe('')
      // Opened in a new tab (no in-app history): Back goes to the item's folder.
      const tab = await a.context().newPage()
      await tab.goto(a.url())
      await expect(
        tab.getByRole('heading', { name: /streamiq e2e clip/ }),
      ).toBeVisible() // item loaded: Back knows its folder
      // The Back key (Escape / TV remote) hides a shown bar first, then exits.
      await expect(async () => {
        await tab.keyboard.press('Escape')
        await expect(tab).toHaveURL(/\/i\/[^/]+$/, { timeout: 1000 })
      }).toPass()
      await expect(
        tab.getByRole('button', { name: /streamiq e2e clip/ }),
      ).toBeVisible()
      await tab.close()
      await a.getByRole('link', { name: '← Gateways' }).click()
    })

    await test.step('play on TV (#180) + phone remote (#181): commands, state, Back', async () => {
      // TV = tab a; phones = more tabs of the same paired browser (each its own
      // tunnel session, so its own screens view).
      await a.getByRole('button', { name: 'Open' }).click()
      await a.getByRole('link', { name: 'Use as screen' }).click()
      const waiting = a.getByRole('heading', { name: /^Screen: / })
      await expect(waiting).toBeVisible()
      const name = (await waiting.textContent())!.replace('Screen: ', '')
      await expect(a.getByText(`Play on ${name}`)).toBeVisible()
      const phone = await a.context().newPage()
      await keepPcs(phone)
      await phone.goto(a.url().replace(/\/screen$/, ''))
      await phone.getByRole('button', { name: /Movies/ }).click()
      await phone.getByRole('button', { name: 'Play on…' }).first().click()
      await phone.getByRole('button', { name, exact: true }).click()
      await expect(
        phone.getByRole('heading', { name: `Remote: ${name}` }),
      ).toBeVisible()
      await expect(a.getByText('Controlled from your phone')).toBeVisible()
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(1)
      // The TV's state reaches the phone: title, playing.
      await expect(
        phone.getByRole('heading', { name: 'streamiq e2e clip' }),
      ).toBeVisible()
      // A second phone on the same screen: Play on… → Remote.
      const phone2 = await a.context().newPage()
      await phone2.goto(phone.url().replace(/\/remote\/.*$/, ''))
      await phone2.getByRole('button', { name: /Movies/ }).click()
      await phone2.getByRole('button', { name: 'Play on…' }).first().click()
      await phone2.getByRole('link', { name: 'Remote' }).click()
      const both = async (f: (p: Page) => Promise<void>) => {
        await f(phone)
        await f(phone2)
      }
      const paused = () =>
        a.locator('video').evaluate((v: HTMLVideoElement) => v.paused)
      await both((p) =>
        expect(p.getByRole('button', { name: 'Pause' })).toBeVisible(),
      )
      await phone.getByRole('button', { name: 'Pause' }).click()
      await expect.poll(paused).toBe(true)
      await both((p) =>
        expect(p.getByRole('button', { name: 'Play' })).toBeVisible(),
      )
      // Subtitles from the second phone (last command wins): the TV reloads
      // with them and stays paused; both phones show the pick.
      await phone2.getByLabel('Subtitles').selectOption({ index: 1 })
      const cue = () =>
        a.evaluate(() =>
          [...document.querySelector('video')!.textTracks]
            .filter((t) => t.mode === 'showing')
            .flatMap((t) => [...(t.activeCues ?? [])])
            .map((c) => (c as VTTCue).text)
            .join(),
        )
      await expect.poll(cue, { timeout: 15_000 }).toBe('streamiq e2e subtitle')
      await both((p) => expect(p.getByLabel('Subtitles')).not.toHaveValue('-1'))
      expect(await paused()).toBe(true)
      // Seek bar, then −10 s.
      await phone.getByLabel('Position').fill('20')
      await expect.poll(() => videoTime(a)).toBeGreaterThan(19.5)
      await both((p) => expect(p.getByText(/^0:2\d \/ 0:30$/)).toBeVisible())
      await phone.getByRole('button', { name: '−10 s' }).click()
      await expect.poll(() => videoTime(a)).toBeLessThan(11)
      // The TV's own remote (K = play/pause) shows on the phones within ~2 s.
      await a.keyboard.press('k')
      await expect.poll(paused).toBe(false)
      await both((p) =>
        expect(p.getByRole('button', { name: 'Pause' })).toBeVisible({
          timeout: 2_500,
        }),
      )
      await phone.getByRole('button', { name: 'Stop' }).click()
      await expect(waiting).toBeVisible()
      await both((p) => expect(p.getByText('Nothing playing.')).toBeVisible())
      // Back on the TV leaves screen mode at once: both remotes say so, and
      // Play on… no longer lists it.
      await a.keyboard.press('Escape')
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible()
      await both((p) => expect(p.getByText('Screen closed.')).toBeVisible())
      expect(JSON.parse(await viaTunnel(phone, '/streamiq/screens'))).toEqual(
        [],
      )
      await phone.getByRole('link', { name: 'Library' }).click()
      await phone.getByRole('button', { name: /Movies/ }).click()
      await phone.getByRole('button', { name: 'Play on…' }).first().click()
      await expect(phone.getByText(/No screen open/)).toBeVisible()
      await phone.close()
      await phone2.close()
      await a.getByRole('link', { name: '← Gateways' }).click()
    })

    await test.step('Auto on a slow link (#162): a capped rung, Source warns', async () => {
      // A slow home upload, simulated: the bursts fail, so Auto falls back to
      // the stored hint, set to 0.1 Mbps (the clip is ~0.2). A reload at the
      // end undoes both. Reload first: the library's tunnel is shared and kept
      // 30 s after leaving (#152), and this step needs a fresh session.
      await a.reload()
      await a.evaluate(() => {
        const create = RTCPeerConnection.prototype.createDataChannel
        RTCPeerConnection.prototype.createDataChannel = function (label, o) {
          if (label.startsWith('req:/streamiq/burst')) throw new Error('slow')
          return create.call(this, label, o)
        }
        for (const k of Object.keys(localStorage))
          if (k.startsWith('streamiq.speed:')) localStorage.setItem(k, '0.1')
      })
      await a.getByRole('button', { name: 'Open' }).click()
      await a.getByRole('button', { name: /Movies/ }).click()
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(1)
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await expect(
        a.getByText(
          // newest first: Jellyfin's decision, the limit, Auto's pick
          /jellyfin: video transcode[\s\S]*quality: Auto \(≤480p, 0\.07 Mbps\)[\s\S]*auto: link ~0\.1 Mbps \(stored hint\) → cap 0\.1 Mbps, source [\d.]+ Mbps → 480p/,
        ),
      ).toBeVisible()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      await a.getByRole('button', { name: 'Playback options' }).click()
      await a
        .getByRole('menuitem', {
          name: /^Quality.*Auto · 480p \(your connection ~0\.1 Mbps\) · Transcoded to 360p/,
        })
        .click()
      await expect(
        a.getByRole('menuitemradio', { name: /^Source/ }),
      ).toContainText('faster than your connection, may stutter')
      await a.reload() // drops the patch; the next session measures again
      await a.goto(process.env.E2E_APP_URL!)
    })

    // Buttons, not ?relay / ?debug: a TV can't edit the URL (#71).
    await test.step('diagnostics panel: force relay → tunnel works, panel logs it', async () => {
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await a.getByLabel('Force relay (TURN) on next connect').check()
      await a.getByRole('button', { name: 'Open' }).click()
      await expect(
        a.getByText(/relayed \(encrypted, StreamIQ cannot decrypt\)/),
      ).toBeVisible({ timeout: 30_000 })
      await expect(a.getByRole('button', { name: /Movies/ })).toBeVisible() // a tunnel request made it
      await expect(a.getByText('peer: connected / connected')).toBeVisible()
      await expect(
        a.getByRole('row', { name: /opened.*HTTP 200.*\/UserViews/ }).first(), // newest first; earlier sessions' rows are kept too
      ).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByLabel('Force relay (TURN) on next connect').uncheck()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
    })

    await test.step('diagnostics page (#90): direct vs relayed, burst throughput, report', async () => {
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await a
        .getByRole('link', { name: 'Client info + connection test' })
        .click()
      const report = a.locator('pre', { hasText: 'StreamIQ diagnostics' })
      await expect(report).toContainText(/codecs: h264 .* L\d/) // the #115 probe
      const run = async (path: RegExp) => {
        // Closing the test's session sends its measurement to telemetry (#162).
        const end = a.waitForRequest(
          (r) => r.method() === 'PATCH' && r.url().includes('/connections/'),
        )
        await a.getByRole('button', { name: 'Test connection' }).click()
        await expect(report).toContainText(
          /throughput: [\d.]+ Mbps \(median of 3 × 1 MiB bursts; Auto caps at [\d.]+ Mbps\)/,
          { timeout: 30_000 },
        )
        expect((await end).postDataJSON().throughputKbps).toBeGreaterThan(0)
        await expect(report).toContainText('paired: yes')
        await expect(report).toContainText(path)
      }
      await run(/path: direct .* RTT \d+ ms/)
      await a.getByLabel('Force relay (TURN)', { exact: true }).check()
      await run(/relay forced: yes[\s\S]*path: relayed \(TURN\)/)
      await a.getByLabel('Force relay (TURN)', { exact: true }).uncheck()
      await expect(report).not.toContainText(email())
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      await a.goto(process.env.E2E_APP_URL!)
    })

    await test.step('pin + key survive a reload (IndexedDB)', async () => {
      await a.reload()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await tunnelOk(a)
    })

    await test.step('web gateway page: status from the gateway API (#140)', async () => {
      // e2e's Jellyfin was set up by the test (wizard), not the gateway.
      await a.getByText('Status', { exact: true }).click()
      await expect(
        a.getByText('Transcoding: not managed by StreamIQ'),
      ).toBeVisible({ timeout: 15_000 })
      await expect(
        a.getByText(/Jellyfin: reachable, version .* · token set/),
      ).toBeVisible()
      await expect(
        a.getByText(/Paired browsers: 1 · open sessions/),
      ).toBeVisible()
    })

    await test.step('browser B (same account, never paired) is refused', async () => {
      // Signed out on a deep link: sign-in, then that same route loads.
      const id = (await a.locator('li code').first().textContent())!
      const b = await signIn(browser, false, `/g/${id}`)
      await expect(
        b.locator('[role=alert][data-kind="not-paired"]'),
      ).toContainText('this browser is not paired with the gateway')
      expect(new URL(b.url()).pathname).toBe(`/g/${id}`)
      await b.goto(process.env.E2E_APP_URL! + '/no-such-page')
      await b.getByRole('link', { name: 'Go to your gateways' }).click()
      await b.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        b.getByText('this browser is not paired with the gateway'),
      ).toBeVisible()

      // Unpaired, B sees only liveness from the heartbeat; the details need
      // the tunnel (#140).
      await b.getByText('Status', { exact: true }).click()
      await expect(b.getByText(/StreamIQ: connected/)).toBeVisible()
      await expect(
        b.getByText('Details: pair this browser to see them'),
      ).toBeVisible({ timeout: 15_000 })
      await expect(b.getByText(/Jellyfin:|Paired browsers/)).toHaveCount(0)

      // The diagnostics page says so too, and names the failed step.
      await b.goto(process.env.E2E_APP_URL! + '/diagnostics')
      await b.getByRole('button', { name: 'Test connection' }).click()
      await expect(b.locator('pre')).toContainText(
        /paired: no\s+failed at connect .*not paired/,
      )
    })

    await test.step('new gateway certificate → red warning → re-pair', async () => {
      await gateway.stop()
      fs.rmSync(path.join(stateDir, 'cert.pem'))
      // Same env; the spent token is ignored — gateway.json already holds the credential.
      gateway = await startGateway(stateDir, env)
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        a.locator('[role=alert][data-kind="pin-mismatch"]'),
      ).toContainText('Refused: this is not the gateway you paired with.')
      await pair(a, gatewayCtx, gateway.pageUrl)
    })

    await test.step("Remove on the gateway page → A's open session dies, then A is refused", async () => {
      await a.getByRole('button', { name: 'Open' }).click()
      const movies = a.getByRole('button', { name: /Movies/ })
      await expect(movies).toBeVisible() // a live tunnel session, opened before Remove
      const gatewayPage = await gatewayTab(gatewayCtx, gateway.pageUrl)
      const paired = gatewayPage.locator('form[action="/remove"]')
      await expect(paired).toHaveCount(1)
      await paired.getByRole('button', { name: 'Remove' }).click()
      await expect(paired).toHaveCount(0)
      // The gateway closed the PeerConnection: the next request on it fails.
      await movies.click()
      await expect(
        a.locator('[role=alert][data-kind="tunnel-lost"]'),
      ).toBeVisible()
      await a.getByRole('link', { name: '← Gateways' }).click()
      await a.getByRole('button', { name: 'Test connection' }).click()
      await expect(
        a.getByText('this browser is not paired with the gateway'),
      ).toBeVisible()
    })

    await test.step('evicted client key (#174): message → re-pair right there → stream', async () => {
      // What Safari's 7-day cap or disk pressure does: all IndexedDB gone
      // (client key, pins, and Firebase's sign-in with them).
      const app = process.env.E2E_APP_URL!
      const id = (await a.locator('li code').first().textContent())!
      const cdp = await a.context().newCDPSession(a)
      await cdp.send('Storage.clearDataForOrigin', {
        origin: new URL(app).origin,
        storageTypes: 'indexeddb',
      })
      await a.goto(`${app}/g/${id}`)
      await a.getByPlaceholder('email').fill(email())
      await a.getByPlaceholder('password').fill(password)
      await a.getByRole('button', { name: 'Sign in' }).click()
      const alert = a.locator('[role=alert][data-kind="not-paired"]')
      await expect(alert).toContainText(
        "This browser isn't paired with this gateway (anymore). Pair it again.",
      )
      await alert.getByRole('button', { name: 'Pair this browser' }).click()
      const code = (await alert
        .locator('p', { hasText: /^Code/ })
        .locator('b')
        .textContent())!
      const gatewayPage = await gatewayTab(gatewayCtx, gateway.pageUrl)
      const request = gatewayPage.locator('form[action="/decide"]')
      await expect(request).toContainText(code)
      await request.getByRole('button', { name: 'Approve' }).click()
      // Paired → the library reconnects on a fresh session.
      await a.getByRole('button', { name: /Movies/ }).click()
      await a.getByRole('button', { name: /streamiq e2e clip/ }).click()
      await expect
        .poll(() => videoTime(a), { timeout: 30_000 })
        .toBeGreaterThan(0)
      // The pairing asked for persistent storage; the result is in the log.
      await a.getByRole('button', { name: 'Diagnostics' }).click()
      await expect(
        a.getByText(
          /storage: (persist\(\) (granted|denied)|already persistent)/,
        ),
      ).toBeVisible()
      await a.getByRole('button', { name: 'Hide diagnostics' }).click()
      await a.goto(app)
      await expect(a.getByRole('heading', { name: 'Gateways' })).toBeVisible()
    })

    await test.step('Remove in the web app → gateway revoked and disconnected', async () => {
      let out = ''
      gateway.proc.stderr!.on('data', (d) => (out += d))
      a.once('dialog', (d) => d.accept())
      await a.getByRole('button', { name: 'Remove' }).click()
      await expect(a.getByText('No gateways yet.')).toBeVisible()
      // Its socket was closed and the reconnect is refused (401).
      await expect
        .poll(() => out, { timeout: 60_000 })
        .toContain('credential revoked or unknown')
    })
  } finally {
    await gateway.stop()
  }
})
