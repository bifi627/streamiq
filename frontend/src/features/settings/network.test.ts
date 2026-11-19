// Run: node --test src/features/settings/network.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { netReport } from './network.ts'

test('net report: type + save data, "unknown" without a type, none without the API', () => {
  assert.equal(
    netReport({ type: 'cellular', saveData: true }),
    'connection cellular, save data on',
  )
  assert.equal(netReport({}), 'connection unknown, save data off')
  assert.equal(netReport(undefined), 'nothing (no Network Information API)')
})
