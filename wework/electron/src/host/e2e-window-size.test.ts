import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { setE2EWindowSize } from './e2e-window-size.js'

afterEach(() => vi.useRealTimers())

function windowFixture(maximized = false) {
  return Object.assign(new EventEmitter(), {
    getContentSize: vi.fn((): [number, number] => [1280, 720]),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => maximized),
    setContentSize: vi.fn(),
    unmaximize: vi.fn(),
  })
}

function expectClean(target: ReturnType<typeof windowFixture>) {
  for (const event of ['unmaximize', 'resize', 'closed']) {
    expect(target.listenerCount(event)).toBe(0)
  }
}

test('waits for native unmaximize before requesting a size and preserves the original size', async () => {
  const target = windowFixture(true)
  const finished = vi.fn()
  const pending = setE2EWindowSize(target, 640, 800).then(finished)
  expect(target.unmaximize).toHaveBeenCalledOnce()
  target.emit('resize')
  target.emit('unmaximize')
  await Promise.resolve()
  expect(target.setContentSize).not.toHaveBeenCalled()

  target.isMaximized.mockReturnValue(false)
  target.getContentSize.mockReturnValue([1272, 716])
  target.emit('unmaximize')
  await Promise.resolve()
  expect(target.setContentSize).toHaveBeenCalledExactlyOnceWith(640, 800)
  expect(finished).not.toHaveBeenCalled()

  target.getContentSize.mockReturnValue([640, 800])
  target.emit('resize')
  await pending
  expect(finished).toHaveBeenCalledExactlyOnceWith({ width: 1280, height: 720 })
  expectClean(target)
})

test('requires both requested content dimensions after an asynchronous normal-window resize', async () => {
  const target = windowFixture()
  const finished = vi.fn()
  const pending = setE2EWindowSize(target, 1280, 1200).then(finished)
  expect(target.unmaximize).not.toHaveBeenCalled()
  expect(target.setContentSize).toHaveBeenCalledExactlyOnceWith(1280, 1200)
  target.emit('resize')
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  target.getContentSize.mockReturnValue([1280, 1200])
  target.emit('resize')
  await pending
  expect(finished).toHaveBeenCalledOnce()
  expectClean(target)
})

test('supports synchronous native state changes without losing their events', async () => {
  const target = windowFixture(true)
  target.unmaximize.mockImplementation(() => {
    target.isMaximized.mockReturnValue(false)
    target.emit('unmaximize')
  })
  target.setContentSize.mockImplementation((width: number, height: number) => {
    target.getContentSize.mockReturnValue([width, height])
    target.emit('resize')
  })
  await expect(setE2EWindowSize(target, 640, 800)).resolves.toEqual({ width: 1280, height: 720 })
  expectClean(target)
})

test('does not accept matching geometry while the native window is maximized', async () => {
  const target = windowFixture()
  const finished = vi.fn()
  const pending = setE2EWindowSize(target, 640, 800).then(finished)
  target.isMaximized.mockReturnValue(true)
  target.getContentSize.mockReturnValue([640, 800])
  target.emit('resize')
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  target.isMaximized.mockReturnValue(false)
  target.emit('unmaximize')
  await pending
  expectClean(target)
})

test('rejects a refused native unmaximize without requesting the fixture size', async () => {
  vi.useFakeTimers()
  const target = windowFixture(true)
  const pending = setE2EWindowSize(target, 640, 800)
  const rejected = expect(pending).rejects.toThrow(
    'did not leave the maximized state; actual content=1280x720, maximized=true'
  )
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(target.setContentSize).not.toHaveBeenCalled()
  expectClean(target)
})

test('rejects an unapplied size with the requested and actual native geometry', async () => {
  vi.useFakeTimers()
  const target = windowFixture()
  const pending = setE2EWindowSize(target, 640, 800)
  const rejected = expect(pending).rejects.toThrow(
    'did not resize its content to 640x800; actual content=1280x720, maximized=false'
  )
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(target.setContentSize).toHaveBeenCalledOnce()
  expectClean(target)
})

test('rejects and cleans up when a native geometry read fails at the timeout boundary', async () => {
  vi.useFakeTimers()
  const target = windowFixture()
  const pending = setE2EWindowSize(target, 640, 800)
  target.getContentSize.mockImplementation(() => {
    throw new Error('Native geometry is unavailable')
  })
  const rejected = expect(pending).rejects.toThrow('Native geometry is unavailable')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expectClean(target)
})

test.each([false, true])(
  'rejects a window closing during native resize (maximized=%s)',
  async maximized => {
    const target = windowFixture(maximized)
    const pending = setE2EWindowSize(target, 640, 800)
    target.isDestroyed.mockReturnValue(true)
    target.emit('closed')
    await expect(pending).rejects.toThrow('closed while resizing')
    expectClean(target)
  }
)

test.each([false, true])(
  'cleans listeners after a synchronous native exception (maximized=%s)',
  async maximized => {
    const target = windowFixture(maximized)
    const operation = maximized ? target.unmaximize : target.setContentSize
    operation.mockImplementation(() => {
      throw new Error('Native resize failed')
    })
    await expect(setE2EWindowSize(target, 640, 800)).rejects.toThrow('Native resize failed')
    expectClean(target)
  }
)

test('rejects an already destroyed window before accessing native geometry', async () => {
  const target = windowFixture()
  target.isDestroyed.mockReturnValue(true)
  await expect(setE2EWindowSize(target, 640, 800)).rejects.toThrow('unavailable for resizing')
  expect(target.getContentSize).not.toHaveBeenCalled()
  expectClean(target)
})
