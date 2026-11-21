// The production build on Chromium 87, the webOS TV's engine: a sign-in
// through the form to Gateways, failing on any uncaught error or console.error. It
// catches syntax `build.target` let through and runtime APIs 87 lacks. Not a second
// Playwright project: Playwright launches 87 but its actions and visibility checks
// need Chrome 105 (`checkVisibility`), so this drives the page with plain DOM calls
// and waits with waitForFunction (both run in the page itself).
// The binary: a pinned Chromium snapshot (Chrome for Testing starts at 113),
// downloaded once into e2e/.bin; docs/tools.md.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { password, signUp, uniqueEmail } from './helpers.ts'
import { root, start, waitHttp } from './stack.ts'
import { envVar, must } from './must.ts'

// Revisions on the 87 branch (87.0.4280.0); the snapshot bucket has no Windows
// build at the Linux one. Bump: the bucket listing in docs/tools.md, new sha256.
const builds: Record<string, { zip: string; exe: string; sha256: string }> = {
  linux: {
    zip: 'Linux_x64/812847/chrome-linux.zip',
    exe: 'chrome-linux/chrome',
    sha256: '36759ed6d151645d00a3a015200334edc70188b422eec51bcaa5790c8e906e27',
  },
  win32: {
    zip: 'Win_x64/812845/chrome-win.zip',
    exe: 'chrome-win/chrome.exe',
    sha256: '09e9703434b5a11bf5295272cd9fad9f469073ff878339102c4fdcb919b36283',
  },
}

/** The pinned Chromium 87's executable, downloaded and checked on first use. */
async function chromium87() {
  const b = must(
    builds[process.platform],
    `a Chromium 87 build for ${process.platform}`,
  )
  const dir = path.join(
    import.meta.dirname,
    '.bin',
    'chromium87',
    b.sha256.slice(0, 12),
  )
  const exe = path.join(dir, b.exe)
  if (fs.existsSync(exe)) return exe
  const res = await fetch(
    `https://commondatastorage.googleapis.com/chromium-browser-snapshots/${b.zip}`,
  )
  if (!res.ok) throw new Error(`download ${b.zip}: ${res.status}`)
  const zip = Buffer.from(await res.arrayBuffer())
  const sum = crypto.createHash('sha256').update(zip).digest('hex')
  if (sum !== b.sha256)
    throw new Error(`${b.zip}: sha256 ${sum}, want ${b.sha256}`)
  const tmp = `${dir}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'c.zip'), zip)
  // Windows' own tar (bsdtar) reads zips; Git Bash's GNU tar on PATH doesn't.
  const x =
    process.platform === 'win32'
      ? spawnSync(
          path.join(envVar('SystemRoot'), 'System32', 'tar.exe'),
          ['-xf', 'c.zip'],
          { cwd: tmp },
        )
      : spawnSync('unzip', ['-q', 'c.zip'], { cwd: tmp })
  if (x.status !== 0) throw new Error(`unzip ${b.zip}: ${x.stderr}`)
  fs.rmSync(path.join(tmp, 'c.zip'))
  fs.renameSync(tmp, dir) // only a complete extract gets the real name
  return exe
}

/** `vite build` of this checkout against this stack, served by `vite preview`. */
async function serveBuild() {
  const url = envVar('E2E_BUILD_URL')
  const out = path.join(import.meta.dirname, '.bin', 'app-build')
  const vite = path.join('node_modules', 'vite', 'bin', 'vite.js')
  const cwd = path.join(root, 'frontend')
  const b = spawnSync(
    process.execPath,
    [vite, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 120_000, // sync: Playwright's timeout can't fire
      env: {
        ...process.env,
        VITE_API_URL: process.env.E2E_API_URL,
        VITE_FIREBASE_AUTH_EMULATOR: process.env.E2E_EMULATOR_URL,
      },
    },
  )
  if (b.status !== 0) throw new Error(`vite build: ${b.stderr}${b.error ?? ''}`)
  const p = start(
    'vite-preview',
    process.execPath,
    [
      vite,
      'preview',
      '--outDir',
      out,
      '--host',
      '127.0.0.1',
      '--port',
      new URL(url).port,
      '--strictPort',
    ],
    { cwd },
  )
  await waitHttp(url, p)
  return { url, stop: p.stop }
}

test('Chromium 87 (webOS): the production build signs in to Gateways @shell', async () => {
  test.skip(
    !builds[process.platform],
    `no Chromium 87 build for ${process.platform}`,
  )
  const app = await serveBuild()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ executablePath: await chromium87() })
    const page = await browser.newPage()
    expect(browser.version()).toMatch(/^87\./)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.stack ?? e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    const user = await signUp(uniqueEmail('chrome87'))
    await page.goto(app.url + '/')
    await page.waitForFunction(() =>
      document.querySelector('input[type=email]'),
    )
    await page.evaluate(
      ([email, pw]) => {
        // React tracks the value setter: set through the prototype, then `input`.
        const set = (sel: string, v: string) => {
          const el = document.querySelector<HTMLInputElement>(sel)
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set
          if (!el || !setter) throw new Error(`no ${sel} or no value setter`)
          setter.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('input[type=email]', email)
        set('input[type=password]', pw)
        const form = document.querySelector('form')
        if (!form) throw new Error('no sign-in form')
        form.requestSubmit()
      },
      [user.email, password],
    )
    await page.waitForFunction(() =>
      [...document.querySelectorAll('h1')].some(
        (h) => h.textContent === 'Gateways',
      ),
    )
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await app.stop()
  }
})
