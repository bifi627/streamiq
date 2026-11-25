import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chromeless,
  libraryTarget,
  screenTarget,
  TAB_TO,
  tabs,
} from './shell.ts'

test('tabs: three with Library in the middle, TV keeps Library + Settings, no household keeps Household', () => {
  assert.deepEqual(tabs(false, false), ['gateways', 'library', 'settings'])
  assert.deepEqual(tabs(true, false), ['library', 'settings'])
  assert.deepEqual(tabs(false, true), ['household', 'settings'])
  assert.deepEqual(tabs(true, true), ['settings'])
})

test('no household: the Household tab opens a households page (the no-household screen)', () => {
  assert.equal(TAB_TO.household, '/settings/households')
})

test('libraryTarget: open, else last if listed, else first online, else first', () => {
  const up = (id: string) => ({ id, online: true })
  const down = (id: string) => ({ id, online: false })
  const both = [down('a'), up('b')]
  assert.equal(libraryTarget('x', 'a', both), 'x')
  assert.equal(libraryTarget(undefined, 'a', both), 'a')
  assert.equal(libraryTarget(undefined, 'gone', both), 'b')
  assert.equal(libraryTarget(undefined, null, both), 'b')
  assert.equal(libraryTarget(undefined, null, [down('a'), down('b')]), 'a')
  assert.equal(libraryTarget(undefined, null, []), null)
})

test('chromeless: only the player', () => {
  assert.equal(chromeless('/g/x/play/y'), true)
  assert.equal(chromeless('/g/x/i/y'), false)
  assert.equal(chromeless('/g/x/screen'), false)
})

test('screenTarget: TV mode with an active gateway, not on its screen page', () => {
  assert.equal(screenTarget(true, 'a', '/library'), 'a')
  assert.equal(screenTarget(false, 'a', '/library'), null)
  assert.equal(screenTarget(true, null, '/settings'), null)
  assert.equal(screenTarget(true, 'a', '/g/a/screen'), null)
})
