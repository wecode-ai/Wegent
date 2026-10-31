import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createRequestSecurity } from '../electron-host/request-security.js'
import { apply, handleExecutorEvents, handleExecutorRpc } from './index.js'
import { ExecutorRuntimeClient, ExecutorRuntimeError } from './executor-runtime-client.js'

test('serves a scoped plugin image as same-origin inert image bytes', async t => {
  const request = executorEventRequest()
  const path = '/device/plugins/healthy-plugin/assets/logo.svg'
  request.url = `/wework/executor/v1/plugin-image?path=${encodeURIComponent(path)}`
  request.headers = {
    host: '127.0.0.1:3000',
    cookie: 'session=authenticated',
    origin: 'http://127.0.0.1:3000',
    'sec-fetch-site': 'same-origin',
  }
  const response = responseFixture()
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
  const image = await registeredHandler(
    t,
    {
      async request(method, params) {
        assert.equal(method, 'executor.plugins.image.read')
        assert.deepEqual(params, { path })
        return { mimeType: 'image/svg+xml', bytesBase64: Buffer.from(svg).toString('base64') }
      },
    },
    '/wework/executor/v1/plugin-image'
  )
  await image(request, response)
  assert.equal(response.status, 200)
  assert.equal(response.body, svg)
  assert.equal(response.headers['content-type'], 'image/svg+xml')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox")
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin')
})

test('rejects cross-origin and non-loopback image reads before calling the executor', async t => {
  for (const config of [
    { origin: 'https://other.example' },
    { remoteAddress: '192.0.2.10' },
    { fetchSite: 'cross-site' },
  ]) {
    const request = executorEventRequest()
    request.url = '/wework/executor/v1/plugin-image?path=%2Fdevice%2Fplugins%2Flogo.svg'
    request.headers = {
      host: '127.0.0.1:3000',
      cookie: 'session=authenticated',
      origin: config.origin ?? 'http://127.0.0.1:3000',
      'sec-fetch-site': config.fetchSite ?? 'same-origin',
    }
    request.socket.remoteAddress = config.remoteAddress ?? '127.0.0.1'
    const response = responseFixture()
    const image = await registeredHandler(
      t,
      {
        request() {
          throw new Error('Must not reach executor')
        },
      },
      '/wework/executor/v1/plugin-image'
    )
    await image(request, response)
    assert.equal(response.status, 403)
  }
})

test('missing, invalid, and oversized plugin images fail locally without leaking paths', async t => {
  for (const result of [
    null,
    { mimeType: 'text/html', bytesBase64: 'aGVsbG8=' },
    { mimeType: 'image/png', bytesBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
  ]) {
    const request = executorEventRequest()
    request.url = '/wework/executor/v1/plugin-image?path=%2Fprivate%2Fplugin%2Flogo.svg'
    const response = responseFixture()
    const image = await registeredHandler(
      t,
      {
        request() {
          if (!result) throw new Error('Sensitive local path and error')
          return result
        },
      },
      '/wework/executor/v1/plugin-image'
    )
    await image(request, response)
    assert.equal(response.status, 404)
    assert.equal(response.body, '')
    assert.equal(response.headers['cache-control'], 'no-store')
  }
})

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

test('describe rejects unauthenticated and rebinding requests before reading identity', async t => {
  let reads = 0
  const describe = await registeredDescribeHandler(t, {
    describe: () => {
      reads++
      return { protocol_version: 1 }
    },
  })
  for (const [headers, status] of [
    [{ host: '127.0.0.1:3000' }, 401],
    [
      {
        host: 'rebind.attacker.test:3000',
        origin: 'http://rebind.attacker.test:3000',
        cookie: 'session=authenticated',
      },
      403,
    ],
  ]) {
    const request = executorEventRequest()
    request.headers = headers
    const response = responseFixture()

    await describe(request, response)

    assert.equal(response.status, status)
    assert.equal(JSON.parse(response.body).ok, false)
  }
  assert.equal(reads, 0)
})

async function registeredDescribeHandler(t, client) {
  return registeredHandler(t, client, '/wework/executor/v1')
}

async function registeredHandler(t, client, path) {
  t.mock.method(ExecutorRuntimeClient, 'fromEnvironment', () => ({
    start: async () => {},
    ...client,
  }))
  const handlers = new Map()
  await apply({
    sessions: {},
    weworkRequestSecurity: createRequestSecurity(
      {
        requestRejection: request =>
          request.headers.cookie === 'session=authenticated' ? undefined : 401,
      },
      3000
    ),
    webServer: {
      register: ({ path, handler }) => handlers.set(path, handler),
    },
    effect: (callback, label) => {
      if (label.startsWith('wework-executor-runtime: /')) callback()
    },
  })
  return handlers.get(path)
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

for (const event of ['finish', 'close']) {
  test(`records HTTP ${event} separately from executor completion without payloads`, async t => {
    const log = t.mock.method(console, 'info', () => {})
    const response = responseFixture()
    await handleExecutorRpc(
      executorRpcRequest({ id: 'http-lifecycle', method: 'runtime.tasks.get', params: {} }),
      response,
      { request: async () => ({ privateTaskContent: 'must-not-be-logged' }) }
    )
    assert.equal(log.mock.calls.length, 2)

    response.emit(event)

    assert.equal(log.mock.calls.length, 3)
    const [label, fields] = log.mock.calls[2].arguments
    assert.equal(label, '[wework-executor-runtime] RPC HTTP response')
    assert.equal(fields.request_id, 'http-lifecycle')
    assert.equal(fields.event, event === 'finish' ? 'finished' : 'closed')
    assert.equal(fields.headers_sent, true)
    assert.equal(fields.writable_ended, true)
    assert.ok(!JSON.stringify(log.mock.calls).includes('must-not-be-logged'))
    for (const name of ['finish', 'close', 'error']) assert.equal(response.listenerCount(name), 0)
  })
}

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
  request.headers = { host: '127.0.0.1:3000', cookie: 'session=authenticated' }
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
