import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../shared/errors.ts'
import {
  activeFirst,
  canManage,
  clientRenameMessage,
  clientsMessage,
  clientsNote,
  detailsMessage,
  dotOf,
  gatewayName,
  profileLine,
  removeOutcome,
  shownError,
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

test("a Remove that works clears an earlier failed one's line (#637)", () => {
  assert.deepEqual(removeOutcome(null, false), { done: 'row', msg: null })
  assert.deepEqual(removeOutcome(null, true), { done: 'self', msg: null })
  // 404: removed elsewhere: another client's row goes, this browser's stays
  assert.deepEqual(removeOutcome(e(404), false), { done: 'row', msg: null })
  assert.deepEqual(removeOutcome(e(404), true), { done: 'kept', msg: null })
  assert.deepEqual(removeOutcome(e(500), false), {
    done: null,
    msg: clientsMessage(e(500)),
  })
  assert.equal(
    removeOutcome(new AppError('not-paired', 'x'), true).msg,
    'Pair this browser to see them.',
  )
})

test('gatewayName: "gateway" before it has a name', () => {
  assert.equal(gatewayName({ name: 'NAS' }), 'NAS')
  assert.equal(gatewayName({ name: null }), 'gateway')
})

test('profileLine: the probe, Compatible mode, when; none yet', () => {
  assert.equal(profileLine(null), 'Not probed yet')
  const at = '2026-11-22T10:00:00Z'
  assert.equal(
    profileLine({
      probe: {
        h264: { profiles: ['high', 'main'], level: 51 },
        hevc: { level: 153, main10: true, hd: true },
        av1: null,
        audio: ['aac', 'ac3'],
        surround: true,
      },
      compatible: true,
      probedAt: at,
    }),
    `h264 high/main L5.1 · hevc L5.1 10bit ≤1080p · av1 no · audio aac,ac3 · 5.1 · Compatible mode · probed ${new Date(at).toLocaleString()}`,
  )
})

test('dotOf: required, then offline, then update, then online', () => {
  const g = { online: true, update: null, upgradeRequired: false }
  assert.equal(dotOf(g), 'online')
  assert.equal(dotOf({ ...g, update: '1.2.0' }), 'update')
  assert.equal(dotOf({ ...g, online: false, update: '1.2.0' }), 'offline')
  assert.equal(
    dotOf({ ...g, online: false, update: '1.2.0', upgradeRequired: true }),
    'required',
  )
})

test('activeFirst: the active one leads, the rest keep their order', () => {
  const gs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(
    activeFirst(gs, 'b').map((g) => g.id),
    ['b', 'a', 'c'],
  )
  assert.deepEqual(
    activeFirst(gs, null).map((g) => g.id),
    ['a', 'b', 'c'],
  )
})
