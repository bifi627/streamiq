// The household page and the no-household screen, no gateway or Jellyfin (#407):
// members and roles, remove and leave (#192), rename (#384), invites (#228, #337),
// join (#191), invite-first sign-up and life without a household (#387), the
// alias (#388), the switcher (#193), and a membership lost while the app is open
// (#210). Permission and edge cases (member refused, last admin, single-use,
// expired) are the backend's Members / Invites / Provisioning features.
import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  appUrl,
  join,
  newPage,
  password,
  signedInPage,
  signUp,
  uniqueEmail,
  type User,
} from './helpers.ts'

// householdLabel() in api.ts: an unnamed household (none renamed yet, #384).
const label = (u: User) => `Household …${u.tenantId.slice(-6)}`
const h1 = (p: Page) => p.getByRole('heading', { level: 1 })
const members = (p: Page) =>
  p.locator('section.card', {
    has: p.getByRole('heading', { name: 'Members' }),
  })
const row = (p: Page, name: string) =>
  members(p).getByRole('listitem').filter({ hasText: name })
const none = (p: Page) =>
  p.getByRole('heading', { name: "You're not in a household yet" })
/** Accepts the next confirm() ("Remove …?", "Leave this household?"). */
const confirmNext = (p: Page) => p.once('dialog', (d) => d.accept())

/** A (admin, alias Alice) and B (alias Bob, a member of A's household with one of
 * its own), A signed in on A's household page. */
async function adminWithMember(browser: Browser) {
  const A = await signUp(uniqueEmail('house-a'), { alias: 'Alice' })
  const B = await signUp(uniqueEmail('house-b'), { alias: 'Bob' })
  await join(A, B)
  const a = await signedInPage(browser, A, '/household')
  return { A, B, a }
}

test('members: listed by alias, Make admin / Make member @households', async ({
  browser,
}) => {
  const { A, B, a } = await adminWithMember(browser)
  await expect(members(a).getByText('Alice (you)')).toBeVisible()
  await expect(members(a).getByText(A.email)).toBeVisible() // own row: own email
  await expect(row(a, 'Bob')).toBeVisible()
  await expect(members(a).getByText(B.email)).toHaveCount(0) // others: alias only

  const bob = row(a, 'Bob')
  await bob.getByRole('button', { name: 'Make admin' }).click()
  await expect(bob.getByText('Admin', { exact: true })).toBeVisible()
  await a.reload()
  await expect(bob.getByText('Admin', { exact: true })).toBeVisible() // stored
  await bob.getByRole('button', { name: 'Make member' }).click()
  await expect(bob.getByText('Member', { exact: true })).toBeVisible()
  await a.reload()
  await expect(bob.getByText('Member', { exact: true })).toBeVisible()
})

test('remove: an admin removes a member @households', async ({ browser }) => {
  const { a } = await adminWithMember(browser)
  confirmNext(a) // "Remove Bob from this household?"
  await row(a, 'Bob').getByRole('button', { name: 'Remove' }).click()
  await expect(row(a, 'Bob')).toHaveCount(0)
})

test('leave: a member lands in its own household, no picker @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('leave-a'))
  const B = await signUp(uniqueEmail('leave-b'))
  await join(A, B)
  const b = await signedInPage(browser, B, '/household', A.tenantId)
  await expect(h1(b)).toHaveText(label(A))
  confirmNext(b) // "Leave this household?"
  await members(b).getByRole('button', { name: 'Leave' }).click()
  // Leaving reloads home, which goes on to /gateways: a click before that is lost.
  await expect(b.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  await b.getByRole('link', { name: 'Household' }).click()
  await expect(h1(b)).toHaveText(label(B))
  await expect(b.getByLabel('Switch household')).toHaveCount(0) // after /me
  expect(
    (await A.api<{ userId: string }[]>('/members')).map((m) => m.userId),
  ).toEqual([A.userId]) // gone from A's household, nothing else changed
})

test('rename: an admin renames, a member sees no Rename @households', async ({
  browser,
}) => {
  const { A, B, a } = await adminWithMember(browser)
  await a.getByRole('button', { name: 'Rename' }).click()
  // Stored by us: the field says so (#413).
  await expect(a.getByLabel('Household name')).toHaveAccessibleDescription(
    'Saved by StreamIQ.',
  )
  await a.getByLabel('Household name').fill('  The A family  ')
  await a.getByRole('button', { name: 'Save' }).click()
  await expect(h1(a)).toHaveText('The A family') // at once, no reload
  await a.reload()
  await expect(h1(a)).toHaveText('The A family') // stored

  const b = await signedInPage(browser, B, '/household', A.tenantId)
  await expect(h1(b)).toHaveText('The A family')
  await expect(b.getByText('You are a member')).toBeVisible()
  await expect(b.getByRole('button', { name: 'Rename' })).toHaveCount(0)
})

test('invites: make, revoke, make another; a member sees none @households', async ({
  browser,
}) => {
  const { A, B, a } = await adminWithMember(browser)
  await expect(a.getByText('You are an admin')).toBeVisible()
  const box = a.locator('.invite-link')
  await a.getByRole('button', { name: 'Invite someone' }).click()
  await expect(box.locator('pre')).toContainText('/join#')
  await a.getByRole('button', { name: 'Revoke' }).click()
  await expect(box).toHaveCount(0) // its link box goes with it
  await expect(a.getByText(/No open invites/)).toBeVisible()
  await a.getByRole('button', { name: 'Invite someone' }).click()
  await expect(box.locator('pre')).toContainText('/join#')
  await expect(a.getByRole('button', { name: 'Revoke' })).toHaveCount(1)

  const b = await signedInPage(browser, B, '/household', A.tenantId)
  await expect(b.getByText('You are a member')).toBeVisible()
  await expect(b.getByRole('heading', { name: 'Invites' })).toHaveCount(0)
  await expect(row(b, 'Alice')).toBeVisible() // a member sees the members too
})

test('join: Join lands in the household; a revoked link is refused @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('join-a'))
  const B = await signUp(uniqueEmail('join-b'))
  const { token } = await A.api('/invites', { method: 'POST' })
  const b = await signedInPage(browser, B, `/join#${token}`)
  await b.getByRole('button', { name: 'Join' }).click()
  await expect(b).not.toHaveURL(/\/join/)
  await b.getByRole('link', { name: 'Household' }).click()
  await expect(h1(b)).toHaveText(label(A))
  await expect(b.getByText('You are a member')).toBeVisible()

  // The API answers 404 for unknown, expired, used and revoked alike: one render.
  const revoked = await A.api('/invites', { method: 'POST' })
  await A.api(`/invites/${revoked.id}`, { method: 'DELETE' })
  await b.goto(appUrl(`/join#${revoked.token}`))
  await expect(
    b.getByText(/This invite link isn't valid anymore/),
  ).toBeVisible()
  await expect(b.getByRole('button', { name: 'Join' })).toHaveCount(0)
})

test('invite-first sign-up: only that household, no picker @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('first-a'))
  const email = uniqueEmail('first-new')
  const { token } = await A.api('/invites', { method: 'POST' })
  const c = await newPage(browser)
  await c.goto(appUrl(`/join#${token}`))
  await c.getByRole('button', { name: 'Create an account' }).click()
  await c.getByLabel('Email').fill(email)
  await c.getByLabel('Password', { exact: true }).fill(password)
  await c.getByRole('button', { name: 'Create account' }).click()
  await expect(c.getByLabel('Your name')).toHaveValue(email) // alias first (#388)
  await c.getByLabel('Your name').fill('Dana')
  await c.getByRole('button', { name: 'Continue' }).click()
  await c.getByRole('button', { name: 'Join' }).click()
  await expect(c).not.toHaveURL(/\/join/)
  await c.getByRole('link', { name: 'Household' }).click()
  await expect(h1(c)).toHaveText(label(A))
  await expect(members(c).getByText('Dana (you)')).toBeVisible()
  await expect(c.getByText('You are a member')).toBeVisible()
  await expect(c.getByLabel('Switch household')).toHaveCount(0) // exactly one
})

// Leaving the last household through the UI is how this user gets to have none.
test('no household: the screen, Gateways locked, Settings opens @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('none-a'))
  const C = await signUp(uniqueEmail('none-c'), { household: false })
  await join(A, C)
  const c = await signedInPage(browser, C, '/household')
  await expect(h1(c)).toHaveText(label(A))
  confirmNext(c) // "Leave this household?"
  await members(c).getByRole('button', { name: 'Leave' }).click()
  await expect(none(c)).toBeVisible()
  await expect(c.getByRole('link', { name: 'Gateways' })).toHaveCount(0)
  await c.goto(appUrl('/gateways'))
  await expect(none(c)).toBeVisible() // household pages are locked
  await c.getByRole('link', { name: 'Settings' }).click()
  await expect(c.getByRole('heading', { name: 'Settings' })).toBeVisible() // per-device settings
  await c.goto(appUrl())
  await expect(none(c)).toBeVisible()
})

test('no household: paste an invite link, Open, Join @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('paste-a'))
  const C = await signUp(uniqueEmail('paste-c'), { household: false })
  const c = await signedInPage(browser, C, '/')
  await expect(none(c)).toBeVisible()
  const { token } = await A.api('/invites', { method: 'POST' })
  await c.getByLabel('Invite link').fill(appUrl(`/join#${token}`))
  await c.getByRole('button', { name: 'Open' }).click()
  await c.getByRole('button', { name: 'Join' }).click()
  await expect(c).not.toHaveURL(/\/join/)
  await c.getByRole('link', { name: 'Household' }).click()
  await expect(h1(c)).toHaveText(label(A))
  await expect(c.getByText('You are a member')).toBeVisible()
})

test('no household: Create a household, its admin, Gateways opens @households', async ({
  browser,
}) => {
  const C = await signUp(uniqueEmail('create-c'), { household: false })
  const c = await signedInPage(browser, C, '/')
  await c.getByRole('button', { name: 'Create a household' }).click()
  await expect(c.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  await c.getByRole('link', { name: 'Household' }).click()
  await expect(c.getByText('You are an admin')).toBeVisible()
  await expect(members(c).getByText(`${C.email} (you)`)).toBeVisible()
})

test('alias: asked first, others see it not the email, renamed in Settings @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('alias-a'))
  const C = await signUp(uniqueEmail('alias-c'), { alias: null }) // no alias yet
  await join(A, C)
  const c = await signedInPage(browser, C, '/household', A.tenantId)
  const alias = c.getByLabel('Your name')

  // Asked before the app, again after a reload, email prefilled.
  await expect(alias).toHaveValue(C.email)
  await c.reload()
  await expect(alias).toHaveValue(C.email)
  await expect(c.getByRole('link', { name: 'Household' })).toHaveCount(0)

  // Picked: the app opens, members show it; others get the alias, not the email.
  await alias.fill('Carol')
  await c.getByRole('button', { name: 'Continue' }).click()
  await expect(c.getByText('Carol (you)')).toBeVisible()
  await expect(c.getByText(C.email)).toBeVisible() // own row: own email
  const seen = await A.api<{ name: string; email?: string }[]>('/members')
  expect(seen.map((m) => m.name)).toEqual([A.email, 'Carol'])
  expect(seen[1].email).toBeUndefined()

  // Renamed later in Settings.
  await c.getByRole('link', { name: 'Settings' }).click()
  await c.getByRole('button', { name: 'Rename' }).click()
  await alias.fill('Caro')
  await c.getByRole('button', { name: 'Save' }).click()
  await expect(c.getByText('Caro', { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await A.api<{ name: string }[]>('/members'))[1].name)
    .toBe('Caro')
})

test('switcher: two households switch and back; one, no picker @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('switch-a'))
  const B = await signUp(uniqueEmail('switch-b'))
  const b = await signedInPage(browser, B, '/household')
  await expect(h1(b)).toHaveText(label(B))
  const picker = b.getByLabel('Switch household')
  await expect(picker).toHaveCount(0) // one household: no picker

  await join(A, B)
  await b.reload() // /me again: two households
  await expect(picker).toHaveValue(B.tenantId)
  await picker.selectOption(A.tenantId) // reloads /
  await expect(picker).toHaveValue(A.tenantId)
  await b.getByRole('link', { name: 'Household' }).click()
  await expect(h1(b)).toHaveText(label(A))
  await expect(b.getByText('You are a member')).toBeVisible()
  await picker.selectOption(B.tenantId)
  await expect(picker).toHaveValue(B.tenantId)
  await b.getByRole('link', { name: 'Household' }).click()
  await expect(h1(b)).toHaveText(label(B))
  await expect(b.getByText('You are an admin')).toBeVisible()
})

test('lost membership: removed while open, next action shows the notice @households', async ({
  browser,
}) => {
  const A = await signUp(uniqueEmail('lost-a'))
  const B = await signUp(uniqueEmail('lost-b'))
  await join(A, B)
  const b = await signedInPage(browser, B, '/gateways', A.tenantId)
  await expect(b.getByRole('heading', { name: 'Gateways' })).toBeVisible()
  await A.api(`/members/${B.userId}`, { method: 'DELETE' })
  await b.getByRole('link', { name: 'Household' }).click() // /members: not a member
  await expect(
    b.getByRole('status').filter({ hasText: 'no longer a member' }),
  ).toContainText(`You're no longer a member of ${label(A)}.`)
  await b.getByRole('link', { name: 'Household' }).click()
  await expect(h1(b)).toHaveText(label(B))
  await expect(b.getByLabel('Switch household')).toHaveCount(0) // after /me
})
