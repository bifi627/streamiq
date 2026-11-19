import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tlsOnly } from './ice.ts'

test('keeps only turns: URLs on 443, with their credentials', () => {
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

test('no turns: URL on 443 → no servers (no fallback)', () => {
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
