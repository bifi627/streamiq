import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, duration, gatewaysIn, route, type TunnelRow } from './tunnels.ts'

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
