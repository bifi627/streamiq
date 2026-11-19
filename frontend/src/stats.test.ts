import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairInfo, pathLine } from './stats.ts'

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
      ipv6: true,
      local: 'relay',
      remote: 'host',
      protocol: 'udp',
      relayProtocol: undefined,
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

test('relay seen only on the remote side; stats in any order; no RTT yet', () => {
  const r = new Map<string, Record<string, any>>([
    [
      'P',
      {
        type: 'candidate-pair',
        id: 'P',
        localCandidateId: 'L',
        remoteCandidateId: 'R',
      },
    ],
    ['L', { candidateType: 'srflx', ip: '2001:db8::7', protocol: 'udp' }],
    ['R', { candidateType: 'relay', address: '192.0.2.1' }],
    ['T', { type: 'transport', selectedCandidatePairId: 'P' }],
  ])
  assert.deepEqual(pairInfo(r), {
    relay: true,
    ipv6: true, // from `ip` when there's no `address`
    local: 'srflx',
    remote: 'relay',
    protocol: 'udp',
    relayProtocol: undefined,
    bytesReceived: 0,
    bytesSent: 0,
    rttMs: undefined,
  })
})

test('path line: relay transport named, direct unchanged, no pair', () => {
  const tls = report({ currentRoundTripTime: 0.05 }, 'relay')
  tls.set('L', { ...tls.get('L')!, relayProtocol: 'tls' })
  assert.equal(
    pathLine(pairInfo(tls)),
    'path: relayed (TURN) over tls · IPv6 · udp · relay → host · RTT 50 ms',
  )
  assert.match(pathLine(pairInfo(report({}, 'relay'))), /over \? · /)
  assert.match(pathLine(pairInfo(report({}, 'host'))), /^path: direct · /)
  assert.equal(pathLine(null), 'path: no selected candidate pair')
})
