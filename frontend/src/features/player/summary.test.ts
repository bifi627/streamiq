import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frames, lag, line, played, send } from './summary.ts'
import type { Playback } from '../../generated/tunnel'

test('played: forward media time, at most the wall time', () => {
  assert.equal(played(1, 1), 1)
  assert.equal(played(0, 1), 0) // paused (the tracker passes 0) or stuck
  assert.equal(played(60, 1), 1) // a seek forward
  assert.equal(played(-30, 1), 0) // a seek back
  assert.equal(played(0.4, 1.2), 0.4) // a stall: the picture waited
})

test('lag: how late the 1 s timer fired; none while hidden', () => {
  assert.equal(lag(1000, false), 0)
  assert.equal(lag(990, false), 0)
  assert.equal(lag(1840, false), 840)
  assert.equal(lag(5000, true), 0)
})

test('frames: a reload restarting the counters keeps the earlier ones', () => {
  const f = { base: { dropped: 0, total: 0 }, last: { dropped: 0, total: 0 } }
  assert.deepEqual(frames(f, { dropped: 2, total: 100 }), {
    dropped: 2,
    total: 100,
  })
  assert.deepEqual(frames(f, { dropped: 3, total: 200 }), {
    dropped: 3,
    total: 200,
  })
  assert.deepEqual(frames(f, { dropped: 0, total: 10 }), {
    dropped: 3,
    total: 210,
  })
  assert.deepEqual(frames(f, { dropped: 1, total: 50 }), {
    dropped: 4,
    total: 250,
  })
})

const p: Playback = {
  itemId: 'it',
  codec: 'hevc',
  width: 1920,
  height: 1080,
  quality: 'Source',
  remux: true,
  playedSec: 720,
  droppedFrames: 312,
  totalFrames: 43210,
  worstStallMs: 840,
  waits: 3,
}

test('line: plain words', () => {
  // The browser's locale: units and separators as Intl writes them.
  const n = (x: number) => x.toLocaleString()
  const u = (unit: string, x: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
    }).format(x)
  assert.equal(
    line(p),
    `hevc 1920×1080 · Source · remux · ${u('minute', 12)} · 312 of ${n(43210)} frames dropped · worst stall ${u('millisecond', 840)} · 3 waits`,
  )
  assert.equal(
    line({ ...p, remux: false, playedSec: 20, waits: 1, codec: '' }),
    `? 1920×1080 · Source · transcode · ${u('second', 20)} · 312 of ${n(43210)} frames dropped · worst stall ${u('millisecond', 840)} · 1 wait`,
  )
})

test('send: a failed report (an older gateway) is one log line, never a rejection', async () => {
  const logs: string[] = []
  await send(
    p,
    () => Promise.reject(new Error('HTTP 404')),
    (m) => logs.push(m),
  )
  assert.deepEqual(logs, ['playback: summary not stored: Error: HTTP 404'])
  const sent: Playback[] = []
  await send(
    p,
    async (b) => void sent.push(b),
    (m) => logs.push(m),
  )
  assert.deepEqual([sent, logs.length], [[p], 1])
})
