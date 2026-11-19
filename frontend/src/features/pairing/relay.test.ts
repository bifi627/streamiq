import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTurn, relayLine } from './relay.ts'

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

test('relayLine', () => {
  assert.equal(relayLine(true), 'relay: available')
  assert.equal(
    relayLine(false),
    'relay: unavailable (no TURN server from the broker)',
  )
})
