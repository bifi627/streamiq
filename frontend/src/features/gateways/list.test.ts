import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../errors.ts'
import {
  canManage,
  clientRenameMessage,
  clientsMessage,
  clientsNote,
  detailsMessage,
  shownError,
  withId,
} from './list.ts'

const e = (status?: number) => new AppError('http', 'x → HTTP', { status })

test('the load error wins; an action error lasts until the next poll', () => {
  const load = e(500)
  const act = { e: e(403), at: 7 }
  assert.equal(shownError(load, act, 7), load)
  assert.equal(shownError(null, act, 7), act.e)
  assert.equal(shownError(null, act, 8), null) // a poll landed since
  assert.equal(shownError(null, null, 7), null)
})

test('Rename / Update need admin, online and a pin (#329)', () => {
  assert.equal(canManage(true, true, true), true)
  assert.equal(canManage(false, true, true), false)
  assert.equal(canManage(true, false, true), false)
  assert.equal(canManage(true, true, false), false)
})

test('withId adds and drops without touching the input', () => {
  const s = new Set(['a'])
  assert.deepEqual([...withId(s, 'b', true)], ['a', 'b'])
  assert.deepEqual([...withId(s, 'a', false)], [])
  assert.deepEqual([...s], ['a'])
})

test('the Paired clients line: offline, then removed, then the error or loading', () => {
  const o = { online: true, unpaired: false, msg: null, loaded: false }
  assert.match(clientsNote({ ...o, online: false, unpaired: true })!, /offline/)
  assert.match(clientsNote({ ...o, unpaired: true, msg: 'm' })!, /removed/)
  assert.equal(clientsNote({ ...o, msg: 'm', loaded: true }), 'm')
  assert.equal(clientsNote(o), 'loading…')
  assert.equal(clientsNote({ ...o, loaded: true }), null)
})

test('client and status messages by error', () => {
  const np = new AppError('not-paired', 'x')
  assert.match(clientRenameMessage(e(404)), /update the gateway/)
  assert.match(clientRenameMessage(e(400)), /1–100/)
  assert.equal(clientsMessage(np), 'Pair this browser to see them.')
  assert.equal(detailsMessage(np), 'pair this browser to see them')
  assert.match(detailsMessage(e(404)), /too old/)
  assert.equal(detailsMessage(e(500)), 'unavailable (x → HTTP)')
})
