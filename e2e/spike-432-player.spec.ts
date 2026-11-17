// Spike #432 only (never merged): the D-pad (arrows, OK = Enter, webOS Back)
// through the player's settings popover built from UI SDK's Menu.
import { test, expect } from './fixtures'
import { videoTime } from './helpers'

test('spike 432: D-pad through the player popover @player', async ({
  paired,
}) => {
  const p = paired.page
  await p.getByRole('button', { name: 'Open' }).click()
  await p.getByRole('button', { name: /Movies/ }).click()
  await p.getByRole('button', { name: /streamiq e2e clip/ }).click()
  await p.getByRole('button', { name: /^(Play|Resume)$/ }).click()
  await expect.poll(() => videoTime(p), { timeout: 30_000 }).toBeGreaterThan(0)

  const focused = () =>
    p.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const open = [...document.querySelectorAll('[role="menu"]')]
        .map((m) => m.getAttribute('aria-label'))
        .join(',')
      return `${el.getAttribute('role') ?? el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" checked=${el.getAttribute('aria-checked')} menus=[${open}]`
    })
  const log: string[] = []
  const press = async (k: string) => {
    if (k === 'GoBack')
      await p.evaluate(() =>
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'GoBack',
            bubbles: true,
            cancelable: true,
          }),
        ),
      )
    else await p.keyboard.press(k)
    log.push(`${k} → ${await focused()}`)
  }
  await press('ArrowDown') // focus Play
  for (let i = 0; i < 8 && !(await focused()).includes('Playback options'); i++)
    await press('ArrowRight')
  // open, into Quality, its options, back up with webOS Back, back out
  for (const k of [
    'Enter',
    'ArrowDown',
    'ArrowUp',
    'Enter',
    'ArrowDown',
    'ArrowUp',
    'GoBack',
    'GoBack',
  ])
    await press(k)
  // open → ArrowRight into a submenu → pick with Enter
  for (const k of ['Enter', 'ArrowRight', 'ArrowDown', 'Enter']) await press(k)
  // Escape twice
  for (const k of ['Enter', 'ArrowRight']) await press(k)
  await p.screenshot({ path: 'spike-432-player.png' })
  for (const k of ['Escape', 'Escape', 'ArrowLeft']) await press(k)
  // ↑/↓ on the closed gear: the bar's key model moves rows (#205)
  await p.getByRole('button', { name: 'Playback options' }).focus()
  log.push(`focus gear → ${await focused()}`)
  for (const k of ['ArrowUp', 'Escape']) await press(k)
  await p.getByRole('button', { name: 'Playback options' }).focus()
  for (const k of ['ArrowDown', 'Escape']) await press(k)
  console.log(['SPIKE432P', ...log].join('\n'))
})
