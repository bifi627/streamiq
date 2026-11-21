import { test } from 'node:test'
import assert from 'node:assert/strict'
import { telemetryView } from './telemetry.ts'

const view = (
  telemetry: 'off' | 'full' | null,
  manage: boolean,
  pending: 'off' | 'full' | null = null,
) => telemetryView({ telemetry, manage, pending })

test('the line follows the last heartbeat; nothing without a level', () => {
  assert.equal(view('full', false).label, 'on')
  assert.equal(view('off', false).label, 'off')
  assert.deepEqual(view(null, true), {
    label: null,
    toggle: false,
    waiting: false,
  })
})

test('only an admin who can reach it gets the switch', () => {
  assert.equal(view('off', true).toggle, true)
  assert.equal(view('full', false).toggle, false)
})

test('a switch waits until a heartbeat shows the new level', () => {
  assert.equal(view('off', true, 'full').waiting, true)
  assert.equal(view('full', true, 'full').waiting, false)
  assert.equal(view('off', true).waiting, false)
})
