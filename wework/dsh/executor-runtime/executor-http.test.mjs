import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ExecutorRuntimeError } from './executor-runtime-client.js'
import { handleExecutorEvents } from './index.js'

test('returns event history overflow before opening the SSE stream', async () => {
  const request = executorEventRequest()
  const response = responseFixture()
  const client = {
    replay() {
      throw new ExecutorRuntimeError(
        'event_history_lost',
        'Requested executor event history is no longer buffered',
        true
      )
    },
  }

  await handleExecutorEvents(request, response, client)

  assert.equal(response.status, 409)
  assert.equal(JSON.parse(response.body).error.code, 'event_history_lost')
})

test('disconnects an SSE slow consumer instead of buffering indefinitely', async () => {
  const request = executorEventRequest()
  const response = responseFixture({ writable: false })
  let listened = false
  const replay = [1, 2, 3].map(sequence => ({
    protocolVersion: 1,
    sequence,
    emittedAt: new Date().toISOString(),
    event: 'task.updated',
    payload: { id: `task-${sequence}` },
  }))
  const client = {
    replay() {
      return replay
    },
    listen() {
      listened = true
      return () => {}
    },
  }

  await handleExecutorEvents(request, response, client)

  assert.equal(response.status, 200)
  assert.equal(response.writableEnded, true)
  assert.equal(listened, false)
  assert.match(response.body, /id: 1/)
  assert.doesNotMatch(response.body, /id: 2/)
  assert.doesNotMatch(response.body, /id: 3/)
})

function executorEventRequest() {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/wework/executor/v1/events'
  request.headers = {}
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

function responseFixture(options = {}) {
  const response = new EventEmitter()
  response.status = null
  response.headers = null
  response.body = ''
  response.headersSent = false
  response.destroyed = false
  response.writableEnded = false
  response.writeHead = function (status, headers) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  }
  response.write = function (body) {
    this.body += body
    return options.writable !== false
  }
  response.end = function (body = '') {
    this.body += body
    this.writableEnded = true
  }
  return response
}
