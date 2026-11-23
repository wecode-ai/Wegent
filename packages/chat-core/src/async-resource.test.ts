import { expect, test, vi } from 'vitest'
import { createAsyncResource } from './async-resource'

function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('shares an active request and caches a successful scoped snapshot', async () => {
  const request = held<string>()
  const load = vi.fn(() => request.promise)
  const store = createAsyncResource('account/A', load)
  const first = store.subscribe(vi.fn())
  const second = store.subscribe(vi.fn())
  expect(load).toHaveBeenCalledTimes(1)
  request.resolve('A')
  await request.promise
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', data: 'A' })
  first()
  second()
  store.subscribe(vi.fn())()
  expect(load).toHaveBeenCalledTimes(1)
})

test('a superseded result cannot replace the current read or report success', async () => {
  const old = held<string>(),
    fresh = held<string>()
  const success = vi.fn()
  const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const store = createAsyncResource('A', load, { success })
  const stop = store.subscribe(vi.fn())
  const refreshed = store.reload()
  fresh.resolve('new')
  await refreshed
  old.resolve('old')
  await old.promise
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', data: 'new' })
  expect(success).toHaveBeenCalledExactlyOnceWith('new')
  stop()
})

test('detached requests cannot publish state or success callbacks', async () => {
  const request = held<string>(),
    success = vi.fn(),
    listener = vi.fn()
  const store = createAsyncResource('A', () => request.promise, { success })
  const stop = store.subscribe(listener)
  stop()
  listener.mockClear()
  request.resolve('late')
  await request.promise
  expect(store.getSnapshot()).toMatchObject({
    status: 'idle',
    data: undefined,
  })
  expect(listener).not.toHaveBeenCalled()
  expect(success).not.toHaveBeenCalled()
})

test('synchronous failures are observable and explicit reload can recover', async () => {
  const load = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('offline')
    })
    .mockResolvedValueOnce('ready')
  const failure = vi.fn()
  const store = createAsyncResource('A', load, { failure })
  const stop = store.subscribe(vi.fn())
  await Promise.resolve()
  expect(store.getSnapshot().status).toBe('error')
  expect(failure).toHaveBeenCalledTimes(1)
  await store.reload()
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', data: 'ready' })
  stop()
})

test('seeded data remains visible until the new request identity settles', async () => {
  const request = held<string>()
  const store = createAsyncResource('revision-2', () => request.promise, {
    initialData: 'revision-1',
  })
  expect(store.getSnapshot()).toMatchObject({
    settled: false,
    data: 'revision-1',
  })
  const stop = store.subscribe(vi.fn())
  request.reject(new Error('offline'))
  await request.promise.catch(() => undefined)
  expect(store.getSnapshot()).toMatchObject({
    status: 'error',
    settled: true,
    data: 'revision-1',
  })
  stop()
})

test('local updates supersede pending reads and detached owners cannot update', async () => {
  const request = held<string>()
  const store = createAsyncResource('panel', () => request.promise)
  const stop = store.subscribe(vi.fn())
  store.update(() => 'saved')
  request.resolve('old read')
  await request.promise
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', data: 'saved' })
  stop()
  store.update(() => 'detached')
  expect(store.getSnapshot().data).toBe('saved')
})

test('panels can opt in to refresh on each new active subscription', async () => {
  const load = vi.fn().mockResolvedValue('current')
  const store = createAsyncResource('panel', load, {
    refreshOnSubscribe: true,
  })
  const stop = store.subscribe(vi.fn())
  await Promise.resolve()
  stop()
  const stopAgain = store.subscribe(vi.fn())
  expect(load).toHaveBeenCalledTimes(2)
  await Promise.resolve()
  stopAgain()
})

test('aborts superseded reads and keeps a shared read alive until the last subscriber leaves', () => {
  const signals: AbortSignal[] = []
  const store = createAsyncResource('request', signal => {
    signals.push(signal)
    return new Promise<string>(() => {})
  })
  const stopFirst = store.subscribe(vi.fn())
  const stopSecond = store.subscribe(vi.fn())
  stopFirst()
  expect(signals[0].aborted).toBe(false)
  void store.reload()
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
  stopSecond()
  expect(signals[1].aborted).toBe(true)
})

test('cancels pending debounce timers and starts only the latest request', async () => {
  vi.useFakeTimers()
  try {
    const load = vi.fn(async () => 'latest')
    const failure = vi.fn()
    const store = createAsyncResource('search', load, { delayMs: 80, failure })
    const stop = store.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(79)
    expect(load).not.toHaveBeenCalled()
    stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(80)
    expect(load).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
    const stopAgain = store.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(40)
    const refreshed = store.reload()
    await vi.advanceTimersByTimeAsync(79)
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await refreshed
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().data).toBe('latest')
    stopAgain()
  } finally {
    vi.useRealTimers()
  }
})

test('releases owned values only after the final subscriber and loads a fresh value when reactivated', async () => {
  const first = { url: 'blob:first' },
    second = { url: 'blob:second' }
  const release = vi.fn()
  const load = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const store = createAsyncResource('image', load, { release })
  const stopFirst = store.subscribe(vi.fn())
  const stopSecond = store.subscribe(vi.fn())
  await Promise.resolve()
  stopFirst()
  expect(release).not.toHaveBeenCalled()
  stopSecond()
  expect(release).toHaveBeenCalledExactlyOnceWith(first)
  expect(store.getSnapshot()).toMatchObject({
    status: 'idle',
    data: undefined,
  })
  const stopAgain = store.subscribe(vi.fn())
  await Promise.resolve()
  expect(load).toHaveBeenCalledTimes(2)
  expect(store.getSnapshot().data).toBe(second)
  stopAgain()
  expect(release).toHaveBeenLastCalledWith(second)
  expect(release).toHaveBeenCalledTimes(2)
})

test('releases late exclusive values without publishing or reporting them', async () => {
  const request = held<{ url: string }>()
  const release = vi.fn(),
    success = vi.fn()
  const store = createAsyncResource('image', () => request.promise, {
    release,
    success,
  })
  const stop = store.subscribe(vi.fn())
  stop()
  const late = { url: 'blob:late' }
  request.resolve(late)
  await request.promise
  expect(release).toHaveBeenCalledExactlyOnceWith(late)
  expect(success).not.toHaveBeenCalled()
  expect(store.getSnapshot().data).toBeUndefined()
})

test('releases replaced values once and keeps the new value owned through refresh', async () => {
  const first = { url: 'blob:first' },
    second = { url: 'blob:second' }
  const release = vi.fn()
  const load = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const store = createAsyncResource('image', load, { release })
  const stop = store.subscribe(vi.fn())
  await Promise.resolve()
  await store.reload()
  expect(release).toHaveBeenCalledExactlyOnceWith(first)
  expect(store.getSnapshot().data).toBe(second)
  store.update(value => value)
  expect(release).toHaveBeenCalledTimes(1)
  stop()
  expect(release).toHaveBeenLastCalledWith(second)
  expect(release).toHaveBeenCalledTimes(2)
})

test('shares one refresh interval and cancels it after the last subscriber leaves', async () => {
  vi.useFakeTimers()
  try {
    const load = vi.fn(async () => 'current')
    const resource = createAsyncResource('poll', load, {
      refreshIntervalMs: 1000,
    })
    expect(vi.getTimerCount()).toBe(0)
    const stopFirst = resource.subscribe(vi.fn())
    const stopSecond = resource.subscribe(vi.fn())
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(2)
    stopFirst()
    expect(vi.getTimerCount()).toBe(1)
    stopSecond()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(2)
    const stopAgain = resource.subscribe(vi.fn())
    expect(resource.getSnapshot().data).toBe('current')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(3)
    stopAgain()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('polls after settlement without overlapping reads and resets the delay on explicit refresh', async () => {
  vi.useFakeTimers()
  try {
    const first = held<string>()
    const second = held<string>()
    const load = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue('current')
    const resource = createAsyncResource<string>('poll', load, {
      refreshIntervalMs: 3000,
      refreshIntervalMode: 'after-settle',
    })
    const stop = resource.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    first.resolve('first')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2999)
    expect(load).toHaveBeenCalledTimes(1)
    const refresh = resource.reload()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(2)
    second.reject(new Error('offline'))
    await refresh
    expect(resource.getSnapshot().data).toBe('first')
    expect(resource.getSnapshot().status).toBe('error')
    await vi.advanceTimersByTimeAsync(2999)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(3)
    expect(resource.getSnapshot().data).toBe('current')
    expect(vi.getTimerCount()).toBe(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

test('revalidates a changed external version while retaining the matching cache', async () => {
  const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
  const resource = createAsyncResource<string>('versioned', load)
  const stop = resource.subscribe(vi.fn(), 1)
  await Promise.resolve()
  stop()
  const sameVersion = resource.subscribe(vi.fn(), 1)
  expect(resource.getSnapshot().data).toBe('first')
  expect(load).toHaveBeenCalledTimes(1)
  const differentVersion = resource.subscribe(vi.fn(), 2)
  expect(resource.getSnapshot()).toMatchObject({
    status: 'loading',
    data: 'first',
  })
  await Promise.resolve()
  expect(load).toHaveBeenCalledTimes(2)
  expect(resource.getSnapshot().data).toBe('second')
  differentVersion()
  sameVersion()
  const currentVersion = resource.subscribe(vi.fn(), 2)
  expect(load).toHaveBeenCalledTimes(2)
  currentVersion()
})

test('a local receipt restarts after-settle polling when it supersedes an unfinished read', async () => {
  vi.useFakeTimers()
  try {
    const stale = held<string>()
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue('fresh')
    const resource = createAsyncResource<string>('poll', load, {
      refreshIntervalMs: 2000,
      refreshIntervalMode: 'after-settle',
    })
    const stop = resource.subscribe(vi.fn())
    resource.update(() => 'saved')
    stale.resolve('stale')
    await vi.advanceTimersByTimeAsync(1999)
    expect(resource.getSnapshot().data).toBe('saved')
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
    expect(resource.getSnapshot().data).toBe('fresh')
    stop()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('a subscriber refresh triggered by a local receipt still waits for its request to settle', async () => {
  vi.useFakeTimers()
  try {
    const pending = held<string>()
    const load = vi.fn().mockReturnValue(pending.promise)
    const resource = createAsyncResource<string>('poll', load, {
      refreshIntervalMs: 2000,
      refreshIntervalMode: 'after-settle',
    })
    const stop = resource.subscribe(() => {
      if (resource.getSnapshot().status === 'ready' && resource.getSnapshot().data === 'saved') {
        void resource.reload()
      }
    })
    resource.update(() => 'saved')
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(2)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
