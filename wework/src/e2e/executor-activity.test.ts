import {
  armRuntimeTransportGate,
  releaseRuntimeTransportGate,
  resetRuntimeTransportGates,
} from './runtime-transport-gates'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import { recordExecutorActivity, startExecutorActivity } from './executor-activity'

beforeEach(() => vi.stubEnv('VITE_WEWORK_E2E', 'true'))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('overlapping captures aggregate RPC work without retaining parameters', () => {
  const first = startExecutorActivity()
  recordExecutorActivity({ kind: 'request', method: 'runtime.tasks.list', pendingOnly: false })
  const second = startExecutorActivity()
  recordExecutorActivity({ kind: 'request', method: 'runtime.tasks.list', pendingOnly: true })
  first.stop()
  recordExecutorActivity({ kind: 'request', method: 'runtime.tasks.list', pendingOnly: true })
  second.stop()
  expect(first.snapshot()).toMatchObject({
    available: true,
    fullTaskListReads: 1,
    pendingTaskListReads: 1,
  })
  expect(second.snapshot()).toMatchObject({
    fullTaskListReads: 0,
    pendingTaskListReads: 2,
    requests: { 'runtime.tasks.list': 2 },
  })
})

test('actual RPC parse failures remain visible when the caller catches the exception', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{invalid', { status: 200 }))
  )
  const activity = startExecutorActivity()
  try {
    await expect(requestDshExecutor('runtime.tasks.list')).rejects.toThrow()
    expect(activity.snapshot()).toMatchObject({
      parseFailures: 1,
      requestFailures: 1,
      fullTaskListReads: 1,
    })
  } finally {
    activity.stop()
  }
})

test('actual stream parsing and suppressed duplicates are counted at the shared boundary', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const sources: FakeEventSource[] = []
  class FakeEventSource {
    onmessage: ((message: MessageEvent<string>) => void) | null = null
    onerror: (() => void) | null = null
    close = vi.fn()
    constructor() {
      sources.push(this)
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  const activity = startExecutorActivity()
  const listener = vi.fn()
  const unsubscribe = subscribeDshExecutorEvents(listener)
  try {
    const message = {
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 987654321,
        event: 'task.changed',
        data: {},
      }),
    } as MessageEvent<string>
    sources[0].onmessage?.(message)
    sources[0].onmessage?.(message)
    sources[0].onmessage?.({ data: '{invalid' } as MessageEvent<string>)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(activity.snapshot()).toMatchObject({
      parseFailures: 1,
      duplicateEvents: 1,
      duplicateDeliveries: 0,
      events: { 'task.changed': 1 },
    })
  } finally {
    unsubscribe()
    activity.stop()
  }
})

test('describe endpoint failures and explicit cancellation have independent counters', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{invalid'))
  )
  const activity = startExecutorActivity()
  try {
    await expect(describeDshExecutor()).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError')
      })
    )
    await expect(
      requestDshExecutor('runtime.tasks.transcript', {}, { signal: controller.signal })
    ).rejects.toThrow()
    expect(activity.snapshot()).toMatchObject({
      parseFailures: 1,
      requestFailures: 1,
      cancellations: 1,
      requests: { 'executor.describe': 1, 'runtime.tasks.transcript': 1 },
    })
  } finally {
    activity.stop()
  }
})

test('out-of-order distinct delivery is not mistaken for duplicate processing', () => {
  const activity = startExecutorActivity()
  const stream = Symbol('test-stream')
  try {
    for (const sequence of [2, 1, 2])
      recordExecutorActivity({
        kind: 'event',
        name: 'task.changed',
        stream,
        sequence,
        delivered: true,
      })
    recordExecutorActivity({
      kind: 'event',
      name: 'task.changed',
      stream: Symbol('replacement'),
      sequence: 1,
      delivered: true,
    })
    expect(activity.snapshot()).toMatchObject({
      duplicateDeliveries: 1,
      events: { 'task.changed': 4 },
    })
  } finally {
    activity.stop()
  }
})

test('actual transport replay is attributed to fault injection without losing the duplicate fact', () => {
  const sources: Array<{ onmessage: ((message: MessageEvent<string>) => void) | null }> = []
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage = null
      onerror = null
      close() {}
      constructor() {
        sources.push(this)
      }
    }
  )
  armRuntimeTransportGate({
    id: 'observed-replay',
    kind: 'event',
    name: 'task.replayed',
    hold: false,
  })
  const activity = startExecutorActivity()
  const listener = vi.fn()
  const unsubscribe = subscribeDshExecutorEvents(listener)
  try {
    sources[0].onmessage?.({
      data: JSON.stringify({
        protocolVersion: 1,
        sequence: 1,
        event: 'task.replayed',
        payload: {},
      }),
    } as MessageEvent<string>)
    releaseRuntimeTransportGate('observed-replay')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(activity.snapshot()).toMatchObject({
      duplicateDeliveries: 1,
      injectedDuplicateDeliveries: 1,
      events: { 'task.replayed': 2 },
    })
  } finally {
    resetRuntimeTransportGates()
    unsubscribe()
    activity.stop()
  }
})

test('cancellation covers opted-in reads while genuine parse errors racing abort remain faults', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const controller = new AbortController()
  controller.abort()
  const activity = startExecutorActivity()
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw controller.signal.reason
      })
    )
    await expect(
      requestDshExecutor('runtime.tasks.get', {}, { signal: controller.signal })
    ).rejects.toBe(controller.signal.reason)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{invalid'))
    )
    await expect(
      requestDshExecutor('runtime.tasks.transcript', {}, { signal: controller.signal })
    ).rejects.toThrow()
    expect(activity.snapshot()).toMatchObject({
      cancellations: 1,
      transportFailures: 0,
      parseFailures: 1,
      requestFailures: 1,
    })
  } finally {
    activity.stop()
  }
})
