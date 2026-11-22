// Run: node --test src/features/screen/serial.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serial } from './serial.ts'

// A fake run: records what started and hands back control of each promise.
function fake() {
  const started: string[] = []
  const pending: { resolve: () => void; reject: () => void }[] = []
  const run = (x: string) => {
    started.push(x)
    return new Promise<void>((resolve, reject) =>
      pending.push({ resolve, reject: () => reject(new Error(x)) }),
    )
  }
  return { started, pending, run }
}
const tick = () => new Promise((r) => setTimeout(r))

test('runs one at a time, in order', async () => {
  const f = fake()
  const push = serial(f.run, () => false)
  push('a')
  push('b')
  push('c')
  assert.deepEqual(f.started, ['a'])
  f.pending[0].resolve()
  await tick()
  assert.deepEqual(f.started, ['a', 'b'])
  f.pending[1].resolve()
  await tick()
  assert.deepEqual(f.started, ['a', 'b', 'c'])
})

test('a new item replaces the queued last one, never the one in flight', async () => {
  const f = fake()
  const push = serial(f.run, () => true)
  push('a') // in flight
  push('b')
  push('c') // replaces b
  assert.deepEqual(f.started, ['a'])
  f.pending[0].resolve()
  await tick()
  assert.deepEqual(f.started, ['a', 'c'])
  f.pending[1].resolve()
  await tick()
  assert.deepEqual(f.started, ['a', 'c'])
})

test('replaces sees the queued item and the new one; false keeps both', async () => {
  const f = fake()
  const seen: string[][] = []
  const push = serial(f.run, (q, x) => {
    seen.push([q, x])
    return q.startsWith('seek') && x.startsWith('seek')
  })
  push('seek1') // in flight: nothing queued, replaces not asked
  push('pause')
  push('seek2') // after pause: kept
  push('seek3') // replaces seek2
  assert.deepEqual(seen, [
    ['pause', 'seek2'],
    ['seek2', 'seek3'],
  ])
  for (let i = 0; i < 3; i++) {
    f.pending[i].resolve()
    await tick()
  }
  assert.deepEqual(f.started, ['seek1', 'pause', 'seek3'])
})

test('a rejected run does not stall the queue', async () => {
  const f = fake()
  const push = serial(f.run, () => false)
  push('a')
  push('b')
  f.pending[0].reject()
  await tick()
  assert.deepEqual(f.started, ['a', 'b'])
})

test('idles when empty and restarts on the next item', async () => {
  const f = fake()
  const push = serial(f.run, () => true)
  push('a')
  f.pending[0].resolve()
  await tick()
  push('b') // queue empty, not busy: runs at once
  assert.deepEqual(f.started, ['a', 'b'])
})
