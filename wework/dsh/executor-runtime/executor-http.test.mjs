import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { handleExecutorEvents } from './index.js'

test('passes the browser cursor to the executor-owned event stream', async () => {
  const request = executorEventRequest('?after=7')
  const response = responseFixture()
  let receivedAfter = null

  await handleExecutorEvents(request, response, options => {
    receivedAfter = options.afterSequence
    return eventStreamFixture(options, {
      events: [executorEvent(8), executorEvent(9, 'response.completed')],
    })
  })

  assert.equal(receivedAfter, 7)
  assert.match(response.body, /id: 8/)
  assert.match(response.body, /id: 9/)
})

test('disconnects an SSE slow consumer instead of opening an executor stream', async () => {
  const request = executorEventRequest()
  const response = responseFixture({ writable: false })
  let created = false

  await handleExecutorEvents(request, response, options => {
    created = true
    return eventStreamFixture(options)
  })

  assert.equal(response.status, 200)
  assert.equal(response.writableEnded, true)
  assert.equal(created, false)
})

test('stops the executor stream when a live SSE consumer applies backpressure', async () => {
  const request = executorEventRequest()
  const response = responseFixture({ writableSequence: [true, true, false] })
  let stopped = false

  await handleExecutorEvents(request, response, options =>
    eventStreamFixture(options, {
      events: [executorEvent(1), executorEvent(2)],
      onStop: () => {
        stopped = true
      },
    })
  )

  assert.equal(response.writableEnded, true)
  assert.equal(stopped, true)
  assert.match(response.body, /id: 1/)
  assert.match(response.body, /id: 2/)
})

test('forwards content snapshots without Electron-side coalescing', async () => {
  const request = executorEventRequest()
  const response = responseFixture()

  await handleExecutorEvents(request, response, options =>
    eventStreamFixture(options, {
      events: [
        blockUpdate(1, 'first'),
        blockUpdate(2, 'second'),
        executorEvent(3, 'response.completed'),
      ],
    })
  )

  const events = response.body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)))
  assert.deepEqual(
    events.map(event => event.sequence),
    [1, 2, 3]
  )
  assert.equal(events[0].payload.data.updates.content, 'first')
  assert.equal(events[1].payload.data.updates.content, 'second')
})

test('closes SSE when the executor event stream closes', async () => {
  const request = executorEventRequest()
  const response = responseFixture()

  await handleExecutorEvents(request, response, options =>
    eventStreamFixture(options, { closeAfterStart: true })
  )

  assert.equal(response.writableEnded, true)
})

function eventStreamFixture(options, config = {}) {
  return {
    async start() {
      for (const event of config.events ?? []) options.onEvent(event)
      if (config.closeAfterStart) options.onClose()
    },
    stop() {
      config.onStop?.()
    },
  }
}

function executorEventRequest(query = '') {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = `/wework/executor/v1/events${query}`
  request.headers = {}
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

function blockUpdate(sequence, content) {
  return executorEvent(sequence, 'response.block.updated', {
    deviceId: 'local-device',
    taskId: 'task-1',
    subtaskId: 'subtask-1',
    data: {
      block_id: 'process-1',
      updates: { content, status: 'streaming' },
    },
  })
}

function executorEvent(sequence, event = 'task.updated', payload = { id: `task-${sequence}` }) {
  return {
    type: 'event',
    protocolVersion: 1,
    sequence,
    emittedAt: new Date().toISOString(),
    event,
    payload,
  }
}

function responseFixture(options = {}) {
  const response = new EventEmitter()
  response.status = null
  response.headers = null
  response.body = ''
  response.headersSent = false
  response.destroyed = false
  response.writableEnded = false
  response.writes = 0
  response.writeHead = function (status, headers) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  }
  response.write = function (body) {
    const writable = options.writableSequence?.[this.writes] ?? options.writable !== false
    this.writes += 1
    this.body += body
    return writable
  }
  response.end = function (body = '') {
    this.body += body
    this.writableEnded = true
  }
  return response
}
