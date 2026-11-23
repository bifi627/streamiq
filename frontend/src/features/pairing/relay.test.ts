import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTurn, relayLine, relayServers, tlsOnly } from './relay.ts'

const stun = { urls: 'stun:stun.l.google.com:19302' }

test('hasTurn: urls as a string or an array, turn: or turns:', () => {
  assert.equal(hasTurn([stun, { urls: 'turn:t.example:3478' }]), true)
  assert.equal(
    hasTurn([{ urls: ['stun:s.example', 'turns:t.example:5349'] }]),
    true,
  )
})

test('hasTurn: STUN only, empty or missing list = no relay', () => {
  assert.equal(hasTurn([stun, { urls: ['stun:a', 'stun:b'] }]), false)
  assert.equal(hasTurn([]), false)
  assert.equal(hasTurn(undefined), false)
})

const STUN_ONLY = [{ urls: 'stun:s:3478' }]

test('relayLine', () => {
  assert.equal(relayLine(''), 'relay: available')
  assert.equal(
    relayLine('no TURN server from the broker'),
    'relay: unavailable (no TURN server from the broker)',
  )
  assert.equal(
    relayLine(relayServers(STUN_ONLY, false, true).noTurn),
    'relay: off (this gateway allows direct connections only)',
  )
})

test('relayServers: TLS-only judges the filtered list (#576)', () => {
  const cf = [
    stun,
    { urls: ['turn:t:3478', 'turns:t:5349?transport=tcp'], username: 'u' },
  ]
  assert.deepEqual(relayServers(cf, false), { iceServers: cf, noTurn: '' })
  assert.deepEqual(relayServers(cf, true), {
    iceServers: [],
    noTurn: 'no TURN server on TLS 443 from the broker',
  })
  assert.equal(
    relayServers([stun], false).noTurn,
    'no TURN server from the broker',
  )
  assert.deepEqual(relayServers(undefined, true).iceServers, [])
})

test('tlsOnly: keeps only turns: URLs on 443, with their credentials', () => {
  assert.deepEqual(
    tlsOnly([
      { urls: 'stun:stun.example:3478' },
      {
        urls: [
          'turn:turn.example:3478?transport=udp',
          'turn:turn.example:443?transport=tcp',
          'turns:turn.example:5349?transport=tcp',
          'turns:turn.example:443?transport=tcp',
          'turns:turn.example:4430',
        ],
        username: 'u',
        credential: 'c',
      },
    ]),
    [
      {
        urls: ['turns:turn.example:443?transport=tcp'],
        username: 'u',
        credential: 'c',
      },
    ],
  )
})

test('tlsOnly: no turns: URL on 443 → no servers (no fallback)', () => {
  assert.deepEqual(
    tlsOnly([
      { urls: 'stun:s' },
      { urls: ['turn:t?transport=udp', 'turns:t:5349?transport=tcp'] },
    ]),
    [],
  )
  // port-less turns: means 5349, not 443
  assert.deepEqual(tlsOnly([{ urls: 'turns:t' }]), [])
  assert.deepEqual(tlsOnly([{ urls: 'turns:t:443' }]), [
    { urls: ['turns:t:443'] },
  ])
})
