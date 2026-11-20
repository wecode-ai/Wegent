import assert from 'node:assert/strict'
import test from 'node:test'
import { EventBus } from './event-bus.js'

function exactProvider(poll) {
  return {
    plan(entries) {
      const groups = Map.groupBy(entries, entry => entry.query)
      return [...groups].map(([query, entries]) => ({ key: query, query, entries }))
    },
    poll,
    select: result => result,
  }
}

test('subscriber queries merge by provider, with each subscriber seeing only its selection', async () => {
  const bus = new EventBus()
  const polls = []
  bus.registerProvider('example', {
    plan(entries) {
      const query = [...new Set(entries.flatMap(entry => entry.query))]
      return [{ key: query, query, entries }]
    },
    async poll(query) {
      polls.push(query)
      return query.map(id => ({ id }))
    },
    select: (result, query) => result.filter(event => query.includes(event.id)),
  })
  try {
    const actual = await Promise.all([
      bus.request('example', ['a', 'b']),
      bus.request('example', ['b', 'c']),
    ])
    assert.deepEqual(polls, [['a', 'b', 'c']])
    assert.deepEqual(actual, [
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }, { id: 'c' }],
    ])
  } finally {
    bus.stop()
  }
})

test('a slow poll is aborted and frees its worker while independent polls finish', async () => {
  const bus = new EventBus({ workers: 2, timeoutMs: 30 })
  let slowSignal
  let active = 0
  let peak = 0
  const slow = Promise.withResolvers()
  bus.registerProvider(
    'example',
    exactProvider(async (query, signal) => {
      peak = Math.max(peak, ++active)
      try {
        if (query === 'slow') {
          slowSignal = signal
          slow.resolve()
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
        }
        if (query === 'failed') throw new Error('current poll only')
        return query
      } finally {
        --active
      }
    })
  )
  const hold = setTimeout(() => {}, 1000)
  try {
    const timedOut = assert.rejects(bus.request('example', 'slow'), {
      code: 'request_timeout',
      retryAfterMs: 30_000,
    })
    await slow.promise
    const failed = assert.rejects(bus.request('example', 'failed'), /current poll only/)
    assert.equal(await bus.request('example', 'healthy'), 'healthy')
    assert.equal(slowSignal.aborted, false)
    await failed
    await timedOut
    assert.equal(slowSignal.aborted, true)
    assert.equal(await bus.request('example', 'after-timeout'), 'after-timeout')
    assert.equal(peak, 2)
  } finally {
    clearTimeout(hold)
    bus.stop()
  }
})

test('canceling one subscriber leaves an identical remaining poll running', async () => {
  const bus = new EventBus()
  const ready = Promise.withResolvers()
  const release = Promise.withResolvers()
  let called = 0
  bus.registerProvider(
    'example',
    exactProvider(async (query, signal) => {
      ++called
      ready.resolve()
      await release.promise
      signal.throwIfAborted()
      return query
    })
  )
  try {
    const controller = new AbortController()
    const canceled = assert.rejects(bus.request('example', 'same', controller.signal), {
      name: 'AbortError',
    })
    await ready.promise
    const kept = bus.request('example', 'same')
    await Promise.resolve()
    controller.abort()
    release.resolve()
    await canceled
    assert.equal(await kept, 'same')
    assert.equal(called, 1)
  } finally {
    bus.stop()
  }
})
