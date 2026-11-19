import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { collectObservation } from './connection-observations.js'
import { cloudObservationClient, runCloudObservation } from './cloud-observations.js'

const collector = registry => (providerId, input, signal) =>
  collectObservation(registry, providerId, input, { signal })

const observation = {
  id: 'observation',
  source: { providerId: 'documents', id: 'document' },
  checkpoint: { cursor: 10 },
  lease: { id: 'lease', forceVersion: 1 },
  collectedForceVersion: 0,
}

test('a collector credential cannot follow an HTTP redirect to another endpoint', async () => {
  let leaked = 0
  const server = createServer((req, res) => {
    if (req.url === '/api/runtime-observations/collector') {
      res.writeHead(302, { location: '/unrelated' })
      res.end()
    } else {
      leaked++
      res.writeHead(200)
      res.end('{}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const request = cloudObservationClient(
      `http://127.0.0.1:${server.address().port}`,
      'synthetic-scoped-token'
    )
    await assert.rejects(request('read_lease'))
    assert.equal(leaked, 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('a lease from another account cannot invoke a provider or commit facts', async () => {
  const calls = []
  await assert.rejects(
    runCloudObservation(
      async action => {
        calls.push(action)
        return { ownerId: 8, observation }
      },
      async () => assert.fail('Foreign lease must not read a provider'),
      { expectedOwnerId: 7 }
    ),
    error => error.code === 'observation_owner_changed'
  )
  assert.deepEqual(calls, ['read_lease'])
})

test('a cloud collector persists the same Node provider cycle without starting an Executor or model', async () => {
  const calls = []
  const reads = []
  const request = async (action, input) => {
    calls.push({ action, input })
    return action === 'read_lease' ? { observation } : { accepted: true }
  }
  const registry = {
    entries: new Map([['documents', { provider: { collectionPagination: 'staged' } }]]),
    call: async (_provider, method, input) => {
      reads.push(input)
      assert.equal(method, 'collect')
      return {
        events: [{ id: `event-${input.checkpoint.cursor}` }],
        nextCheckpoint: { cursor: input.checkpoint.cursor + 1 },
        hasMore: input.checkpoint.cursor < 11,
      }
    },
  }
  assert.deepEqual(await runCloudObservation(request, collector(registry)), { accepted: true })
  assert.deepEqual(
    calls.map(call => call.action),
    ['read_lease', 'commit']
  )
  assert.equal(calls[1].input.page.events.length, 2)
  assert.deepEqual(calls[1].input.page.nextCheckpoint, { cursor: 12 })
  assert.ok(reads.every(input => input.force && input.committedCheckpoint.cursor === 10))
})

test('collection failures persist only the bounded error and retain the Backend cursor', async () => {
  const calls = []
  const request = async (action, input) => {
    calls.push({ action, input })
    return action === 'read_lease' ? { observation } : { accepted: true, collected: false }
  }
  const registry = {
    call: async () => {
      throw Object.assign(new Error('Do not persist message contents'), {
        code: 'temporary_failure',
        retryAfterMs: 30000,
      })
    },
  }
  await runCloudObservation(request, collector(registry))
  assert.deepEqual(calls[1], {
    action: 'fail',
    input: { errorCode: 'temporary_failure', retryAfterMs: 30000 },
  })
  assert.ok(!calls.some(call => call.action === 'commit'))
  assert.deepEqual(observation.checkpoint, { cursor: 10 })
})

test('losing the collection lease aborts the in-flight page and prevents further reads or commits', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const calls = []
  let entered
  const started = new Promise(resolve => {
    entered = resolve
  })
  let aborted
  const cancelled = new Promise(resolve => {
    aborted = resolve
  })
  const lost = Object.assign(new Error('Lease revoked'), { code: 'observation_lease_lost' })
  const registry = {
    entries: new Map([['documents', { provider: { collectionPagination: 'staged' } }]]),
    call: async (_provider, _method, _input, { signal }) => {
      calls.push('collect')
      signal.addEventListener('abort', () => aborted(signal.reason), { once: true })
      entered()
      const reason = await cancelled
      throw reason
    },
  }
  const request = async action => {
    calls.push(action)
    if (action === 'read_lease') return { observation }
    if (action === 'renew') throw lost
    assert.fail(`Unexpected ${action} after losing the lease`)
  }
  const running = runCloudObservation(request, collector(registry))
  const rejected = assert.rejects(running, error => error === lost)
  await started
  t.mock.timers.tick(20000)
  assert.equal(await cancelled, lost)
  await rejected
  assert.deepEqual(calls, ['read_lease', 'collect', 'renew'])
})

test('the worker HTTP transport uses the scoped collector endpoint and never sends a service credential', async () => {
  const captured = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    captured.push({
      path: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks)),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ accepted: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const prefix of ['', '/gateway']) {
      const request = cloudObservationClient(
        `http://127.0.0.1:${server.address().port}${prefix}/`,
        'synthetic-scoped-token'
      )
      await request('renew')
    }
    assert.deepEqual(
      captured,
      ['', '/gateway'].map(prefix => ({
        path: `${prefix}/api/runtime-observations/collector`,
        authorization: 'Bearer synthetic-scoped-token',
        body: { action: 'renew' },
      }))
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
