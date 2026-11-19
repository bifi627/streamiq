import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanEmail } from './email.ts'

test('autocomplete whitespace around the email is dropped', () => {
  assert.equal(cleanEmail(' a@b.c \t\n'), 'a@b.c')
  assert.equal(cleanEmail('a@b.c'), 'a@b.c')
})
