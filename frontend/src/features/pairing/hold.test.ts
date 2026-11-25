import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRACE_MS, RETRY_MS, dropped, hold, retries } from './hold.ts'

const s = (connectionState: string, closed = false) => ({
  pc: { connectionState },
  closed,
})

test('dropped: failed or closed at once, disconnected only past the grace', () => {
  assert.equal(dropped(s('connected'), undefined, 0), false)
  assert.equal(dropped(s('failed'), undefined, 0), true)
  assert.equal(dropped(s('closed'), undefined, 0), true)
  assert.equal(dropped(s('connected', true), undefined, 0), true)
  assert.equal(dropped(s('disconnected'), 0, GRACE_MS - 1), false)
  assert.equal(dropped(s('disconnected'), 0, GRACE_MS), true)
})

test('retries only after a drop, within the window', () => {
  assert.equal(retries(undefined, 0), false)
  assert.equal(retries(0, RETRY_MS - 1), true)
  assert.equal(retries(0, RETRY_MS), false)
})

const never = () => assert.fail()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stub(fails: boolean[] = []) {
  const opened: ReturnType<typeof s>[] = []
  const released: number[] = []
  const share = () => {
    const n = opened.length + released.length
    const fail = fails.shift()
    const x = s('connected')
    if (!fail) opened.push(x)
    return {
      session: fail ? Promise.reject(new Error('no')) : Promise.resolve(x),
      release: () => released.push(n),
    }
  }
  return { share, opened, released }
}

const opts = (clock: { t: number }) => ({
  now: () => clock.t,
  poll: 2,
  pause: 2,
})

test('a disconnected that recovers within the grace keeps the session', async () => {
  const clock = { t: 0 }
  const { share, opened } = stub()
  const ups: unknown[] = []
  const stop = hold(
    'g',
    share,
    { up: (x) => ups.push(x), error: never, dropped: never },
    opts(clock),
  )
  await wait(50)
  opened[0].pc.connectionState = 'disconnected'
  await wait(50)
  clock.t = GRACE_MS - 1
  await wait(50)
  opened[0].pc.connectionState = 'connected'
  clock.t = GRACE_MS * 3
  await wait(50)
  stop()
  assert.equal(ups.length, 1)
})

test('a drop shares a new session; failed attempts retry within the window', async () => {
  const clock = { t: 0 }
  const { share, opened, released } = stub([false, true, true])
  const ups: unknown[] = []
  let drops = 0
  const stop = hold(
    'g',
    share,
    { up: (x) => ups.push(x), error: never, dropped: () => drops++ },
    opts(clock),
  )
  await wait(50)
  opened[0].pc.connectionState = 'failed'
  await wait(150)
  stop()
  assert.equal(drops, 1)
  assert.equal(ups.length, 2)
  assert.notEqual(ups[1], ups[0])
  assert.ok(released.includes(0)) // the dropped one is let go
})

test('past the window the drop ends in the error', async () => {
  const clock = { t: 0 }
  const { share, opened } = stub([false, true, true, true])
  const errors: unknown[] = []
  const stop = hold(
    'g',
    share,
    { up: () => 0, error: (e) => errors.push(e), dropped: () => 0 },
    opts(clock),
  )
  await wait(50)
  opened[0].closed = true
  await wait(5)
  clock.t = RETRY_MS
  await wait(150)
  stop()
  assert.equal(errors.length, 1)
})

test('the first connect failing is the error at once', async () => {
  const { share } = stub([true])
  const errors: unknown[] = []
  const stop = hold('g', share, {
    up: never,
    error: (e) => errors.push(e),
    dropped: never,
  })
  await wait(5)
  stop()
  assert.equal(errors.length, 1)
})
