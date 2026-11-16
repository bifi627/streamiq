// Web-app household flows, no gateway or Jellyfin needed (#232): join through an
// invite link (#191), the switcher (#193), leave and removal by an admin (#192),
// and the "no longer a member" recovery while the app is open (#210). The
// invite UI itself is driven in multi-user.spec.ts.
import { expect, test, type Page } from '@playwright/test'
import { newPage, signIn, signUp, type User } from './helpers.ts'

const app = () => process.env.E2E_APP_URL!
// householdLabel() in api.ts: an unnamed household (none renamed yet, #384).
const label = (u: User) => `Household …${u.tenantId.slice(-6)}`

test('households: join, switch, removed while open, leave', async ({
  browser,
}) => {
  const run = test.info().repeatEachIndex
  const A = await signUp(`e2e-house-a-${run}@streamiq.test`)
  const B = await signUp(`e2e-house-b-${run}@streamiq.test`)
  const b = await newPage(browser)
  await b.goto(app() + '/household')
  await signIn(b, B)
  const heading = b.getByRole('heading', { level: 1 })
  await expect(heading).toHaveText(label(B))
  const picker = b.getByLabel('Switch household')
  await expect(picker).toHaveCount(0) // one household: no picker

  // A (admin of A's household) makes a link; B, signed in, opens and joins it.
  const join = async (p: Page) => {
    const { token } = await A.api('/invites', { method: 'POST' })
    await p.goto(`${app()}/join#${token}`)
    await p.getByRole('button', { name: 'Join' }).click()
    await expect(p).not.toHaveURL(/\/join/)
    await p.getByRole('link', { name: 'Household' }).click()
    await expect(p.getByRole('heading', { level: 1 })).toHaveText(label(A))
    await expect(p.getByText('You are a member')).toBeVisible()
    await expect(p.getByRole('button', { name: 'Rename' })).toHaveCount(0) // admin only (#384)
  }

  await test.step('B joins A’s household through an invite link (#191)', async () => {
    await join(b)
    await expect(picker).toHaveValue(A.tenantId)
  })

  await test.step('B switches household with the picker, and back (#193)', async () => {
    await picker.selectOption(B.tenantId) // reloads /
    await expect(picker).toHaveValue(B.tenantId)
    await b.getByRole('link', { name: 'Household' }).click()
    await expect(heading).toHaveText(label(B))
    await expect(b.getByText('You are an admin')).toBeVisible()
    await picker.selectOption(A.tenantId)
    await expect(picker).toHaveValue(A.tenantId)
  })

  await test.step('A removes B while B’s app is open: next action → notice (#210)', async () => {
    await A.api(`/members/${B.userId}`, { method: 'DELETE' })
    await b.getByRole('link', { name: 'Household' }).click() // /members: not a member
    await expect(
      b.getByRole('status').filter({ hasText: 'no longer a member' }),
    ).toContainText(`You're no longer a member of ${label(A)}.`)
    await b.getByRole('link', { name: 'Household' }).click()
    await expect(heading).toHaveText(label(B))
    await expect(picker).toHaveCount(0) // after /me: the Shell renders it then
  })

  await test.step('B leaves a household: back in its own (#192)', async () => {
    await join(b)
    const members = b.locator('section.card', {
      has: b.getByRole('heading', { name: 'Members' }),
    })
    await expect(members.getByText(A.email)).toBeVisible()
    b.once('dialog', (d) => d.accept()) // "Leave this household?"
    await members.getByRole('button', { name: 'Leave' }).click()
    await b.getByRole('link', { name: 'Household' }).click()
    await expect(heading).toHaveText(label(B))
    await expect(picker).toHaveCount(0) // after /me: the Shell renders it then
    expect(
      (await A.api<{ userId: string }[]>('/members')).map((m) => m.userId),
    ).toEqual([A.userId])
  })

  await test.step('B, an admin, renames its household (#384)', async () => {
    await b.getByRole('button', { name: 'Rename' }).click()
    await b.getByLabel('Household name').fill('  The B family  ')
    await b.getByRole('button', { name: 'Save' }).click()
    await expect(heading).toHaveText('The B family') // at once, no reload
    await b.reload()
    await expect(heading).toHaveText('The B family') // stored
  })
})
