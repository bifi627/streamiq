import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairInfo, route } from './stats.ts'

const report = (pair: Record<string, unknown>, localType: string) =>
  new Map<string, Record<string, any>>([
    ['T', { type: 'transport', selectedCandidatePairId: 'P' }],
    [
      'X',
      {
        type: 'candidate-pair',
        id: 'X',
        localCandidateId: 'L',
        remoteCandidateId: 'R',
      },
    ],
    [
      'P',
      {
        type: 'candidate-pair',
        id: 'P',
        localCandidateId: 'L',
        remoteCandidateId: 'R',
        ...pair,
      },
    ],
    [
      'L',
      { candidateType: localType, address: '2001:db8::1', protocol: 'udp' },
    ],
    ['R', { candidateType: 'host', address: '192.0.2.1' }],
  ])

test('selected pair: relay, IPv6, bytes, RTT', () => {
  assert.deepEqual(
    pairInfo(
      report(
        { bytesReceived: 7, bytesSent: 3, currentRoundTripTime: 0.0234 },
        'relay',
      ),
    ),
    {
      relay: true,
      lan: false,
      ipv6: true,
      local: 'relay',
      remote: 'host',
      protocol: 'udp',
      bytesReceived: 7,
      bytesSent: 3,
      rttMs: 23,
    },
  )
  assert.equal(pairInfo(report({}, 'srflx'))!.relay, false)
  // Chrome: relayed but reported as prflx, flagged by relayProtocol.
  const chrome = report({}, 'prflx')
  chrome.set('L', { ...chrome.get('L')!, relayProtocol: 'udp' })
  assert.equal(pairInfo(chrome)!.relay, true)
})

test('Firefox shape (pair.selected) and no pair yet', () => {
  const ff = report({}, 'host')
  ff.delete('T')
  assert.equal(pairInfo(ff), null)
  ff.set('P', { ...ff.get('P')!, selected: true })
  assert.equal(pairInfo(ff)!.local, 'host')
})

test('badge route: private host/host → lan, srflx or prflx → direct, relay → relayed', () => {
  const lan = (l: string, r: string) => {
    const m = report({}, 'host')
    m.set('L', { candidateType: 'host', address: l })
    m.set('R', { candidateType: 'host', address: r })
    return route(pairInfo(m)!)
  }
  assert.equal(lan('0f1e2d3c-mdns.local', '192.168.1.5'), 'lan')
  assert.equal(lan('10.0.0.2', '172.20.0.3'), 'lan')
  assert.equal(lan('fd00::2', 'fe80::1'), 'lan')
  // Global IPv6 on one /64 = one link (a home with IPv6).
  assert.equal(
    lan('2a02:8070:998a:2a40::1', '2a02:8070:998a:2a40:7d0b:b01d:189f:e5bc'),
    'lan',
  )
  assert.equal(
    lan('2a02:8070:998a:2a40::1', '2a02:8070:998a:2a41::1'),
    'direct',
  )
  // Public host candidates (global IPv6 over cellular, public IPv4): not the LAN.
  assert.equal(route(pairInfo(report({}, 'host'))!), 'direct')
  assert.equal(lan('2a01:598::1', '2003:e0::1'), 'direct')
  assert.equal(lan('192.168.1.9', '172.32.0.1'), 'direct')
  assert.equal(route(pairInfo(report({}, 'srflx'))!), 'direct')
  assert.equal(route(pairInfo(report({}, 'prflx'))!), 'direct')
  assert.equal(route(pairInfo(report({}, 'relay'))!), 'relay')
  const hairpin = report({}, 'host')
  hairpin.set('R', { candidateType: 'srflx', address: '192.0.2.1' })
  assert.equal(route(pairInfo(hairpin)!), 'direct')
})
