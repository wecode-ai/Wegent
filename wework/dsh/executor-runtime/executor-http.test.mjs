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
  const client = {
    replay() {
      return [
        {
          protocolVersion: 1,
          sequence: 1,
          emittedAt: new Date().toISOString(),
          event: 'task.updated',
          payload: { id: 'task-1' },
        },
      ]
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
})

test('stops replaying events after disconnecting an SSE slow consumer', async () => {
  const request = executorEventRequest()
  const response = responseFixture({ writable: false, throwAfterEnd: true })
  const client = {
    replay() {
      return [executorEvent(1), executorEvent(2)]
    },
    listen() {
      assert.fail('slow replay consumers must not subscribe to live events')
    },
  }

  await handleExecutorEvents(request, response, client)

  assert.equal(response.writes, 1)
  assert.equal(response.writableEnded, true)
})

test('ignores queued live events after disconnecting an SSE slow consumer', async () => {
  const request = executorEventRequest()
  const response = responseFixture({ writableSequence: [true, false], throwAfterEnd: true })
  let listener
  let disposeCalls = 0
  const client = {
    replay() {
      return []
    },
    listen(nextListener) {
      listener = nextListener
      return () => {
        disposeCalls += 1
      }
    },
  }

  await handleExecutorEvents(request, response, client)
  listener(executorEvent(1))
  listener(executorEvent(2))

  assert.equal(response.writes, 2)
  assert.equal(response.writableEnded, true)
  assert.equal(disposeCalls, 1)
})

function executorEventRequest() {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/wework/executor/v1/events'
  request.headers = {}
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

function executorEvent(sequence) {
  return {
    protocolVersion: 1,
    sequence,
    emittedAt: new Date().toISOString(),
    event: 'task.updated',
    payload: { id: `task-${sequence}` },
  }
}

function responseFixture(options = {}) {
  return {
    status: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writes: 0,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    write(body) {
      if (options.throwAfterEnd && this.writableEnded) {
        throw new Error('write after end')
      }
      const writable = options.writableSequence?.[this.writes] ?? options.writable !== false
      this.writes += 1
      this.body += body
      return writable
    },
    end(body = '') {
      this.body += body
      this.writableEnded = true
    },
  }
}
