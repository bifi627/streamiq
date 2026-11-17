// Spike #432 only (never merged): how the D-pad (arrow keys) and OK (Enter)
// move through the Settings page built from UI SDK components.
import { test, expect } from './fixtures'
import { signIn, signUp, uniqueEmail } from './helpers'

test('spike 432: D-pad through Settings @households', async ({ page }) => {
  const u = await signUp(uniqueEmail('spike432'))
  await page.goto(process.env.E2E_APP_URL!)
  await signIn(page, u)
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  await page.evaluate(() =>
    window.addEventListener('keydown', (e) => {
      ;(window as any).prevented = e.defaultPrevented
    }),
  )
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const name = (
        el.closest('.setting, li')?.textContent ??
        el.textContent ??
        ''
      )
        .trim()
        .slice(0, 24)
      return `${el.getAttribute('role') ?? el.tagName.toLowerCase()} [${name}] text="${el.textContent?.trim().slice(0, 12)}" checked=${el.getAttribute('aria-checked')} prevented=${(window as any).prevented}`
    })
  const log: string[] = [`start: ${await focused()}`]
  const press = async (k: string) => {
    await page.keyboard.press(k)
    log.push(`${k} → ${await focused()}`)
  }
  await press('Enter') // OK on the Compatible mode switch
  await press(' ')
  await press(' ')
  for (const k of [
    'ArrowLeft',
    'ArrowRight',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowDown',
    'ArrowUp',
    'ArrowUp',
    'ArrowUp',
  ])
    await press(k)
  console.log('SPIKE432\n' + log.join('\n'))
  await page.getByRole('radio', { name: 'Off' }).focus()
  log.push(`focus Off → ${await focused()}`)
  for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Enter'])
    await press(k)
  log.push(
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot^="segmented-control"]')]
        .map(
          (e) =>
            `${e.tagName} ${e.getAttribute('data-slot')} role=${e.getAttribute('role')} tabindex=${e.getAttribute('tabindex')}`,
        )
        .join(' | '),
    ),
  )
  console.log(['SPIKE432', ...log].join('\n'))
  await page.screenshot({ path: 'spike-432-settings.png', fullPage: true })
})
