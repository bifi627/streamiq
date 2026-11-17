import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairInfo } from './stats.ts'

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
