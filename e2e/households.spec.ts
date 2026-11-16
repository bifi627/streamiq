// Web-app household flows, no gateway or Jellyfin needed (#232): join through an
// invite link (#191), the switcher (#193), leave and removal by an admin (#192),
// the "no longer a member" recovery while the app is open (#210), and life
// without a household (#387). The
// invite UI itself is driven in multi-user.spec.ts.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  newPage,
  password,
  signIn,
  signUp,
  uniqueEmail,
  type User,
} from './helpers.ts'

const app = () => process.env.E2E_APP_URL!
// householdLabel() in api.ts: an unnamed household (none renamed yet, #384).
const label = (u: User) => `Household …${u.tenantId.slice(-6)}`

test('households: join, switch, removed while open, leave @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('house-a'))
  const B = await signUp(uniqueEmail('house-b'))
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
    // Leaving reloads home, which goes on to /gateways: a click before that is lost.
    await expect(b.getByRole('heading', { name: 'Gateways' })).toBeVisible()
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

// Sign-up makes no household (#387): invite-first sign-up joins only that one;
// without a household the app is the no-household screen (Settings still opens);
// leaving the last household lands there; Create a household makes the user admin.
test('households: sign up through an invite, none left, create one @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('house-owner'))
  const email = uniqueEmail('house-joiner')
  const c = await newPage(browser)
  const heading = c.getByRole('heading', { level: 1 })
  const none = c.getByRole('heading', { name: "You're not in a household yet" })

  await test.step('a new account opens an invite link first: joins only that household', async () => {
    const { token } = await A.api('/invites', { method: 'POST' })
    await c.goto(`${app()}/join#${token}`)
    await c.getByRole('button', { name: 'Create an account' }).click()
    await c.getByLabel('Email').fill(email)
    await c.getByLabel('Password', { exact: true }).fill(password)
    await c.getByRole('button', { name: 'Create account' }).click()
    await c.getByRole('button', { name: 'Join' }).click()
    await expect(c).not.toHaveURL(/\/join/)
    await c.getByRole('link', { name: 'Household' }).click()
    await expect(heading).toHaveText(label(A))
    await expect(c.getByText('You are a member')).toBeVisible()
    await expect(c.getByLabel('Switch household')).toHaveCount(0) // exactly one
  })

  await test.step('leaving the last household: the no-household screen, no new household', async () => {
    c.once('dialog', (d) => d.accept()) // "Leave this household?"
    await c.getByRole('button', { name: 'Leave' }).click()
    await expect(none).toBeVisible()
    await expect(c.getByRole('link', { name: 'Gateways' })).toHaveCount(0)
    await c.goto(`${app()}/gateways`)
    await expect(none).toBeVisible() // household pages are locked
    await c.getByRole('link', { name: 'Settings' }).click()
    await expect(c.getByRole('heading', { name: 'Settings' })).toBeVisible() // per-device settings still open
    await c.goto(app())
    await expect(none).toBeVisible()
  })

  await test.step('pasting an invite link joins again', async () => {
    const { token } = await A.api('/invites', { method: 'POST' })
    await c.getByLabel('Invite link').fill(`${app()}/join#${token}`)
    await c.getByRole('button', { name: 'Open' }).click()
    await c.getByRole('button', { name: 'Join' }).click()
    await expect(c).not.toHaveURL(/\/join/)
    await c.getByRole('link', { name: 'Household' }).click()
    await expect(heading).toHaveText(label(A))
    c.once('dialog', (d) => d.accept())
    await c.getByRole('button', { name: 'Leave' }).click()
    await expect(none).toBeVisible()
  })

  await test.step('Create a household: its admin, the Gateways page opens', async () => {
    await c.getByRole('button', { name: 'Create a household' }).click()
    await expect(c.getByRole('heading', { name: 'Gateways' })).toBeVisible()
    await c.getByRole('link', { name: 'Household' }).click()
    await expect(c.getByText('You are an admin')).toBeVisible()
    expect(
      (await A.api<{ email: string }[]>('/members')).map((m) => m.email),
    ).toEqual([A.email]) // A's household: C left it, nothing else changed
  })
})
