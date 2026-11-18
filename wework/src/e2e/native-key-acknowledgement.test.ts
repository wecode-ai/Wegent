import { afterEach, expect, test, vi } from 'vitest'
import { sendNativeKeyAndWait } from './native-key-acknowledgement'

function nativeEvent(target: HTMLElement, exposedTarget = target, isTrusted = true): KeyboardEvent {
  return {
    isTrusted,
    target: exposedTarget,
    composedPath: () => [target, exposedTarget, window],
  } as unknown as KeyboardEvent
}

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('acknowledges delivered native input without waiting for a renderer timer', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  const acknowledged = vi.fn()
  const result = sendNativeKeyAndWait(target, 'press', async () => {
    listener?.(nativeEvent(target))
  }).then(acknowledged)

  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  expect(acknowledged).toHaveBeenCalledOnce()
  await result
})

test('ignores synthetic events and native events for another target', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keyup') listener = callback as (event: KeyboardEvent) => void
  })
  const acknowledged = vi.fn()
  const result = sendNativeKeyAndWait(target, 'up', async () => {
    listener?.(nativeEvent(target, target, false))
    listener?.(nativeEvent(document.body))
  }).then(acknowledged)
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  expect(acknowledged).not.toHaveBeenCalled()
  listener?.(nativeEvent(target))
  await result
  expect(acknowledged).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('rejects missing native input at the existing step deadline and removes its listener', async () => {
  vi.useFakeTimers()
  const remove = vi.spyOn(window, 'removeEventListener')
  const target = document.createElement('textarea')
  const result = sendNativeKeyAndWait(target, 'down', async () => {})
  const rejected = expect(result).rejects.toThrow('Native keydown did not reach its target')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  expect(vi.getTimerCount()).toBe(0)
})

test('preserves a host failure even if the event was delivered', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  const remove = vi.spyOn(window, 'removeEventListener')
  await expect(
    sendNativeKeyAndWait(target, 'press', async () => {
      listener?.(nativeEvent(target))
      throw new Error('Native host rejected the action')
    })
  ).rejects.toThrow('Native host rejected the action')
  expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  expect(vi.getTimerCount()).toBe(0)
})

test('acknowledges native input retargeted through a shadow host', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  const target = document.createElement('textarea')
  host.attachShadow({ mode: 'open' }).append(target)
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  await sendNativeKeyAndWait(target, 'press', async () => {
    listener?.(nativeEvent(target, host))
  })
  expect(vi.getTimerCount()).toBe(0)
})

test('requires every native key in a batch and rejects a missing final event', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  const acknowledged = vi.fn()
  const result = sendNativeKeyAndWait(target, 'press', async () => {}, 2).then(acknowledged)
  listener?.(nativeEvent(target))
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  expect(acknowledged).not.toHaveBeenCalled()
  listener?.(nativeEvent(target))
  await result
  expect(acknowledged).toHaveBeenCalledOnce()

  const missing = sendNativeKeyAndWait(target, 'press', async () => {}, 2)
  const rejected = expect(missing).rejects.toThrow('Native keydown did not reach its target')
  listener?.(nativeEvent(target))
  await vi.advanceTimersByTimeAsync(6000)
  listener?.(nativeEvent(document.body))
  listener?.(nativeEvent(target, target, false))
  await vi.advanceTimersByTimeAsync(4000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

test('keeps the original per-key deadline while a native batch makes progress', async () => {
  vi.useFakeTimers()
  const target = document.createElement('textarea')
  let listener: ((event: KeyboardEvent) => void) | undefined
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
    if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
  })
  const result = sendNativeKeyAndWait(target, 'press', async () => {}, 2)
  const outcome = result.then(
    () => 'delivered',
    error => error.message
  )
  await vi.advanceTimersByTimeAsync(6000)
  listener?.(nativeEvent(target))
  await vi.advanceTimersByTimeAsync(6000)
  listener?.(nativeEvent(target))
  expect(await outcome).toBe('delivered')
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['native-first', 'host-first'])(
  'distinguishes host acknowledgement from trusted event delivery (%s)',
  async order => {
    vi.useFakeTimers()
    const target = document.createElement('textarea')
    let listener: ((event: KeyboardEvent) => void) | undefined
    vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => {
      if (type === 'keydown') listener = callback as (event: KeyboardEvent) => void
    })
    let sent!: () => void
    const sending = new Promise<void>(resolve => {
      sent = resolve
    })
    const observe = vi.fn()
    const completed = vi.fn()
    const result = sendNativeKeyAndWait(target, 'press', () => sending, 1, observe).then(completed)
    const firstStage = order === 'native-first' ? 'native-event' : 'host-acknowledged'
    if (order === 'native-first') listener?.(nativeEvent(target))
    else sent()
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    expect(observe.mock.calls).toEqual([[firstStage]])
    expect(completed).not.toHaveBeenCalled()
    if (order === 'native-first') sent()
    else listener?.(nativeEvent(target))
    await result
    expect(observe.mock.calls).toEqual([
      [firstStage],
      [order === 'native-first' ? 'host-acknowledged' : 'native-event'],
    ])
    expect(completed).toHaveBeenCalledOnce()
  }
)
