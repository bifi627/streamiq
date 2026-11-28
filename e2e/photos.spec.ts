// The Photos tab on a paired browser (fixtures.ts `paired`), against
// the fixture's Photos library (stack.ts: Album with Wide / Tall / Square, a
// sub-folder Inner and a clip; an Empty folder): the nav tab, the
// library off the Library home, folders before photos, covers, square tiles,
// the viewer (screen-sized, ←/→, swipe, Back / Escape back to the
// photo), TV mode's D-pad and favorites (the viewer's heart, the
// Favorites row on the Photos home, not on the Library home).
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

test('photos: the heart in the viewer, the Favorites row above the libraries; not on the Library home (#1025) @library', async ({
  paired,
}) => {
  const { page } = paired
  const heart = viewer(page).getByRole('button', { name: 'Favorite' })
  const row = page.locator('section.shelf', {
    has: page.getByRole('heading', { name: 'Favorites' }),
  })
  const photosHome = async () => {
    await nav(page).getByRole('link', { name: 'Photos' }).click()
    await expect(page).toHaveURL(/\/photos$/)
    await expect(tile(page, 'Photos')).toBeVisible()
  }
  await openAlbum(page)
  await photosHome()
  await expect(row).toHaveCount(0) // no favorite yet: no row
  await expect(page.getByRole('heading', { name: 'Libraries' })).toHaveCount(0)

  await tile(page, 'Photos').click()
  await tile(page, 'Album').click()
  await tile(page, 'Wide').click()
  await expect(heart).toHaveAttribute('aria-pressed', 'false')
  await heart.click()
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
  await expect(viewer(page)).toBeFocused() // ←/→ still step after the save
  await page.keyboard.press('ArrowLeft') // the heart follows the photo
  await expect(viewer(page)).toHaveAccessibleName('Tall')
  await expect(heart).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(viewer(page)).toHaveAccessibleName('Wide')
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await tile(page, 'Square').click()
  await heart.click()
  await expect(heart).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')

  // The row comes first, then the libraries under their own heading.
  await photosHome()
  await expect(page.locator('main h2')).toHaveText(['Favorites', 'Libraries'])
  const favs = row.getByRole('button')
  await expect(favs).toHaveCount(2)
  await favs.first().click()
  const first = await viewer(page).getAttribute('aria-label')
  await page.keyboard.press('ArrowRight') // steps through the favorites only
  const second = first === 'Wide' ? 'Square' : 'Wide'
  await expect(viewer(page)).toHaveAccessibleName(second)
  await heart.click() // un-hearted: still in the open row, gone on the next load
  await expect(heart).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ArrowLeft')
  await expect(viewer(page)).toHaveAccessibleName(first ?? '')
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(favs).toHaveCount(2)
  await tile(page, 'Photos').click()
  await photosHome()
  await expect(favs).toHaveCount(1)
  await expect(row.getByRole('button', { name: first ?? '' })).toBeVisible()

  await page.reload() // a cold home: it shows once every row has answered
  await openLibrary(page)
  await expect(page.locator('section.shelf h2').first()).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Favorites', exact: true }),
  ).toHaveCount(0)
})
