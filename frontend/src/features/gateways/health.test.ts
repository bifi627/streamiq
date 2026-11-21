import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dailyPeaks,
  incidents,
  span,
  versionChanges,
  WINDOW_MS,
  type HealthRow,
} from './health.ts'

const now = new Date(2026, 10, 21, 12, 0).getTime() // local noon
const MIN = 60_000

const row = (minAgo: number, x: Partial<HealthRow> = {}): HealthRow => ({
  at: new Date(now - minAgo * MIN).toISOString(),
  jellyfinReachable: true,
  jellyfinVersion: '10.11.2',
  gatewayVersion: '1.4.0',
  tunnels: 0,
  transcodes: 0,
  cpu: 10,
  memory: 40,
  ...x,
})
const ago = (min: number) => now - min * MIN

test('Jellyfin down from the first unreachable row to the next reachable one', () => {
  const rows = [
    row(30),
    row(25, { jellyfinReachable: false }),
    row(20, { jellyfinReachable: false }),
    row(15),
    row(10),
    row(5),
  ]
  assert.deepEqual(incidents(rows, now), [
    { kind: 'jellyfin', from: ago(25), to: ago(15) },
  ])
})

test('one still going on has no end', () => {
  const rows = [row(10), row(5, { jellyfinReachable: false })]
  assert.deepEqual(incidents(rows, now), [
    { kind: 'jellyfin', from: ago(5), to: null },
  ])
})

test('a gap over 10 min is no data, and ends a Jellyfin incident at its last row', () => {
  const rows = [
    row(60, { jellyfinReachable: false }),
    row(55, { jellyfinReachable: false }),
    row(30, { jellyfinReachable: false }),
    row(25),
    row(15),
    row(5),
  ]
  assert.deepEqual(incidents(rows, now), [
    { kind: 'jellyfin', from: ago(30), to: ago(25) },
    { kind: 'gap', from: ago(55), to: ago(30) },
    { kind: 'jellyfin', from: ago(60), to: ago(55) },
  ])
})

test('exactly 10 min is no gap; from the last row until now is one', () => {
  assert.deepEqual(incidents([row(30), row(20)], now), [
    { kind: 'gap', from: ago(20), to: null },
  ])
  assert.deepEqual(incidents([row(20), row(10), row(5)], now), [])
})

test('the row before the window sets its start, clipped to it', () => {
  const start = now - WINDOW_MS
  const before = row(WINDOW_MS / MIN + 60, { jellyfinReachable: false })
  const first = row(WINDOW_MS / MIN - 1)
  assert.deepEqual(incidents([before, first, row(5)], now), [
    { kind: 'gap', from: ago(WINDOW_MS / MIN - 1), to: ago(5) },
    { kind: 'gap', from: start, to: Date.parse(first.at) },
  ])
  // Ended before the window: not shown. A row every 5 min up to now.
  const every5 = Array.from({ length: (WINDOW_MS / MIN + 10) / 5 }, (_, i) =>
    row(WINDOW_MS / MIN + 10 - i * 5, { jellyfinReachable: i > 0 }),
  )
  assert.deepEqual(incidents(every5, now), [])
})

test('versions: each change newest first, a null version is none', () => {
  const rows = [
    row(WINDOW_MS / MIN + 10, { jellyfinVersion: '10.10.0' }), // before the window
    row(50, { gatewayVersion: null }),
    row(40, { jellyfinVersion: null, gatewayVersion: '1.5.0' }),
    row(30, { jellyfinVersion: '10.11.3', gatewayVersion: '1.5.0' }),
  ]
  assert.deepEqual(versionChanges(rows, now), [
    { at: ago(30), what: 'Jellyfin', from: '10.11.2', to: '10.11.3' },
    { at: ago(40), what: 'Gateway', from: '1.4.0', to: '1.5.0' },
    { at: ago(50), what: 'Jellyfin', from: '10.10.0', to: '10.11.2' },
  ])
  assert.deepEqual(versionChanges([row(10), row(5)], now), [])
})

test('daily peaks: per local day, today first, a day without rows is empty', () => {
  const rows = [
    row(WINDOW_MS / MIN + 10, { tunnels: 99 }), // before the window
    row(13 * 60, { tunnels: 3, cpu: 80 }), // yesterday 23:00 local
    row(10 * 60, { tunnels: 1, cpu: 95.5, memory: null }), // today 02:00
    row(60, { tunnels: 2, transcodes: 1, cpu: 20, memory: 70 }),
  ]
  const days = dailyPeaks(rows, now)
  assert.equal(days.length, 8) // today + 7 back: the window starts at noon a week ago
  assert.deepEqual(days[0].day, new Date(2026, 10, 21))
  assert.deepEqual(
    { ...days[0], day: undefined },
    { day: undefined, tunnels: 2, transcodes: 1, cpu: 95.5, memory: 70 },
  )
  assert.deepEqual(
    { ...days[1], day: undefined },
    { day: undefined, tunnels: 3, transcodes: 0, cpu: 80, memory: 40 },
  )
  assert.deepEqual(
    { ...days[7], day: undefined },
    {
      day: undefined,
      tunnels: null,
      transcodes: null,
      cpu: null,
      memory: null,
    },
  )
})

test('span: minutes, hours, days', () => {
  assert.match(span(4 * MIN), /^4\D/)
  assert.match(span(125 * MIN), /^2\D.*5\D/)
  assert.match(span((3 * 24 + 4) * 60 * MIN), /^3\D.*4\D/)
})
