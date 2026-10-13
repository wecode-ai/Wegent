import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { handleExecutorEvents, handleExecutorRpc } from './index.js'

async function withDiagnostics(run) {
  const original = console.info
  const environment = process.env.WEWORK_E2E_CONTROL_URL
  const events = []
  const waiters = []
  console.info = (label, event) => {
    if (label !== '[wework-executor-runtime] HTTP diagnostic') return
    events.push(event)
    for (const waiter of waiters) if (waiter.predicate(event)) waiter.resolve(event)
  }
  process.env.WEWORK_E2E_CONTROL_URL = 'diagnostic-fixture'
  const waitFor = predicate =>
    new Promise(resolve => {
      const existing = events.find(predicate)
      if (existing) resolve(existing)
      else waiters.push({ predicate, resolve })
    })
  try {
    await run(events, waitFor)
  } finally {
    console.info = original
    if (environment === undefined) delete process.env.WEWORK_E2E_CONTROL_URL
    else process.env.WEWORK_E2E_CONTROL_URL = environment
  }
}

async function listen(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function close(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

test('distinguishes HTTP receipt from a held request body without recording its contents', async () => {
  await withDiagnostics(async (events, waitFor) => {
    let calls = 0
    const server = await listen((req, res) =>
      handleExecutorRpc(req, res, {
        async request() {
          calls += 1
          return { accepted: true }
        },
      })
    )
    let client
    try {
      const response = new Promise((resolve, reject) => {
        client = request(
          {
            hostname: '127.0.0.1',
            port: server.address().port,
            path: '/wework/executor/v1/rpc',
            method: 'POST',
            headers: { 'x-request-id': 'held-body-request' },
          },
          incoming => {
            incoming.resume()
            incoming.once('end', () => resolve(incoming.statusCode))
          }
        )
        client.on('error', reject)
      })
      client.flushHeaders()
      const received = await waitFor(event => event.phase === 'rpc-http-received')
      assert.equal(calls, 0)
      assert.equal(
        events.some(event => event.phase === 'rpc-body-read'),
        false
      )
      client.end(
        JSON.stringify({ method: 'runtime.tasks.list', params: { secret: 'private fixture body' } })
      )
      assert.equal(await response, 200)
      const body = events.find(event => event.phase === 'rpc-body-read')
      assert.equal(body.sequence, received.sequence)
      assert.equal(body.request_id, 'held-body-request')
      assert.equal(calls, 1)
      assert.doesNotMatch(JSON.stringify(events), /private fixture body|secret|runtime.tasks.list/)
    } finally {
      client?.destroy()
      await close(server)
    }
  })
})

test('counts real concurrent SSE connections and releases each count once on abort', async () => {
  await withDiagnostics(async (events, waitFor) => {
    const clients = []
    const server = await listen((req, res) =>
      handleExecutorEvents(req, res, () => {
        const source = new PassThrough()
        return {
          async start() {
            source.write(
              `${JSON.stringify({ protocolVersion: 1, sequence: 1, event: 'fixture', payload: {} })}\n`
            )
            return source
          },
          stop() {
            source.destroy()
          },
        }
      })
    )
    try {
      for (let index = 0; index < 2; index += 1) {
        await new Promise((resolve, reject) => {
          const client = request(
            {
              hostname: '127.0.0.1',
              port: server.address().port,
              path: '/wework/executor/v1/events',
              agent: false,
            },
            incoming => {
              incoming.on('data', () => resolve())
            }
          )
          clients.push(client)
          client.on('error', reject)
          client.end()
        })
      }
      assert.deepEqual(
        events
          .filter(event => event.phase === 'events-http-received')
          .map(event => event.activeEventStreams),
        [1, 2]
      )
      clients[0].destroy()
      await waitFor(event => event.phase === 'events-closed' && event.activeEventStreams === 1)
      clients[1].destroy()
      await waitFor(event => event.phase === 'events-closed' && event.activeEventStreams === 0)
      assert.equal(events.filter(event => event.phase === 'events-closed').length, 2)
    } finally {
      for (const client of clients) client.destroy()
      await close(server)
    }
  })
})
