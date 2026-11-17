import { createContext, runInContext } from 'node:vm'
import { afterEach, expect, test, vi } from 'vitest'
import { createE2ENativeTextCommit } from './e2e-native-text-commit.js'

afterEach(() => vi.useRealTimers())

function renderer(shadow = false) {
  const target = { isConnected: true }
  let listener: ((event: unknown) => void) | undefined
  const removeEventListener = vi.fn(() => {
    listener = undefined
  })
  const context = createContext({
    document: { activeElement: shadow ? { shadowRoot: { activeElement: target } } : target },
    queueMicrotask,
    window: {
      addEventListener: (_type: string, callback: typeof listener) => {
        listener = callback
      },
      removeEventListener,
      setTimeout,
      clearTimeout,
    },
  })
  const contents = {
    focusedFrame: { executeJavaScript: async (script: string) => runInContext(script, context) },
  }
  const emit = (event: Record<string, unknown> = {}) =>
    listener?.({
      isTrusted: true,
      key: 'Enter',
      composedPath: () => [target],
      ...event,
    })
  return { contents, emit, target, context, removeEventListener }
}

test('acknowledges only the target editor trusted Enter and removes the listener', async () => {
  const view = renderer()
  const commit = await createE2ENativeTextCommit(view.contents, 'batch')
  const settled = vi.fn()
  const pending = commit.wait(1).then(settled)
  view.emit({ isTrusted: false })
  view.emit({ key: 'Escape' })
  view.emit({ composedPath: () => [{}] })
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  view.emit()
  expect(settled).not.toHaveBeenCalled()
  await pending
  expect(settled).toHaveBeenCalledOnce()
  await commit.dispose()
  expect(view.removeEventListener).toHaveBeenCalledOnce()
  expect(view.context.__weworkNativeText_batch).toBeUndefined()
})

test('retains an acknowledgement that arrives before the host starts waiting', async () => {
  const view = renderer()
  const commit = await createE2ENativeTextCommit(view.contents, 'early')
  view.emit()
  await Promise.resolve()
  await commit.wait(1)
  view.emit()
  await Promise.resolve()
  await expect(commit.wait(1)).rejects.toThrow('Unexpected native Enter acknowledgement')
  await commit.dispose()
})

test('preserves the per-key deadline and reports a detached native target', async () => {
  vi.useFakeTimers()
  const view = renderer()
  const commit = await createE2ENativeTextCommit(view.contents, 'timeout')
  view.target.isConnected = false
  const pending = expect(commit.wait(1)).rejects.toThrow('delivered=0, expected=1, connected=false')
  await vi.advanceTimersByTimeAsync(10_000)
  await pending
  await commit.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

test('disposal rejects pending waits and clears their timers', async () => {
  vi.useFakeTimers()
  const view = renderer()
  const commit = await createE2ENativeTextCommit(view.contents, 'dispose')
  const pending = expect(commit.wait(1)).rejects.toThrow('Native text acknowledgement disposed')
  await commit.dispose()
  await pending
  expect(vi.getTimerCount()).toBe(0)
})

test('observes the actual focused editor inside a shadow root', async () => {
  const view = renderer(true)
  const commit = await createE2ENativeTextCommit(view.contents, 'shadow')
  view.emit()
  await Promise.resolve()
  await commit.wait(1)
  await commit.dispose()
})

test('rejects a missing focused frame before installing an acknowledgement', async () => {
  await expect(createE2ENativeTextCommit({ focusedFrame: null }, 'missing')).rejects.toThrow(
    'Native text frame is unavailable'
  )
})
