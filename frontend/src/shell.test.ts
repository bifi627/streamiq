import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromeless, libraryTarget, screenTarget, tabs } from './shell.ts'

test('tabs: all five, TV keeps Library + Settings, no household keeps what opens', () => {
  assert.deepEqual(tabs(false, false), [
    'gateways',
    'activity',
    'library',
    'household',
    'settings',
  ])
  assert.deepEqual(tabs(true, false), ['library', 'settings'])
  assert.deepEqual(tabs(false, true), ['household', 'settings'])
  assert.deepEqual(tabs(true, true), ['settings'])
})

test('libraryTarget: open, else last if listed, else the only one', () => {
  assert.equal(libraryTarget('a', 'b', ['a', 'b']), 'a')
  assert.equal(libraryTarget(undefined, 'b', ['a', 'b']), 'b')
  assert.equal(libraryTarget(undefined, 'gone', ['a', 'b']), null)
  assert.equal(libraryTarget(undefined, 'gone', ['a']), 'a')
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
