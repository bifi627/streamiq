// The Photos tab on a paired browser (fixtures.ts `paired`), against
// the fixture's Photos library (stack.ts: Album with Wide / Tall / Square, a
// sub-folder Inner and a clip; an Empty folder): the nav tab, the
// library off the Library home, folders before photos, covers, square tiles,
// the viewer (screen-sized, ←/→, swipe, Back / Escape back to the
// photo) and TV mode's D-pad.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { appUrl, openCategory, openLibrary } from './helpers.ts'

const nav = (p: Page) => p.getByRole('navigation', { name: 'Main' })
const viewer = (p: Page) => p.getByRole('dialog')
const tile = (p: Page, name: string) =>
  p.locator('.photo-grid').getByRole('button', { name, exact: true })

/** Library → the Photos tab → the Photos library → Album. */
async function openAlbum(p: Page) {
  await openLibrary(p)
  await nav(p).getByRole('link', { name: 'Photos' }).click()
  await tile(p, 'Photos').click()
  await tile(p, 'Album').click()
  await expect(p.locator('.titlerow-title')).toHaveText('Album')
}

const ratio = async (p: Page, name: string) => {
  const box = await tile(p, name).boundingBox()
  return box ? box.width / box.height : 0
}

test('photos: own tab, off the Library home; folders first with covers, square tiles, no videos @library', async ({
  paired,
}) => {
  const { page } = paired
  await openLibrary(page)
  const row = page.locator('section.shelf', {
    has: page.getByRole('heading', { name: 'Library' }),
  })
  await expect(row.getByRole('button')).toHaveText([/Movies/, /Shows/])
  await expect(nav(page).getByRole('link')).toHaveText([
    'Gateways',
    'Library',
    'Photos',
    'Settings',
  ])

  await nav(page).getByRole('link', { name: 'Photos' }).click()
  await expect(page).toHaveURL(/\/g\/[^/]+\/photos$/)
  await expect(nav(page).getByRole('link', { name: 'Photos' })).toHaveAttribute(
    'data-status',
    'active',
  )
  await expect(
    nav(page).getByRole('link', { name: 'Library' }),
  ).not.toHaveAttribute('data-status', 'active')
  await tile(page, 'Photos').click()
  // Album's cover is its first photo; Empty has none: a folder icon.
  await expect(page.locator('.photo-grid button')).toHaveText([
    'Album',
    'Empty',
  ])
  await expect(tile(page, 'Album').locator('img')).toBeVisible()
  await expect(tile(page, 'Empty').getByTestId('folder-icon')).toBeVisible()

  await tile(page, 'Album').click()
  await expect(page.locator('.photo-grid button')).toHaveCount(4) // no clip
  await expect(page.locator('.photo-grid button').first()).toHaveText('Inner')
  for (const name of ['Inner', 'Square', 'Tall', 'Wide'])
    await expect.poll(() => ratio(page, name)).toBeCloseTo(1, 1)
})

test('photos: the viewer is screen-sized, steps with ←/→ and swipes, Back and Escape return to the photo @library', async ({
  paired,
}) => {
  const { page } = paired
  await page.setViewportSize({ width: 1000, height: 600 })
  await openAlbum(page)
  await page.reload() // a deep link: the tab comes back with the folder
  await expect(nav(page).getByRole('link', { name: 'Photos' })).toBeVisible()
  await tile(page, 'Wide').click()
  await expect(viewer(page)).toHaveAccessibleName('Wide')
  await expect(viewer(page)).toContainText('Wide')
  // 1600×800 fitted into the screen (1000×600 at DPR 1), not the original.
  const img = viewer(page).locator('img')
  await expect
    .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBe(1000)

  await page.keyboard.press('ArrowLeft')
  await expect(viewer(page)).toHaveAccessibleName('Tall')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight') // the last one: stays
  await expect(viewer(page)).toHaveAccessibleName('Wide')

  const swipe = (dx: number) =>
    viewer(page).evaluate((el, dx) => {
      const t = (x: number) =>
        new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 })
      el.dispatchEvent(
        new TouchEvent('touchstart', { bubbles: true, touches: [t(500)] }),
      )
      el.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          changedTouches: [t(500 + dx)],
        }),
      )
    }, dx)
  await swipe(200) // right: previous
  await expect(viewer(page)).toHaveAccessibleName('Tall')
  await swipe(-200) // left: next
  await expect(viewer(page)).toHaveAccessibleName('Wide')

  // Steps replace the entry: one Back closes the viewer.
  await page.goBack()
  await expect(viewer(page)).toBeHidden()
  await expect(tile(page, 'Wide')).toBeFocused()
  await tile(page, 'Square').click()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(tile(page, 'Square')).toBeFocused()
  await expect(page).toHaveURL(/\/photos\/[^/?]+$/)
})

test('photos: TV mode has Library · Photos · Settings and the D-pad works in the grid and the viewer @library', async ({
  paired,
}) => {
  const { page } = paired
  await page.goto(appUrl('/settings'))
  await openCategory(page, 'Display')
  await page.getByLabel('TV mode').check()
  await openAlbum(page)
  await expect(nav(page).getByRole('link')).toHaveText([
    'Library',
    'Photos',
    'Settings',
  ])
  await tile(page, 'Square').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tile(page, 'Tall')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(viewer(page)).toHaveAccessibleName('Tall')
  await page.keyboard.press('ArrowRight')
  await expect(viewer(page)).toHaveAccessibleName('Wide')
  await page.keyboard.press('ArrowDown') // stays in the viewer
  await page.keyboard.press('ArrowLeft')
  await expect(viewer(page)).toHaveAccessibleName('Tall')
  await page.goBack() // the remote's Back
  await expect(tile(page, 'Tall')).toBeFocused()
})
