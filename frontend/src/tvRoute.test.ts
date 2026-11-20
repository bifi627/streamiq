import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handoffHome, shellPage, tvRoute } from './tvRoute.ts'

test('allowed routes', () => {
  for (const p of [
    '/',
    '/g/abc',
    '/g/abc/',
    '/g/abc/i/1',
    '/g/abc/play/1',
    '/g/abc/screen',
    '/g/abc/remote/s1',
    '/settings',
    '/diagnostics',
    '/gateways',
  ])
    assert.equal(tvRoute(p), 'allow', p)
})

test('manage and unknown routes hand off', () => {
  for (const p of ['/household', '/join', '/no-such-page', '/gx', '/settingsx'])
    assert.equal(tvRoute(p), 'handoff', p)
})

test('shell page: TV off is unchanged', () => {
  assert.equal(shellPage('/household', false, false), 'outlet')
  assert.equal(shellPage('/gateways', false, true), 'noHousehold')
  assert.equal(shellPage('/join', false, true), 'outlet')
  assert.equal(shellPage('/settings', false, true), 'outlet')
})

test('shell page: TV on', () => {
  assert.equal(shellPage('/household', true, false), 'handoff')
  assert.equal(shellPage('/settings', true, false), 'outlet')
  assert.equal(shellPage('/gateways', true, true), 'handoffHousehold')
  assert.equal(shellPage('/join', true, true), 'handoff') // its invite URL
  assert.equal(shellPage('/settings', true, true), 'outlet')
})

test('handoff Back with no history: /, or /settings when / hands off too', () => {
  assert.equal(handoffHome(true, false), '/')
  assert.equal(handoffHome(true, true), '/settings')
})
