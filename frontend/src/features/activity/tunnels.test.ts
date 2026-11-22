import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  byGateway,
  byUse,
  data,
  duration,
  gatewaysIn,
  route,
  use,
  type TunnelRow,
} from './tunnels.ts'

const row = (o: Partial<TunnelRow> = {}): TunnelRow => ({
  id: 'x',
  createdAt: '2026-11-20T10:00:00Z',
  endedAt: '2026-11-20T10:05:00Z',
  gatewayId: 'g1',
  gatewayName: 'nas',
  relay: false,
  ipv6: false,
  bytesSent: 0,
  bytesReceived: 0,
  throughputKbps: null,
  failure: null,
  use: 'playback',
  activeMs: null,
  ...o,
})

test('route: direct, relayed, IPv6, no report yet', () => {
  assert.equal(route(row()), 'Direct')
  assert.equal(route(row({ relay: true, ipv6: true })), 'Relayed · IPv6')
  assert.equal(route(row({ bytesSent: null })), 'Unknown')
})

test('route: failure reasons in plain words, unknown ones as is', () => {
  assert.equal(
    route(row({ failure: 'ice failed' })),
    "Failed: Couldn't connect: the network blocked it",
  )
  assert.equal(
    route(row({ failure: 'unpaired' })),
    "Failed: This browser isn't paired",
  )
  assert.equal(
    route(row({ failure: 'ended before auth' })),
    'Failed: Closed before it connected',
  )
  assert.equal(
    route(row({ failure: 'gateway busy' })),
    'Failed: The gateway was busy',
  )
  assert.equal(
    route(row({ failure: 'not authenticated within 30s' })),
    'Failed: Closed: no sign-in in time',
  )
  assert.equal(route(row({ failure: 'boom' })), 'Failed: boom')
})

test('still open: Ongoing; no report: no data', () => {
  assert.equal(duration(row({ endedAt: null })), 'Ongoing')
  assert.equal(data(row({ bytesSent: null })), '—')
})

test('the filter lists each gateway once, a nameless one too', () => {
  const rows = [row(), row({ gatewayId: 'g2', gatewayName: null }), row()]
  assert.deepEqual(gatewaysIn(rows), [
    { id: 'g1', name: 'nas' },
    { id: 'g2', name: 'Unnamed gateway' },
  ])
})

test('the filter: one gateway, or all', () => {
  const rows = [row(), row({ id: 'y', gatewayId: 'g2' })]
  assert.deepEqual(
    byGateway(rows, 'g2').map((t) => t.id),
    ['y'],
  )
  assert.equal(byGateway(rows, ''), rows)
})

test('a value that rounds up to the next unit is shown in it', () => {
  const at = (s: number) =>
    row({
      endedAt: new Date(
        Date.parse('2026-11-20T10:00:00Z') + s * 1000,
      ).toISOString(),
    })
  assert.doesNotMatch(duration(at(59.7)), /60/)
  assert.doesNotMatch(duration(at(3599)), /60/)
  assert.doesNotMatch(
    data(row({ bytesSent: 999_960, bytesReceived: 0 })),
    /1[,.]?000/,
  )
})

test('use: each known word, an unknown one as is, none', () => {
  assert.equal(use(row()), 'Playback')
  assert.equal(use(row({ use: 'browsing' })), 'Browsing')
  assert.equal(use(row({ use: 'diagnostics' })), 'Diagnostics')
  assert.equal(use(row({ use: 'management' })), 'Management')
  assert.equal(use(row({ use: 'casting' })), 'casting')
  assert.equal(use(row({ use: null })), '—')
})

test('duration: the active time when reported, else end − start', () => {
  const f = (u: string, n: number, max = 0) =>
    new Intl.NumberFormat(undefined, {
      style: 'unit',
      unit: u,
      unitDisplay: 'short',
      maximumFractionDigits: max,
    }).format(n)
  assert.equal(duration(row()), f('minute', 5))
  assert.equal(duration(row({ activeMs: 120_000 })), f('minute', 2))
  assert.equal(
    duration(row({ endedAt: null, activeMs: 120_000 })),
    f('minute', 2),
  )
  assert.equal(duration(row({ activeMs: 400 })), f('millisecond', 400))
  assert.equal(duration(row({ activeMs: 999.7 })), f('second', 1))
  assert.equal(duration(row({ activeMs: 2_340 })), f('second', 2.3, 1))
  assert.equal(duration(row({ activeMs: 42_300 })), f('second', 42))
  assert.equal(
    duration(row({ activeMs: 400_000 })),
    `${f('minute', 6)} ${f('second', 40)}`,
  )
  assert.equal(
    duration(row({ activeMs: 3_900_000 })),
    `${f('hour', 1)} ${f('minute', 5)}`,
  )
})

test('management and diagnostics rows hide unless failed or shown', () => {
  const rows = [
    row({ id: 'play' }),
    row({ id: 'mgmt', use: 'management' }),
    row({ id: 'diag', use: 'diagnostics' }),
    row({ id: 'failed', use: 'management', failure: 'ice failed' }),
    row({ id: 'new', use: 'casting' }),
    row({ id: 'none', use: null }),
  ]
  const ids = (r: typeof rows) => r.map((t) => t.id)
  assert.deepEqual(ids(byUse(rows, false)), ['play', 'failed', 'new', 'none'])
  assert.deepEqual(ids(byUse(rows, true)), ids(rows))
})
