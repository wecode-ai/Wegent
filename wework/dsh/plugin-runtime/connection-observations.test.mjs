import assert from 'node:assert/strict'
import test from 'node:test'
import { collectObservation } from './connection-observations.js'

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

test('preserves a provider recovery window and its explicit gap through the collector', async () => {
  const start = '2026-11-24T10:00:00Z'
  const end = '2026-11-24T10:30:00Z'
  const recovery = { start, end, cursor: end, complete: false }
  const gap = { start, end, code: 'event_limit' }
  const collected = await collectObservation(
    {
      call: async (_id, _method, input) => {
        assert.equal(input.recover, true)
        return { events: [], nextCheckpoint: { after: end }, hasMore: false, recovery, gap }
      },
    },
    'dingtalk',
    { source: {}, checkpoint: {}, recover: true }
  )
  assert.deepEqual(collected.recovery, recovery)
  assert.deepEqual(collected.gap, gap)
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
