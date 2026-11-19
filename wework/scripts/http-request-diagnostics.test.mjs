import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { recordHttpRequest } from '../e2e/desktop/modules/http-request-diagnostics.mjs'

test('an interrupted HTTP request remains observed without inventing a completed response', () => {
  const response = new EventEmitter()
  response.writableFinished = false
  const requests = []
  const record = recordHttpRequest(
    { method: 'POST', headers: { authorization: 'private-header' }, body: 'private-body' },
    response,
    new URL('http://127.0.0.1/private-route?token=private-query'),
    requests
  )
  response.emit('close')
  assert.equal(requests.length, 1)
  assert.equal(record.aborted, true)
  assert.ok(record.closedAtUnixMs >= record.startedAtUnixMs)
  assert.equal(Object.hasOwn(record, 'status'), false)
  assert.equal(Object.hasOwn(record, 'durationMs'), false)
  assert.equal(Object.hasOwn(record, 'finishedAtUnixMs'), false)
  assert.doesNotMatch(JSON.stringify(record), /private-header|private-body|private-query/)
})

test('a finished HTTP request retains its status and is not reclassified on close', () => {
  const response = new EventEmitter()
  response.statusCode = 503
  const requests = []
  const record = recordHttpRequest(
    {},
    response,
    new URL('http://127.0.0.1/config/bundle'),
    requests,
    { service: 'subscription-configuration' }
  )
  response.writableFinished = true
  response.emit('finish')
  response.emit('close')
  assert.equal(record.method, 'UNKNOWN')
  assert.equal(record.status, 503)
  assert.equal(record.aborted, undefined)
  assert.ok(record.durationMs >= 0)
})
