import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../shared/errors.ts'
import {
  currentLine,
  decideMessage,
  nextRequestsAsk,
  requesterLine,
  requestsView,
} from './requests.ts'

const e = (status?: number) => new AppError('http', 'x → HTTP', { status })
const r = { id: 'i', name: 'Pixel', code: '123456', user: 'u1', expires: '' }

test('a gateway older than remote approval (404) hides the section (#956)', () => {
  assert.equal(requestsView(undefined, e(404)), 'hidden')
  assert.equal(nextRequestsAsk(true), false)
})

test('no requests: hidden; requests: shown; another error: its line', () => {
  assert.equal(requestsView(undefined, null), 'hidden')
  assert.equal(requestsView([], null), 'hidden')
  assert.deepEqual(requestsView([r], null), [r])
  assert.ok('msg' in (requestsView(undefined, e(500)) as object))
  assert.equal(nextRequestsAsk(false), 5_000)
})

test('the requester: the member name when known, then the browser name', () => {
  assert.equal(requesterLine(r, new Map([['u1', 'Alex']])), 'Alex · Pixel')
  assert.equal(requesterLine(r, new Map()), 'Pixel')
  assert.equal(requesterLine(r, undefined), 'Pixel')
})

test('a decide 404 that emptied the list still shows its line, until the next poll', () => {
  const line = currentLine({ text: decideMessage(e(404)), at: 5 }, 5)
  assert.deepEqual(requestsView([], null, line), [])
  assert.equal(currentLine({ text: 'x', at: 5 }, 6), null) // a poll landed since
  assert.equal(requestsView([], null, null), 'hidden')
})

test('a decide 404 says the request ended', () => {
  assert.match(decideMessage(e(404)), /ended/)
})
