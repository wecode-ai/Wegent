import assert from 'node:assert/strict'
import test from 'node:test'

import { createBatchQueue } from './batch-queue.js'

test('sends a full batch immediately and a partial batch on its flush timer', async () => {
  const timers = createFakeTimers()
  const batches = []
  const queue = createBatchQueue({
    sendBatch: async events => {
      batches.push(events)
      return { status: 'accepted' }
    },
    batchSize: 2,
    flushIntervalMs: 5000,
    maxQueueSize: 5,
    retryDelaysMs: [1000, 5000, 30000],
    ...timers,
  })

  queue.enqueue(event('one'))
  assert.deepEqual(timers.pendingDelays(), [5000])
  queue.enqueue(event('two'))
  await queue.flush()
  assert.deepEqual(batches, [[event('one'), event('two')]])

  queue.enqueue(event('three'))
  assert.deepEqual(timers.pendingDelays(), [5000])
  timers.runNext()
  await settle()
  assert.deepEqual(batches, [[event('one'), event('two')], [event('three')]])
})

test('drops the oldest queued event at the memory limit and exposes aggregate status only', async () => {
  const batches = []
  const queue = createQueue({
    batchSize: 5,
    maxQueueSize: 3,
    sendBatch: async events => {
      batches.push(events)
      return { status: 'accepted' }
    },
  })

  for (const name of ['one', 'two', 'three', 'four']) queue.enqueue(event(name))

  assert.deepEqual(queue.status(), {
    queuedEvents: 3,
    droppedEvents: 1,
    sentBatches: 0,
    sentEvents: 0,
    retries: 0,
    permanentFailedBatches: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
  })
  await queue.flush()
  assert.deepEqual(batches, [[event('two'), event('three'), event('four')]])
})

test('enqueues synchronously and permits only one in-flight request', async () => {
  const first = deferred()
  const batches = []
  const queue = createQueue({
    batchSize: 2,
    sendBatch: async events => {
      batches.push(events)
      return batches.length === 1 ? first.promise : { status: 'accepted' }
    },
  })

  assert.equal(queue.enqueue(event('one')), true)
  assert.equal(queue.enqueue(event('two')), true)
  await settle()
  assert.equal(batches.length, 1)

  queue.enqueue(event('three'))
  queue.enqueue(event('four'))
  void queue.flush()
  assert.equal(batches.length, 1)

  first.resolve({ status: 'accepted' })
  await waitFor(() => batches.length === 2)
  assert.deepEqual(batches, [
    [event('one'), event('two')],
    [event('three'), event('four')],
  ])
})

test('retries only retryable batches with bounded delays and preserves event order', async () => {
  const timers = createFakeTimers()
  const batches = []
  const responses = [
    { status: 'retryable_error', code: 'posthog_timeout' },
    { status: 'retryable_error', code: 'posthog_rate_limited' },
    { status: 'retryable_error', code: 'posthog_unavailable' },
    { status: 'retryable_error', code: 'posthog_unavailable' },
  ]
  const queue = createBatchQueue({
    sendBatch: async events => {
      batches.push(events)
      return responses.shift()
    },
    batchSize: 2,
    flushIntervalMs: 5000,
    maxQueueSize: 5,
    retryDelaysMs: [1000, 5000, 30000],
    ...timers,
  })

  queue.enqueue(event('one'))
  queue.enqueue(event('two'))
  await settle()

  for (const delay of [1000, 5000, 30000]) {
    assert.deepEqual(timers.pendingDelays(), [delay])
    timers.runNext()
    await settle()
  }

  assert.equal(batches.length, 4)
  assert.deepEqual(
    batches,
    Array.from({ length: 4 }, () => [event('one'), event('two')])
  )
  assert.deepEqual(queue.status(), {
    queuedEvents: 0,
    droppedEvents: 0,
    sentBatches: 0,
    sentEvents: 0,
    retries: 3,
    permanentFailedBatches: 1,
    lastSuccessAt: null,
    lastFailureAt: 0,
    lastFailureCode: 'posthog_unavailable',
  })
})

test('does not retry permanent failures and removes accepted batches', async () => {
  const timers = createFakeTimers()
  const queue = createBatchQueue({
    sendBatch: async () => ({ status: 'permanent_error', code: 'posthog_rejected' }),
    batchSize: 1,
    flushIntervalMs: 5000,
    maxQueueSize: 5,
    retryDelaysMs: [1000, 5000, 30000],
    ...timers,
  })

  queue.enqueue(event('one'))
  await settle()
  assert.deepEqual(timers.pendingDelays(), [])
  assert.equal(queue.status().permanentFailedBatches, 1)
  assert.equal(queue.status().lastFailureCode, 'posthog_rejected')
  assert.equal(queue.status().queuedEvents, 0)
})

test('disposes within its budget, clears timers, and refuses new events', async () => {
  const timers = createFakeTimers()
  const pending = deferred()
  const batches = []
  const queue = createBatchQueue({
    sendBatch: async events => {
      batches.push(events)
      return pending.promise
    },
    batchSize: 5,
    flushIntervalMs: 5000,
    maxQueueSize: 5,
    retryDelaysMs: [1000, 5000, 30000],
    ...timers,
  })

  queue.enqueue(event('one'))
  const disposing = queue.dispose({ timeoutMs: 1000 })
  await settle()

  assert.deepEqual(batches, [[event('one')]])
  assert.equal(queue.enqueue(event('two')), false)
  assert.deepEqual(timers.pendingDelays(), [1000])

  timers.runNext()
  await disposing
  assert.equal(queue.status().queuedEvents, 0)
  assert.deepEqual(timers.pendingDelays(), [])
  assert.equal(batches.length, 1)
})

function createQueue(overrides = {}) {
  return createBatchQueue({
    sendBatch: async () => ({ status: 'accepted' }),
    batchSize: 20,
    flushIntervalMs: 5000,
    maxQueueSize: 500,
    retryDelaysMs: [1000, 5000, 30000],
    ...createFakeTimers(),
    ...overrides,
  })
}

function event(name) {
  return Object.freeze({ event: name, uuid: `${name}-uuid` })
}

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createFakeTimers() {
  let nextId = 0
  const timers = new Map()
  return {
    clearTimer(timer) {
      timers.delete(timer.id)
    },
    now() {
      return 0
    },
    pendingDelays() {
      return [...timers.values()].map(timer => timer.delay)
    },
    setTimer(callback, delay) {
      const timer = {
        id: nextId,
        delay,
        callback,
        unref() {},
      }
      nextId += 1
      timers.set(timer.id, timer)
      return timer
    },
    runNext() {
      const timer = timers.values().next().value
      assert.ok(timer, 'expected a pending timer')
      timers.delete(timer.id)
      timer.callback()
    },
  }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

async function waitFor(predicate) {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return
    await settle()
  }
  assert.fail('condition was not met')
}
