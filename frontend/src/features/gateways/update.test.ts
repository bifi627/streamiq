import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updated, updateState } from './update.ts'

test('a remote update is done once online on another version (#312)', () => {
  const u = { to: '1.5.0', from: '1.4.0' }
  assert.equal(updated(u, { online: false, version: '1.4.0' }), false) // going down
  assert.equal(updated(u, { online: true, version: '1.4.0' }), false) // not swapped (yet)
  assert.equal(updated(u, { online: false, version: '1.5.0' }), false) // offline on the new one
  assert.equal(updated(u, { online: true, version: '1.5.0' }), true)
  assert.equal(updated(u, { online: true, version: '1.6.0' }), true) // a newer release than named
})

// An admin's paired browser, offered 1.5.0 while on 1.4.0, the status not asked yet.
const base = {
  started: null,
  late: false,
  online: true,
  version: '1.4.0',
  update: '1.5.0' as string | null,
  canUpdate: true,
  remote: null as true | string | null,
}
const started = { to: '1.5.0', from: '1.4.0' }

test('updateState: a started update before UPDATE_WAIT is updating (#537)', () => {
  assert.equal(updateState({ ...base, started }), 'updating')
  assert.equal(updateState({ ...base, started, online: false }), 'updating')
})

test('updateState: after UPDATE_WAIT, online on the old version = not happened, retry (#564)', () => {
  assert.equal(updateState({ ...base, started, late: true }), 'retry')
  assert.equal(
    updateState({ ...base, started, late: true, remote: true }),
    'retry',
  )
  assert.equal(
    updateState({ ...base, started, late: true, canUpdate: false }),
    'notHappened',
  )
})

test('updateState: after UPDATE_WAIT, offline = not finished', () => {
  assert.equal(
    updateState({ ...base, started, late: true, online: false }),
    'notFinished',
  )
})

test('updateState: a done update is no update notice, back to the offer', () => {
  for (const version of ['1.5.0', '1.6.0']) {
    const g = { ...base, started, late: true, version, remote: true as const }
    assert.equal(updateState({ ...g, update: null }), null)
    assert.equal(updateState({ ...g, update: '1.7.0' }), 'button')
  }
})

test('updateState: no offered update = no notice', () => {
  assert.equal(updateState({ ...base, update: null, remote: true }), null)
})

test('updateState: can update + remote yes = the button', () => {
  assert.equal(updateState({ ...base, remote: true }), 'button')
})

test('updateState: can update + a reason = the reason', () => {
  assert.equal(updateState({ ...base, remote: 'no logon task' }), 'reason')
})

test("updateState: can't update or remote unknown = by hand", () => {
  // canUpdate is false when not admin, offline or not paired
  assert.equal(
    updateState({ ...base, canUpdate: false, remote: true }),
    'byHand',
  )
  assert.equal(
    updateState({ ...base, canUpdate: false, remote: 'x' }),
    'byHand',
  )
  assert.equal(updateState({ ...base, remote: null }), 'byHand')
})
