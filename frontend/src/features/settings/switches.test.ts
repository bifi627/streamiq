import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tvPickers } from './switches.ts'

test('tvPickers: TV mode only, each with 2+ to pick from', () => {
  assert.deepEqual(tvPickers(true, 2, 1), { household: true, gateway: false })
  assert.deepEqual(tvPickers(true, 1, 2), { household: false, gateway: true })
  assert.deepEqual(tvPickers(true, 1, 1), { household: false, gateway: false })
  assert.deepEqual(tvPickers(false, 3, 3), { household: false, gateway: false })
})
