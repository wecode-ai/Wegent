import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply, handleExecutorEvents, handleExecutorRpc } from './index.js'
import { ExecutorRuntimeClient, ExecutorRuntimeError } from './executor-runtime-client.js'

test('GET and HEAD describe use the negotiated identity without issuing another RPC', async t => {
  const description = {
    protocol_version: 1,
    device_id: 'stable-device',
    device_route_id: 'app-record-70',
    runtime_instance_id: 'runtime-1',
    renderer_methods: ['runtime.codex.models.list'],
  }
  let requests = 0
  const describe = await registeredDescribeHandler(t, {
    describe: () => description,
    request: async () => {
      requests++
      return { ...description, device_route_id: 'app-record-71' }
    },
  })

  for (const method of ['GET', 'HEAD']) {
    const request = executorEventRequest()
    request.method = method
    const response = responseFixture()

    await describe(request, response)

    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    if (method === 'GET') {
      assert.deepEqual(JSON.parse(response.body).executor, description)
    } else {
      assert.equal(response.body, '')
    }
  }
  assert.equal(requests, 0)
})

test('describe remains unavailable until the bridge has a negotiated method table', async t => {
  let ready = false
  let requests = 0
  const description = {
    protocol_version: 1,
    device_id: 'stable-device',
    runtime_instance_id: 'runtime-2',
    renderer_methods: ['runtime.codex.models.list'],
  }
  const describe = await registeredDescribeHandler(t, {
    describe: () => {
      if (!ready) throw new ExecutorRuntimeError('runtime_not_ready', 'Not negotiated', true)
      return description
    },
    request: async () => {
      requests++
      return description
    },
  })
  const unavailable = responseFixture()

  await describe(executorEventRequest(), unavailable)

  assert.equal(unavailable.status, 503)
  assert.equal(JSON.parse(unavailable.body).error.code, 'runtime_not_ready')
  assert.equal(JSON.parse(unavailable.body).error.retryable, true)
  ready = true
  const recovered = responseFixture()

  await describe(executorEventRequest(), recovered)

  assert.equal(recovered.status, 200)
  assert.deepEqual(JSON.parse(recovered.body).executor, description)
  assert.equal(requests, 0)
})

async function registeredDescribeHandler(t, client) {
  t.mock.method(ExecutorRuntimeClient, 'fromEnvironment', () => ({
    start: async () => {},
    ...client,
  }))
  const handlers = new Map()
  await apply({
    sessions: {},
    webServer: {
      register: ({ path, handler }) => handlers.set(path, handler),
    },
    effect: (callback, label) => {
      if (label.startsWith('wework-executor-runtime: /')) callback()
    },
  })
  return handlers.get('/wework/executor/v1')
}

test('preserves one request id across browser, DSH, and executor RPC', async () => {
  const request = executorRpcRequest(
    { id: 'wework-local-request-1', method: 'runtime.tasks.list', params: {} },
    { 'x-request-id': 'wework-local-request-1' }
  )
  const response = responseFixture()
  const client = {
    request: async (method, params, timeoutMs, requestId) => {
      assert.equal(method, 'runtime.tasks.list')
      assert.deepEqual(params, {})
      assert.equal(timeoutMs, undefined)
      assert.equal(requestId, 'wework-local-request-1')
      return { items: [] }
    },
  }

  await handleExecutorRpc(request, response, client)

  assert.equal(response.status, 200)
  assert.equal(response.headers['x-request-id'], 'wework-local-request-1')
  assert.deepEqual(JSON.parse(response.body), { ok: true, result: { items: [] } })
})

test('does not forward an unsafe browser request id to the executor', async () => {
  const request = executorRpcRequest({
    id: 'unsafe\nrequest-id',
    method: 'runtime.tasks.list',
    params: {},
  })
  const response = responseFixture()
  let receivedRequestId = null
  const client = {
    request: async (_method, _params, _timeoutMs, requestId) => {
      receivedRequestId = requestId
      return { items: [] }
    },
  }

  await handleExecutorRpc(request, response, client)

  assert.match(receivedRequestId, /^[0-9a-f-]{36}$/)
  assert.notEqual(receivedRequestId, 'unsafe\nrequest-id')
  assert.equal(response.headers['x-request-id'], receivedRequestId)
})

test('passes the browser cursor to the executor-owned event stream', async () => {
  const request = executorEventRequest('?after=7')
  const response = responseFixture()
  let receivedOptions = null

  await handleExecutorEvents(request, response, options => {
    receivedOptions = options
    return eventStreamFixture(options, {
      events: [executorEvent(8), executorEvent(9, 'response.completed')],
    })
  })

  assert.deepEqual(receivedOptions, {
    afterSequence: 7,
    replayExisting: true,
  })
  assert.doesNotMatch(response.body, /id:/)
  assert.match(response.body, /"sequence":8/)
  assert.match(response.body, /"sequence":9/)
})

test('starts a fresh browser event stream without replaying executor backlog', async () => {
  const request = executorEventRequest('?after=0&replay=0')
  const response = responseFixture()
  let receivedOptions = null

  await handleExecutorEvents(request, response, options => {
    receivedOptions = options
    return eventStreamFixture(options)
  })

  assert.deepEqual(receivedOptions, {
    afterSequence: 0,
    replayExisting: false,
  })
})

test('replays executor backlog when a zero-cursor browser reconnect requests it', async () => {
  const request = executorEventRequest('?after=0&replay=1')
  const response = responseFixture()
  let receivedOptions = null

  await handleExecutorEvents(request, response, options => {
    receivedOptions = options
    return eventStreamFixture(options)
  })

  assert.deepEqual(receivedOptions, {
    afterSequence: 0,
    replayExisting: true,
  })
})

test('returns an error before opening SSE when the executor stream cannot connect', async () => {
  const request = executorEventRequest()
  const response = responseFixture()

  await handleExecutorEvents(request, response, () =>
    eventStreamFixture({}, { startError: new Error('executor unavailable') })
  )

  assert.equal(response.status, 503)
  assert.equal(response.writableEnded, true)
})

test('pauses until a live SSE consumer drains instead of disconnecting immediately', async () => {
  const request = executorEventRequest()
  const response = responseFixture({
    writableSequence: [true, false, true],
    drainAfterWrite: 2,
  })
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
  assert.match(response.body, /"sequence":1/)
  assert.match(response.body, /"sequence":2/)
})

test('disconnects only the SSE stream when backpressure does not drain', async () => {
  const request = executorEventRequest()
  const response = responseFixture({ writable: false })
  let stopped = false

  await handleExecutorEvents(
    request,
    response,
    options =>
      eventStreamFixture(options, {
        events: [executorEvent(1)],
        onStop: () => {
          stopped = true
        },
      }),
    { slowConsumerTimeoutMs: 5 }
  )

  assert.equal(response.status, 200)
  assert.equal(response.writableEnded, true)
  assert.equal(stopped, true)
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
  const source = Readable.from(
    (config.events ?? []).map(event => Buffer.from(`${JSON.stringify(event)}\n`))
  )
  return {
    async start() {
      if (config.startError) throw config.startError
      return source
    },
    stop() {
      source.destroy()
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

function executorRpcRequest(body, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.method = 'POST'
  request.url = '/wework/executor/v1/rpc'
  request.headers = headers
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
    if (!writable && options.drainAfterWrite === this.writes) {
      setImmediate(() => this.emit('drain'))
    }
    return writable
  }
  response.end = function (body = '') {
    this.body += body
    this.writableEnded = true
  }
  return response
}
