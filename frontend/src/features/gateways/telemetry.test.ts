import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../errors.ts'
import { switchOutcome, telemetryView } from './telemetry.ts'

test('the line follows the last heartbeat; none without a level', () => {
  const v = (telemetry: 'off' | 'full' | null) =>
    telemetryView({ telemetry, manage: false, tooOld: false, pending: null })
      .label
  assert.equal(v('full'), 'on')
  assert.equal(v('off'), 'off')
  assert.equal(v(null), null)
})

test('a member, or an admin who cannot reach it, gets no control', () => {
  for (const telemetry of ['off', 'full', null] as const)
    for (const tooOld of [false, true])
      assert.equal(
        telemetryView({ telemetry, manage: false, tooOld, pending: null })
          .control,
        null,
      )
})

test('an admin who can reach it gets the switch', () => {
  assert.deepEqual(
    telemetryView({
      telemetry: 'off',
      manage: true,
      tooOld: false,
      pending: null,
    }),
    { label: 'off', control: 'switch', waiting: false },
  )
})

test('a gateway without a level or one that answered 404 gets the update text', () => {
  assert.deepEqual(
    telemetryView({
      telemetry: null,
      manage: true,
      tooOld: false,
      pending: null,
    }),
    { label: null, control: 'update', waiting: false },
  )
  assert.deepEqual(
    telemetryView({
      telemetry: 'full',
      manage: true,
      tooOld: true,
      pending: null,
    }),
    { label: 'on', control: 'update', waiting: false },
  )
})

test('a switch waits until a heartbeat shows the new level', () => {
  const v = (telemetry: 'off' | 'full', pending: 'off' | 'full' | null) =>
    telemetryView({ telemetry, manage: true, tooOld: false, pending }).waiting
  assert.equal(v('off', 'full'), true)
  assert.equal(v('full', 'full'), false)
  assert.equal(v('off', null), false)
})

test('404 = too old; any other failure is a message', () => {
  const e = (status: number) => new AppError('http', 'x', { status })
  assert.deepEqual(switchOutcome(e(404)), { tooOld: true })
  assert.ok('msg' in switchOutcome(e(500)))
})
