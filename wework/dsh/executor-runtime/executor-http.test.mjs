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

test('coalesces bursty content snapshots before a terminal event', async () => {
  const request = executorEventRequest()
  const response = responseFixture()
  let listener
  const client = {
    replay() {
      return []
    },
    listen(nextListener) {
      listener = nextListener
      return () => {}
    },
  }

  await handleExecutorEvents(request, response, client)
  for (let index = 1; index <= 2200; index += 1) {
    listener(blockUpdate(index, 'x'.repeat(index)))
  }
  listener(executorEvent(2201, 'response.completed', { data: { value: 'complete' } }))

  const events = response.body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)))
  assert.equal(events.length, 2)
  assert.equal(events[0].sequence, 2200)
  assert.equal(events[0].payload.data.updates.content.length, 2200)
  assert.equal(events[1].event, 'response.completed')
})

test('does not coalesce additive block updates', async () => {
  const request = executorEventRequest()
  const response = responseFixture()
  const client = {
    replay() {
      return [
        executorEvent(1, 'response.block.updated', {
          data: {
            block_id: 'tool-1',
            updates: { tool_output_delta: 'first', status: 'streaming' },
          },
        }),
        executorEvent(2, 'response.block.updated', {
          data: {
            block_id: 'tool-1',
            updates: { tool_output_delta: 'second', status: 'streaming' },
          },
        }),
      ]
    },
    listen() {
      return () => {}
    },
  }

  await handleExecutorEvents(request, response, client)

  assert.equal(response.body.match(/^data: /gm)?.length, 2)
  assert.match(response.body, /first/)
  assert.match(response.body, /second/)
})

function executorEventRequest() {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/wework/executor/v1/events'
  request.headers = {}
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}

function blockUpdate(sequence, content) {
  return executorEvent(sequence, 'response.block.updated', {
    data: {
      block_id: 'process-1',
      updates: { content, status: 'streaming' },
    },
  })
}

function executorEvent(sequence, event, payload) {
  return {
    protocolVersion: 1,
    sequence,
    emittedAt: new Date().toISOString(),
    event,
    payload: {
      deviceId: 'local-device',
      taskId: 'task-1',
      subtaskId: 'subtask-1',
      ...payload,
    },
  }
}

function responseFixture(options = {}) {
  return {
    status: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    write(body) {
      this.body += body
      return options.writable !== false
    },
    end(body = '') {
      this.body += body
      this.writableEnded = true
    },
  }
}
