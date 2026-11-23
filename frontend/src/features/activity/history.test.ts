import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askable, merge } from './history.ts'
import type { Gateway } from '../../generated/gateways'
import type { Tunnel } from '../../generated/history'

const gw = (id: string, name: string | null = id) =>
  ({ id, name, online: true }) as Gateway
const line = (id: string, createdAt: string, userId?: string): Tunnel => ({
  id,
  createdAt,
  endedAt: createdAt,
  userId: userId ?? null,
  relay: false,
  ipv6: false,
  bytesSent: 0,
  bytesReceived: 0,
  throughputKbps: null,
  failure: null,
  use: 'playback',
  activeMs: null,
})
const sum = (userId: string, n: number) => ({
  userId,
  tunnels: n,
  hidden: 1,
  failed: n - 1,
  relayedBytes: 10 * n,
})

test('only an online gateway this browser is paired with is asked', () => {
  assert.equal(askable(gw('a'), true), true)
  assert.equal(askable({ ...gw('a'), online: false }, true), false)
  assert.equal(askable(gw('a'), false), false)
})

test("the gateways' rows merge newest first, each with its gateway", () => {
  const h = merge([
    {
      gateway: gw('g1', 'nas'),
      tunnels: [line('a', '2026-11-20T10:00:00Z', 'u1')],
    },
    {
      gateway: gw('g2', null),
      tunnels: [
        line('b', '2026-11-21T10:00:00Z'),
        line('c', '2026-11-19T10:00:00Z'),
      ],
    },
  ])
  assert.deepEqual(
    h.rows.map((r) => [r.id, r.gatewayId, r.gatewayName, r.userId]),
    [
      ['b', 'g2', null, undefined],
      ['a', 'g1', 'nas', 'u1'],
      ['c', 'g2', null, undefined],
    ],
  )
  assert.deepEqual(h.unavailable, [])
})

test('a gateway without history is named, not counted', () => {
  const h = merge([{ gateway: gw('g1', 'nas') }, { gateway: gw('g2', null) }])
  assert.deepEqual(h, {
    rows: [],
    summary: [],
    unavailable: [
      { id: 'g1', name: 'nas' },
      { id: 'g2', name: 'gateway' },
    ],
  })
})

test('the summaries add up per user, most tunnels first', () => {
  const h = merge([
    { gateway: gw('g1'), tunnels: [], summary: [sum('u1', 2), sum('u2', 1)] },
    { gateway: gw('g2'), tunnels: [], summary: [sum('u2', 3)] },
  ])
  assert.deepEqual(h.summary, [
    { userId: 'u2', tunnels: 4, hidden: 2, failed: 2, relayedBytes: 40 },
    sum('u1', 2),
  ])
})
