import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tlsOnly } from './ice.ts'

test('keeps only turns: URLs, with their credentials', () => {
  assert.deepEqual(
    tlsOnly([
      { urls: 'stun:stun.example:3478' },
      {
        urls: [
          'turn:turn.example:3478?transport=udp',
          'turns:turn.example:443?transport=tcp',
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

test('no turns: URL → no servers (no UDP fallback)', () => {
  assert.deepEqual(
    tlsOnly([{ urls: 'stun:s' }, { urls: ['turn:t?transport=udp'] }]),
    [],
  )
})
