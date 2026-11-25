import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchTarget } from './switchTarget.ts'

test('household-independent pages stay', () => {
  for (const p of [
    '/settings',
    '/settings/',
    '/settings/playback',
    '/settings/households',
    '/settings/household',
    '/gateways',
    '/gateways/',
  ])
    assert.equal(switchTarget(p), p)
})

test('any other page goes home', () => {
  for (const p of [
    '/',
    '/g/abc',
    '/g/abc/i/1',
    '/gateways/abc',
    '/join',
    '/activity',
    '/household',
    '/diagnostics',
    '/settingsx',
    '/gatewaysx',
  ])
    assert.equal(switchTarget(p), '/')
})
