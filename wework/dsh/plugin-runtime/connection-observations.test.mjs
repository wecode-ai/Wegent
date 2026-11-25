import assert from 'node:assert/strict'
import test from 'node:test'
import { collectObservation } from './connection-observations.js'
import { EventBus } from './event-bus.js'

const staged = registry => ({
  ...registry,
  entries: new Map([['documents', { provider: { collectionPagination: 'staged' } }]]),
})

test('preserves the durable-only provider contract unless staged collection is declared', async () => {
  let count = 0
  const result = await collectObservation(
    {
      call: async () => {
        count++
        return { events: [], nextCheckpoint: { cursor: 1 }, hasMore: true }
      },
    },
    'documents',
    { source: {}, checkpoint: { cursor: 0 } }
  )
  assert.equal(count, 1)
  assert.equal(result.hasMore, true)
})

test('drains a provider cycle with one canonical resource snapshot and checkpoint', async () => {
  const calls = []
  const registry = {
    call: async (providerId, method, input) => {
      calls.push({ providerId, method, cursor: input.checkpoint.cursor })
      const cursor = input.checkpoint.cursor + 1
      return {
        events: [{ id: `event-${cursor}` }],
        nextCheckpoint: { cursor },
        hasMore: cursor < 3,
        resourceStates: [{ revision: cursor }],
      }
    },
  }
  const result = await collectObservation(staged(registry), 'documents', {
    source: { id: 'document' },
    checkpoint: { cursor: 0 },
  })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.method === 'collect'))
  assert.deepEqual(
    result.events.map(event => event.id),
    ['event-1', 'event-2', 'event-3']
  )
  assert.deepEqual(result.nextCheckpoint, { cursor: 3 })
  assert.deepEqual(result.resourceStates, [{ revision: 3 }])
})

test('keeps successful pages durable when a later read fails and does not adopt its mutated cursor', async () => {
  const registry = {
    call: async (_provider, _method, input) => {
      if (input.checkpoint.cursor) {
        input.checkpoint.cursor = 999
        throw Object.assign(new Error('Disconnected'), { code: 'connection_unavailable' })
      }
      return { events: [{ id: 'captured' }], nextCheckpoint: { cursor: 1 }, hasMore: true }
    },
  }
  const result = await collectObservation(staged(registry), 'documents', {
    source: {},
    checkpoint: { cursor: 0 },
  })
  assert.deepEqual(result.nextCheckpoint, { cursor: 1 })
  assert.deepEqual(result.events, [{ id: 'captured' }])
  assert.equal(result.errorCode, 'connection_unavailable')
  assert.equal(result.hasMore, true)
})

test('bounds a cycle without losing an overflowing page or advancing its checkpoint', async () => {
  let calls = 0
  const registry = {
    call: async (_provider, _method, input) => {
      calls++
      return {
        events: Array.from({ length: 600 }, (_, index) => ({
          id: `${input.checkpoint.cursor}-${index}`,
        })),
        nextCheckpoint: { cursor: input.checkpoint.cursor + 1 },
        hasMore: true,
      }
    },
  }
  const result = await collectObservation(staged(registry), 'documents', {
    source: {},
    checkpoint: { cursor: 0 },
  })
  assert.equal(calls, 2)
  assert.equal(result.events.length, 600)
  assert.deepEqual(result.nextCheckpoint, { cursor: 1 })
})

test('commits completed pages when the event bus cancels a later read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bus = new EventBus({ timeoutMs: 15_000 })
  t.after(() => bus.stop())
  const stalled = Promise.withResolvers()
  const seen = []
  const registry = staged({
    async call(_provider, _method, { checkpoint }, { signal }) {
      const cursor = checkpoint.cursor
      seen.push(cursor)
      if (cursor === 1 && seen.length === 2) {
        checkpoint.cursor = 999
        stalled.resolve(signal)
        return new Promise(() => {})
      }
      return {
        events: [{ id: cursor }],
        nextCheckpoint: { cursor: cursor + 1 },
        resourceStates: [{ revision: cursor }],
        hasMore: cursor === 0,
      }
    },
  })
  bus.registerProvider('documents', {
    plan(entries) {
      return entries.map(entry => ({ key: entry.query, query: entry.query, entries: [entry] }))
    },
    poll(input, signal, publishProgress) {
      return collectObservation(registry, 'documents', input, { signal, publishProgress })
    },
    select: result => result,
  })
  const first = bus.request('documents', { source: {}, checkpoint: { cursor: 0 } })
  const signal = await stalled.promise
  t.mock.timers.tick(15_000)
  const partial = await first
  assert.equal(signal.aborted, true)
  assert.deepEqual(partial, {
    events: [{ id: 0 }],
    nextCheckpoint: { cursor: 1 },
    resourceStates: [{ revision: 0 }],
    hasMore: true,
    errorCode: 'request_timeout',
    retryAfterMs: 30_000,
  })
  const next = await bus.request('documents', { source: {}, checkpoint: partial.nextCheckpoint })
  assert.deepEqual(next.events, [{ id: 1 }])
  assert.deepEqual(seen, [0, 1, 1])
})
