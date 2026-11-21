import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailLine, initial, memberNames, roleView } from './memberNames.ts'

const m = (userId: string, name: string | null, email?: string) => ({
  userId,
  name,
  email,
})

test('unique names get no tag', () => {
  const names = memberNames([m('1-aaaa', 'Alex'), m('1-bbbb', 'Sam')])
  assert.equal(names.get('1-aaaa'), 'Alex')
  assert.equal(names.get('1-bbbb'), 'Sam')
})

test('duplicates both get the last 4 userId chars as a tag', () => {
  const names = memberNames([
    m('0000-12343f9a', 'Alex'),
    m('0000-56787c2e', 'Alex'),
    m('0000-11112222', 'Sam'),
  ])
  assert.equal(names.get('0000-12343f9a'), 'Alex #3f9a')
  assert.equal(names.get('0000-56787c2e'), 'Alex #7c2e')
  assert.equal(names.get('0000-11112222'), 'Sam')
})

test('case and whitespace variants count as the same name', () => {
  const names = memberNames([m('1aaaa', 'Alex'), m('1bbbb', ' alex ')])
  assert.equal(names.get('1aaaa'), 'Alex #aaaa')
  assert.equal(names.get('1bbbb'), 'alex #bbbb')
})

test('a 4-char collision grows the tag until it differs, dashes skipped', () => {
  const names = memberNames([m('b1-3f9a', 'Alex'), m('c2-3f9a', 'Alex')])
  assert.equal(names.get('b1-3f9a'), 'Alex #13f9a')
  assert.equal(names.get('c2-3f9a'), 'Alex #23f9a')
})

test('no name falls back to the email, then "unknown user"', () => {
  const names = memberNames([m('1aaaa', null, 'me@x'), m('1bbbb', null)])
  assert.equal(names.get('1aaaa'), 'me@x')
  assert.equal(names.get('1bbbb'), 'unknown user')
})

test('a blank alias (set outside the app) falls back, never an empty name', () => {
  const names = memberNames([m('1aaaa', '   ', 'me@x'), m('1bbbb', '  ')])
  assert.equal(names.get('1aaaa'), 'me@x')
  assert.equal(names.get('1bbbb'), 'unknown user')
})

test('a member row: avatar letter, email line, role flip', () => {
  assert.equal(initial('émile'), 'É')
  assert.equal(initial('👍🏽 Sam'), '👍🏽')
  assert.equal(initial(''), '')
  assert.equal(emailLine(m('1', 'Alex', 'a@x.de')), 'a@x.de')
  assert.equal(emailLine(m('1', 'a@x.de', 'a@x.de')), '')
  assert.equal(emailLine(m('1', 'Alex')), '')
  assert.equal(roleView('admin').to, 'member')
  assert.equal(roleView('member').to, 'admin')
})
