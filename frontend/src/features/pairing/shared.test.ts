import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sharer } from './shared.ts'

const IDLE = 20
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stub() {
  const opened: { closed: boolean; pc: { connectionState: string } }[] = []
  let fail = false
  const open = async () => {
    if (fail) throw new Error('not paired')
    const s = {
      closed: false,
      pc: { connectionState: 'connected' },
      close: () => (s.closed = true),
    }
    opened.push(s)
    return s
  }
  return { opened, open, failNext: (f: boolean) => (fail = f) }
}

test('users share one session; it closes only after the idle delay', async () => {
  const st = stub()
  const { share } = sharer(st.open, () => null, IDLE)
  const a = share('g')
  const b = share('g')
  assert.equal(await a.session, await b.session)
  a.release()
  a.release() // idempotent: b still holds it
  b.release()
  await wait(IDLE / 2)
  assert.equal(st.opened[0].closed, false)
  await wait(IDLE)
  assert.equal(st.opened[0].closed, true)
  await share('g').session
  assert.equal(st.opened.length, 2) // closed → fresh one
})

test('a new user within the idle delay cancels the close', async () => {
  const st = stub()
  const { share } = sharer(st.open, () => null, IDLE)
  share('g').release()
  await wait(IDLE / 2)
  const c = share('g')
  await wait(IDLE)
  assert.equal(st.opened.length, 1)
  assert.equal(st.opened[0].closed, false)
  c.release()
})

test('a failed connect is not cached', async () => {
  const st = stub()
  const { share } = sharer(st.open, () => null, IDLE)
  st.failNext(true)
  const a = share('g')
  await assert.rejects(a.session, /not paired/)
  a.release()
  st.failNext(false)
  await share('g').session
  assert.equal(st.opened.length, 1)
})

test('a dropped session, changed policy or re-pair is evicted for the next user', async () => {
  const st = stub()
  let relay = false
  const { share, drop } = sharer(st.open, () => relay, IDLE)
  const a = share('g')
  const s1 = await a.session
  s1.pc.connectionState = 'failed'
  const b = share('g')
  assert.notEqual(await b.session, s1)
  a.release() // evicted with no users left: closed at once
  await wait(0)
  assert.equal(st.opened[0].closed, true)
  relay = true
  const c = share('g')
  assert.notEqual(await c.session, await b.session)
  assert.equal(st.opened[1].closed, false) // b still holds it
  b.release()
  await wait(0)
  assert.equal(st.opened[1].closed, true)
  c.release()
  drop('g') // re-paired: idle session closed at once, next user gets a new one
  await wait(0)
  assert.equal(st.opened[2].closed, true)
  await share('g').session
  assert.equal(st.opened.length, 4)
})

test('a session closed by the broker is evicted before its pc says so', async () => {
  const st = stub()
  const { share } = sharer(st.open, () => null, IDLE)
  const a = share('g')
  const s1 = await a.session
  s1.close() // broker closed it: connect() closes it; pc still 'connected' for now
  assert.notEqual(await share('g').session, s1)
})
