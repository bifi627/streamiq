import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authMessage } from './authErrors.ts'

const fb = (code: string) =>
  Object.assign(new Error(`Firebase: Error (${code}).`), { code })

test('wrong password, unknown user: one line for all three codes', () => {
  for (const c of [
    'auth/invalid-credential',
    'auth/wrong-password',
    'auth/user-not-found',
  ])
    assert.equal(authMessage(fb(c)), 'Wrong email or password.')
})

test('never Firebase text, also for unmapped codes and non-Firebase errors', () => {
  for (const e of [
    fb('auth/email-already-in-use'),
    fb('auth/missing-password'),
    fb('auth/weak-password'),
    fb('auth/internal-error'),
    new Error('Firebase: boom'),
    null,
  ])
    assert.doesNotMatch(authMessage(e), /Firebase/)
  assert.equal(
    authMessage(fb('auth/internal-error')),
    'Sign-in failed (auth/internal-error). Try again.',
  )
})
